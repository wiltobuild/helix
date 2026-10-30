import { afterEach, expect, it, vi } from 'vitest';
import { fixtures, helixEventSchema, type HelixEvent } from '@helix/contracts';
import { createSseParser, subscribeEvents, type SseFrame, type EventStreamStatus } from './sse.js';

afterEach(() => vi.useRealTimers());
it('parses multiline data, comments, unknown fields, BOM and partial CRLF chunks', () => {
  const frames: SseFrame[] = [];
  const parser = createSseParser((frame) => frames.push(frame));
  for (const chunk of [
    '\uFEFF: heartbeat\r',
    '\n\r',
    '\nid: 12\r\neve',
    'nt: helix\r\ndata: first\r',
    '\ndata:  second\r\nretry: 250\r\n\r',
    '\nid: 13\nevent: helix\ndata: third\n\n',
  ])
    parser.push(chunk);
  expect(frames).toEqual([
    { id: '12', event: 'helix', data: 'first\n second' },
    { id: '13', event: 'helix', data: 'third' },
  ]);
});
it('supports CR-only lines, empty data, persistent IDs, NUL rejection and discards unfinished frames', () => {
  const frames: SseFrame[] = [];
  const parser = createSseParser((frame) => frames.push(frame));
  parser.push('id: 1\rdata\r\rid: bad\0id\rdata: next\r\rdata: incomplete');
  expect(frames).toEqual([
    { id: '1', event: 'message', data: '' },
    { id: '1', event: 'message', data: 'next' },
  ]);
});
it('every possible two-chunk split has the same framing', () => {
  const source = ': heartbeat\r\nid: 7\r\nevent: helix\r\ndata: {"text":"日本語"}\r\n\r\n';
  for (let index = 0; index <= source.length; index++) {
    const frames: SseFrame[] = [];
    const parser = createSseParser((frame) => frames.push(frame));
    parser.push(source.slice(0, index));
    parser.push(source.slice(index));
    expect(frames).toEqual([{ id: '7', event: 'helix', data: '{"text":"日本語"}' }]);
  }
});

const event = fixtures.passwordResetRun[0];
if (!event) throw new Error('No fixture');
function frame(seq: number, changes: Record<string, unknown> = {}) {
  return `id: ${seq}\nevent: helix\ndata: ${JSON.stringify({ ...event, seq, ...changes })}\n\n`;
}
function requestUrl(input: Parameters<typeof fetch>[0] | undefined): URL {
  if (input === undefined) throw new Error('Missing fetch request');
  return new URL(input instanceof Request ? input.url : input);
}
function stream(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
it('resumes with headers, ignores exact replay duplicates, and close cancels reconnect', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(stream(frame(1) + frame(1) + frame(2)))
    .mockResolvedValueOnce(stream(frame(2) + frame(4)));
  const values: number[] = [];
  const statuses: EventStreamStatus[] = [];
  const subscription = subscribeEvents({
    baseUrl: 'http://localhost:4317',
    fetch: fetcher,
    onEvent: (e) => values.push(e.seq),
    onStatus: (s) => statuses.push(s),
  });
  await vi.advanceTimersByTimeAsync(350);
  expect(values).toEqual([1, 2, 4]);
  expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ 'Last-Event-ID': '2' });
  subscription.close();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(statuses.at(-1)).toBe('closed');
});

it('delivers 10 then unseen 9, suppresses exact 9 retries, retains conflicts, and resumes at 10', async () => {
  vi.useFakeTimers();
  const changedTs = '2026-10-01T10:00:00.000Z';
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(stream(frame(10) + frame(9) + frame(9) + frame(9, { ts: changedTs })))
    .mockResolvedValueOnce(stream(frame(9) + frame(9, { ts: changedTs }) + frame(12)));
  const received: HelixEvent[] = [];
  const subscription = subscribeEvents({
    baseUrl: 'http://localhost:4317',
    fetch: fetcher,
    projectId: event.projectId,
    onEvent: (value) => received.push(value),
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(received.map((value) => value.seq)).toEqual([10, 9, 9]);
    expect(received.map((value) => value.ts)).toEqual([event.ts, event.ts, changedTs]);
    await vi.advanceTimersByTimeAsync(350);
    expect(received.map((value) => value.seq)).toEqual([10, 9, 9, 12]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetcher.mock.calls[1]?.[0]).searchParams.get('since')).toBe('10');
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ 'Last-Event-ID': '10' });
  } finally {
    subscription.close();
  }
});

