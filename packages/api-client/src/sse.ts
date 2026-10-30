import { routes, sse, sseMessageSchema, type HelixEvent, type ProjectId } from '@helix/contracts';

export type SseFrame = { id: string; event: string; data: string };

/** Incremental SSE framing, including CR, LF, split CRLF and multi-line data. */
export function createSseParser(onFrame: (frame: SseFrame) => void) {
  let line = '';
  let skipLf = false;
  let first = true;
  let id = '';
  let event = '';
  let data: string[] = [];
  const finishLine = () => {
    if (line === '') {
      if (data.length) onFrame({ id, event: event || 'message', data: data.join('\n') });
      event = '';
      data = [];
    } else if (!line.startsWith(':')) {
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      if (field === 'event') event = value;
      if (field === 'id' && !value.includes('\0')) id = value;
    }
    line = '';
  };
  return {
    push(chunk: string) {
      for (const char of chunk) {
        if (first) {
          first = false;
          if (char === '\uFEFF') continue;
        }
        if (skipLf) {
          skipLf = false;
          if (char === '\n') continue;
        }
        if (char === '\r' || char === '\n') {
          finishLine();
          skipLf = char === '\r';
        } else {
          line += char;
        }
      }
    },
    // Incomplete frames at EOF are deliberately discarded; reconnect replays them.
  };
}

export type EventStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';
export type EventSubscription = { close(): void };
export type SubscribeEventsOptions = {
  baseUrl: string;
  since?: number;
  projectId?: ProjectId;
  fetch?: typeof globalThis.fetch;
  onEvent(event: HelixEvent): void;
  onStatus?(status: EventStreamStatus): void;
};

export function subscribeEvents(options: SubscribeEventsOptions): EventSubscription {
  const fetcher = options.fetch ?? globalThis.fetch;
  const initialSince = options.since ?? sse.defaultSince;
  let cursor = initialSince;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError('Invalid event cursor');
  // The resume watermark is not a delivery filter: project-filtered streams may have gaps,
  // and late frames may arrive below the high-water mark. Keep every distinct validated
  // event above the caller's initial boundary, including conflicting same-seq evidence.
  // Schema parsing normalizes envelope/payload key order before this fingerprint is made.
  const delivered = new Set<string>();
  let closed = false;
  let controller: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let status: EventStreamStatus | undefined;
  const report = (next: EventStreamStatus) => {
    if (status !== next) {
      status = next;
      options.onStatus?.(next);
    }
  };
  const run = async () => {
    let delay = 250;
    if (closed) return;
    report('connecting');
    while (!closed) {
      controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const url = new URL(`${options.baseUrl.replace(/\/$/, '')}${routes.events.path}`);
        url.searchParams.set('since', String(cursor));
        if (options.projectId) url.searchParams.set('projectId', options.projectId);
        const response = await fetcher(url, {
          headers: { Accept: sse.contentType, [sse.resumeHeader]: String(cursor) },
          signal: controller.signal,
        });
        if (closed) break;
        if (
          !response.ok ||
          !response.body ||
          !response.headers.get('content-type')?.startsWith(sse.contentType)
        ) {
          throw new Error('Invalid event stream response');
        }
        reader = response.body.getReader();
        report('live');
        const decoder = new TextDecoder();
        const parser = createSseParser((frame) => {
          if (closed || frame.event !== sse.event) return;
          const message = sseMessageSchema.parse({
            ...frame,
            data: JSON.parse(frame.data) as unknown,
          });
          if (options.projectId && message.data.projectId !== options.projectId) {
            throw new Error('Unexpected project in event stream');
          }
          if (message.data.seq <= initialSince) return;
          const fingerprint = JSON.stringify(message.data);
          if (delivered.has(fingerprint)) return;
          options.onEvent(message.data);
          delivered.add(fingerprint);
          cursor = Math.max(cursor, message.data.seq);
          delay = 250;
        });
        while (!closed) {
          const chunk = await reader.read();
          if (chunk.done) break;
          parser.push(decoder.decode(chunk.value, { stream: true }));
        }
      } catch {
        // Transport errors and incomplete/invalid frames resume from the delivery high-water mark.
      } finally {
        controller.abort();
        if (reader) {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      if (closed) break;
      report('reconnecting');
      if (closed) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        retryTimer = setTimeout(resolve, Math.min(10_000, delay * (1 + Math.random() * 0.2)));
      });
      wake = undefined;
      delay = Math.min(10_000, delay * 2);
    }
  };
  // Start after returning the handle, so callbacks can safely call close().
  void Promise.resolve().then(run);
  return {
    close() {
      if (closed) return;
      closed = true;
      controller?.abort();
      clearTimeout(retryTimer);
      wake?.();
      report('closed');
    },
  };
}
