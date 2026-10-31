import { object, summarize, validEvidencePayload } from './journey.js';
import { ReadError } from './errors.js';
import { intakeSnapshot, designSnapshot } from './snapshots.js';
import type { Event, Failure, GetTransport, Provenance, Result, Scope, Tool } from './types.js';
export type * from './types.js';
export { createLoopbackTransport } from './transport.js';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const tools = new Set<Tool>(['connectionstatus', 'getjourney', 'getevents', 'getdiff']);
const safeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export type AdapterOptions = {
  instance: string;
  allow: readonly Scope[];
  transport: GetTransport;
  maxBytes?: number;
  maxEvents?: number;
  timeoutMs?: number;
  staleAfterMs?: number;
  now?: () => number;
  /** Receives fixed codes only, never request IDs, paths, payloads or error messages. */
  log?: (code: Failure | 'read_ok') => void;
};

export function createDotAdapter(options: AdapterOptions) {
  if (!idPattern.test(options.instance) || !options.allow.length || options.allow.length > 100)
    throw new Error('invalid_configuration');
  const allowed = new Set(
    options.allow.map((s) => {
      if (!idPattern.test(s.projectId) || !idPattern.test(s.sessionId))
        throw new Error('invalid_configuration');
      return `${s.projectId}:${s.sessionId}`;
    }),
  );
  const bound = (value: number | undefined, fallback: number, max: number) => {
    const n = value ?? fallback;
    if (!Number.isSafeInteger(n) || n <= 0 || n > max) throw new Error('invalid_configuration');
    return n;
  };
  const maxBytes = bound(options.maxBytes, 262144, 1048576);
  const maxEvents = bound(options.maxEvents, 1000, 1000);
  const timeoutMs = bound(options.timeoutMs, 3000, 10000);
  const staleAfterMs = bound(options.staleAfterMs, 60000, 3600000);
  const now = options.now ?? Date.now;
  const cursors = new Map<string, number>();
  const busy = new Set<string>();
  const log = (code: Failure | 'read_ok') => {
    try {
      options.log?.(code);
    } catch {
      /* Logging cannot affect reads. */
    }
  };

  async function read(
    path: string,
    budget: { bytes: number; deadline: number },
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw new ReadError('cancelled');
    if (budget.bytes <= 0) throw new ReadError('oversize');
    if (Date.now() >= budget.deadline) throw new ReadError('timeout');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      const stop = new Promise<never>((_, reject) => {
        cancel = () => {
          reject(new ReadError('cancelled'));
          controller.abort();
        };
        signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(
          () => {
            reject(new ReadError('timeout'));
            controller.abort();
          },
          Math.max(1, budget.deadline - Date.now()),
        );
      });
      const text = await Promise.race([
        options.transport({
          method: 'GET',
          path,
          signal: controller.signal,
          maxBytes: budget.bytes,
        }),
        stop,
      ]);
      budget.bytes -= new TextEncoder().encode(text).byteLength;
      if (budget.bytes < 0) throw new ReadError('oversize');
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ReadError('invalid_response');
      }
    } finally {
      clearTimeout(timer);
      if (cancel) signal?.removeEventListener('abort', cancel);
    }
  }

  async function invoke(tool: string, input: unknown, signal?: AbortSignal): Promise<Result> {
    const budget = { bytes: maxBytes, deadline: Date.now() + timeoutMs };
    const args = object(input);
    const projectId =
      typeof args.projectId === 'string' && idPattern.test(args.projectId) ? args.projectId : '';
    const sessionId =
      typeof args.sessionId === 'string' && idPattern.test(args.sessionId) ? args.sessionId : '';
    const key = `${projectId}:${sessionId}`;
    const provenance: Provenance = {
      instance: options.instance,
      instanceVerified: false,
      projectId: '',
      sessionId: '',
      revision: null,
      cursor: 0,
      timestamp: new Date(now()).toISOString(),
      sourceTimestamp: null,
      stale: true,
      partial: true,
      untrustedContent: true,
    };
    let locked = false;
    try {
      if (
        !tools.has(tool as Tool) ||
        !allowed.has(key) ||
        Object.keys(args).some(
          (k) =>
            !['projectId', 'sessionId', ...(tool === 'getevents' ? ['cursor'] : [])].includes(k),
        )
      ) {
        throw new ReadError('invalid_request');
      }
      provenance.projectId = projectId;
      provenance.sessionId = sessionId;
      if (busy.has(key)) throw new ReadError('invalid_request');
      busy.add(key);
      locked = true;
      let data: unknown;
      if (tool === 'connectionstatus') {
        const health = object(await read('/api/health', budget, signal));
        if (health.status !== 'ok' || typeof health.version !== 'string' || !health.version.length)
          throw new ReadError('invalid_response');
        data = {
          connected: true,
          scopeVerified: false,
          note: 'Health only; configured instance identity and session existence are not attested.',
        };
        provenance.stale = false;
      } else if (tool === 'getdiff') {
        const diff = object(
          await read(`/api/sessions/${sessionId}/diff?scope=workspace`, budget, signal),
        );
        if (typeof diff.unifiedDiff !== 'string' || !Array.isArray(diff.files))
          throw new ReadError('invalid_response');
        // Deliberately return no arbitrary paths or diff text to the model in this prototype.
        data = {
          filesChanged: diff.files.length,
          content: 'withheld',
          verification: 'generated, not verified or accepted',
        };
        provenance.stale = false;
        // The diff endpoint supplies no project, revision, or source timestamp: keep partial=true.
      } else {
        const previous = tool === 'getevents' ? (cursors.get(key) ?? 0) : 0;
        if (args.cursor !== undefined && (!safeInt(args.cursor) || args.cursor < previous))
          throw new ReadError('invalid_request');
        const since = tool === 'getevents' ? (args.cursor ?? previous) : 0;
        let cursor = since;
        let total = 0;
        let complete = false;
        const unique = new Map<number, Event>();
        do {
          const limit = Math.min(100, maxEvents - total);
          const page = object(
            await read(
              `/api/projects/${projectId}/events?since=${cursor}&limit=${limit}`,
              budget,
              signal,
            ),
          );
          if (
            !Array.isArray(page.events) ||
            page.events.length > limit ||
            !safeInt(page.lastSeq) ||
            page.lastSeq < cursor
          )
            throw new ReadError('invalid_response');
          let last = 0;
          for (const raw of page.events as unknown[]) {
            const e = object(raw);
            if (
              !safeInt(e.seq) ||
              e.seq === 0 ||
              e.seq < last ||
              e.seq > page.lastSeq ||
              e.projectId !== projectId ||
              (e.sessionId !== undefined &&
                (typeof e.sessionId !== 'string' || !idPattern.test(e.sessionId))) ||
              typeof e.type !== 'string' ||
              !/^[a-z][a-z_.]{0,80}$/.test(e.type) ||
              e.v !== 1 ||
              typeof e.ts !== 'string' ||
              !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(e.ts) ||
              !Number.isFinite(Date.parse(e.ts)) ||
              e.payload === null ||
              typeof e.payload !== 'object' ||
              Array.isArray(e.payload)
            )
              throw new ReadError('invalid_response');
            last = e.seq;
            const event = e as unknown as Event;
            if (total > 0 && event.seq <= cursor && !unique.has(event.seq))
              throw new ReadError('invalid_response');
            if (event.sessionId === sessionId && !validEvidencePayload(event))
              throw new ReadError('invalid_response');
            if (
              unique.has(event.seq) &&
              JSON.stringify(unique.get(event.seq)) !== JSON.stringify(event)
            )
              throw new ReadError('invalid_response');
            unique.set(event.seq, event);
          }
          if (page.events.length && last !== page.lastSeq) throw new ReadError('invalid_response');
          if (!page.events.length && page.lastSeq !== cursor)
            throw new ReadError('invalid_response');
          total += page.events.length;
          complete = page.events.length < limit;
          const progressed = page.lastSeq > cursor;
          cursor = page.lastSeq;
          if (complete || !progressed || tool === 'getevents') break;
        } while (total < maxEvents);
        const selected = [...unique.values()].filter(
          (e) => e.seq > since && e.sessionId === sessionId,
        );
        provenance.cursor = cursor;
        provenance.partial = !complete || since !== 0 || selected.length === 0;
        provenance.sourceTimestamp = selected.at(-1)?.ts ?? null;
        provenance.stale =
          provenance.sourceTimestamp === null ||
          now() - Date.parse(provenance.sourceTimestamp) > staleAfterMs ||
          Date.parse(provenance.sourceTimestamp) > now() + 5000;
        const summary = summarize(selected, provenance.partial);
        if (tool === 'getjourney') {
          const discovery = intakeSnapshot(
            await read(`/api/projects/${projectId}/intake`, budget, signal),
            { projectId, sessionId },
          );
          const design = designSnapshot(
            await read(`/api/sessions/${sessionId}/design`, budget, signal),
            { projectId, sessionId },
          );
          if (design.state !== 'absent') {
            summary.decisionNeeded = summary.decisionNeeded.filter(
              (item) => item !== 'Inspect design decision in Helix; adapter cannot approve',
            );
            if ('decisionNeeded' in design && design.decisionNeeded)
              summary.decisionNeeded.push(
                'Inspect design decision in Helix; adapter cannot approve',
              );
          }
          if ('decisionNeeded' in discovery && discovery.decisionNeeded)
            summary.decisionNeeded.push('Inspect discovery brief in Helix; adapter cannot approve');
          data = { ...summary, current: { discovery, design } };
        } else {
          data = {
            events: selected.map(({ seq, ts, type }) => ({
              seq,
              ts,
              type,
              content: 'withheld',
            })),
            summary,
          };
        }
        if (tool === 'getevents') cursors.set(key, cursor);
      }
      log('read_ok');
      return { ok: true, data, provenance };
    } catch (error) {
      const code = error instanceof ReadError ? error.code : 'disconnected';
      log(code);
      return { ok: false, error: code, provenance: { ...provenance, stale: true, partial: true } };
    } finally {
      if (locked) busy.delete(key);
    }
  }
  return Object.freeze({ invoke });
}