it('preserves a multi-megabyte chunked design event through late backfill, exact retries and monotonic reconnects', async () => {
  vi.useFakeTimers();
  const sessionId = fixtures.passwordResetRun.find((value) => value.sessionId)?.sessionId;
  const large = helixEventSchema.parse({
    ...event,
    seq: 10,
    sessionId,
    type: 'design.updated',
    payload: {
      design: {
        sessionId,
        revision: 1,
        brief: 'Three embedded raster concepts',
        status: 'ready',
        rounds: [
          {
            revision: 1,
            jobId: 'large-design',
            concepts: ['A', 'B', 'C'].map((letter) => ({
              id: letter,
              title: `Concept ${letter}`,
              imageUrl: `data:image/png;base64,${letter.repeat(1024 * 1024)}`,
              mimeType: 'image/png',
              prompt: 'A storefront',
              rationale: 'Transport payload fixture',
              tradeoffs: [],
              recommended: letter === 'A',
            })),
          },
        ],
        conversation: [],
        references: [],
        receipts: [],
      },
    },
  });
  const largeFrame = frame(10, large);
  // Pull bounded slices of one buffer, rather than allocating a Uint8Array per byte.
  const chunked = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(bytes.length, offset + 64 * 1024);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  expect(new TextEncoder().encode(largeFrame).length).toBeGreaterThan(3 * 1024 * 1024);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(chunked(largeFrame + frame(9) + frame(9)))
    .mockResolvedValueOnce(chunked(largeFrame + frame(9) + frame(12) + frame(11)))
    .mockResolvedValueOnce(chunked(frame(13)));
  const received: HelixEvent[] = [];
  const subscription = subscribeEvents({
    baseUrl: 'http://localhost:4317',
    since: 8,
    projectId: event.projectId,
    fetch: fetcher,
    onEvent: (value) => received.push(value),
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(received.map((value) => value.seq)).toEqual([10, 9]);
    expect(received[0]).toEqual(large);
    await vi.advanceTimersByTimeAsync(350);
    expect(received.map((value) => value.seq)).toEqual([10, 9, 12, 11]);
    await vi.advanceTimersByTimeAsync(350);
    expect(received.map((value) => value.seq)).toEqual([10, 9, 12, 11, 13]);
    expect(received[0]).toEqual(large);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls.map(([input]) => requestUrl(input).searchParams.get('since')),
    ).toEqual(['8', '10', '12']);
    for (const [index, cursor] of ['8', '10', '12'].entries()) {
      expect(fetcher.mock.calls[index]?.[1]?.headers).toMatchObject({ 'Last-Event-ID': cursor });
    }
  } finally {
    subscription.close();
  }
});

it('honors the initial since boundary without treating legitimate project sequence gaps as missing data', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      stream(
        frame(9) + frame(8) + frame(9, { ts: '2026-10-01T10:00:00.000Z' }) + frame(20) + frame(10),
      ),
    );
  const received: number[] = [];
  const subscription = subscribeEvents({
    baseUrl: 'http://localhost:4317',
    since: 9,
    fetch: fetcher,
    projectId: event.projectId,
    onEvent: (value) => received.push(value.seq),
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([20, 10]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetcher.mock.calls[0]?.[0]).searchParams.get('since')).toBe('9');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Last-Event-ID': '9' });
  } finally {
    subscription.close();
  }
});

it('rejects wrong-project late frames without advancing the resume high-water mark', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(stream(frame(10) + frame(9, { projectId: 'wrong-project' }) + frame(11)))
    .mockResolvedValueOnce(stream(frame(10) + frame(11)));
  const received: HelixEvent[] = [];
  const subscription = subscribeEvents({
    baseUrl: 'http://localhost:4317',
    fetch: fetcher,
    projectId: event.projectId,
    onEvent: (value) => received.push(value),
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(received.map((value) => value.seq)).toEqual([10]);
    await vi.advanceTimersByTimeAsync(350);
    expect(received.map((value) => value.seq)).toEqual([10, 11]);
    expect(received.every((value) => value.projectId === event.projectId)).toBe(true);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ 'Last-Event-ID': '10' });
  } finally {
    subscription.close();
  }
});

it('close inside onEvent aborts the stream and prevents callbacks for remaining frames', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream(frame(10) + frame(9)));
  const received: number[] = [];
  const statuses: EventStreamStatus[] = [];
  const subscription = subscribeEvents({
    baseUrl: 'http://localhost:4317',
    fetch: fetcher,
    onEvent: (value) => {
      received.push(value.seq);
      subscription.close();
    },
    onStatus: (value) => statuses.push(value),
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(received).toEqual([10]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(statuses).toEqual(['connecting', 'live', 'closed']);
});

it('a pending read that completes after close cannot deliver events or restart retries', async () => {
  vi.useFakeTimers();
  let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        sink = controller;
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
  const onEvent = vi.fn();
  const statuses: EventStreamStatus[] = [];
  const subscription = subscribeEvents({
    baseUrl: 'http://localhost:4317',
    fetch: fetcher,
    onEvent,
    onStatus: (value) => statuses.push(value),
  });
  await vi.advanceTimersByTimeAsync(0);
  subscription.close();
  sink!.enqueue(new TextEncoder().encode(frame(10) + frame(9)));
  sink!.close();
  await vi.advanceTimersByTimeAsync(30000);
  expect(onEvent).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(statuses).toEqual(['connecting', 'live', 'closed']);
});
it('uses bounded exponential backoff for unsuccessful connections', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Offline'));
  const subscription = subscribeEvents({
    baseUrl: 'http://localhost:4317',
    fetch: fetcher,
    onEvent: () => undefined,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (const [index, delay] of [250, 500, 1000, 2000, 4000, 8000, 10000, 10000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(fetcher).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(index + 2);
  }
  subscription.close();
  vi.restoreAllMocks();
});
it('does not advance past an invalid frame and can close immediately', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(stream(frame(1) + 'id: 2\nevent: helix\ndata: {}\n\n'))
    .mockResolvedValueOnce(stream(frame(2)));
  const values: number[] = [];
  const subscription = subscribeEvents({
    baseUrl: 'http://localhost:4317',
    fetch: fetcher,
    onEvent: (e) => values.push(e.seq),
  });
  await vi.advanceTimersByTimeAsync(350);
  expect(values).toEqual([1, 2]);
  expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ 'Last-Event-ID': '1' });
  subscription.close();
  const statuses: EventStreamStatus[] = [];
  subscribeEvents({
    baseUrl: 'http://localhost:4317',
    fetch: fetcher,
    onEvent: () => undefined,
    onStatus: (status) => statuses.push(status),
  }).close();
  await vi.advanceTimersByTimeAsync(0);
  expect(statuses).toEqual(['closed']);
});
