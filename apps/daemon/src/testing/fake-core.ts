import type { SetupCore } from '../setup.js';
import { setupResponse } from './setup-fixture.js';
import { vi } from 'vitest';
import {
  fixtures,
  helixEventSchema,
  isEventOf,
  type EventStore,
  type HelixCore,
  type HelixEvent,
  type TerminalHost,
  type TerminalOutput,
  type SessionId,
} from '@helix/contracts';

export const project = fixtures.passwordResetProject;
export const plan = fixtures.passwordResetPlan;
const created = fixtures.passwordResetRun.find(isEventOf('session.created'));
const requested = fixtures.passwordResetRun.find(isEventOf('approval.requested'));
const note = fixtures.passwordResetRun.find(isEventOf('explain.note'));
const verdict = fixtures.crossReviewRun.find(isEventOf('agent_review.submitted'))!;
if (!created || !requested || !note) throw new Error('Missing test fixtures');
export const session = created.payload.session;
export const approval = requested.payload.approval;
export const explanation = note;

/**
 * Ports blocked by the Fetch standard (undici) that cause `TypeError: fetch failed (bad port)`.
 * See https://fetch.spec.whatwg.org/#bad-port
 */
export const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 991,
  992, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);

/**
 * Listens on an ephemeral port, retrying if the OS allocates a port blocked by the Fetch spec.
 */
export async function listenFetchSafe(app: {
  listen(opts: { host: string; port: number }): Promise<string>;
  close(): Promise<unknown>;
  server: { address(): unknown };
}): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as { port: number } | null;
    if (address && FETCH_BLOCKED_PORTS.has(address.port)) {
      await app.close();
      continue;
    }
    return url;
  }
  return app.listen({ host: '127.0.0.1', port: 0 });
}

export class MemoryEvents implements EventStore {
  readonly log: HelixEvent[] = [];
  readonly subscribers = new Set<(event: HelixEvent) => void>();
  readonly cursors: number[] = [];
  append: EventStore['append'] = (events) => {
    const appended = events.map((event, index) =>
      helixEventSchema.parse({ ...event, seq: this.log.length + index + 1 }),
    );
    this.log.push(...appended);
    for (const event of appended) for (const subscriber of this.subscribers) subscriber(event);
    return Promise.resolve(appended);
  };
  read: EventStore['read'] = (projectId, since, limit) =>
    Promise.resolve(
      this.log
        .filter((event) => event.projectId === projectId && event.seq > since)
        .slice(0, limit),
    );
  subscribe: EventStore['subscribe'] = (since, callback) => {
    this.cursors.push(since);
    this.subscribers.add(callback);
    for (const event of this.log) if (event.seq > since) callback(event);
    return () => {
      this.subscribers.delete(callback);
    };
  };
}

export function createFakeCore() {
  const events = new MemoryEvents();
  const outputs = new Set<(output: TerminalOutput) => void>();
  const exits = new Set<(sessionId: SessionId, code: number | null) => void>();
  const attachment = {
    write: vi.fn<(data: string) => void>(),
    resize: vi.fn<(cols: number, rows: number) => void>(),
    detach: vi.fn<() => void>(),
  };
  const terminals = {
    spawn: vi.fn<TerminalHost['spawn']>().mockResolvedValue(undefined),
    attach: vi.fn<TerminalHost['attach']>().mockImplementation((_id, callback) => {
      outputs.add(callback);
      callback({ t: 'out', data: 'scrollback\r\n' });
      return Promise.resolve({
        ...attachment,
        detach: () => {
          outputs.delete(callback);
          attachment.detach();
        },
      });
    }),
    kill: vi.fn<TerminalHost['kill']>().mockResolvedValue(undefined),
    onExit: (cb: (sessionId: SessionId, code: number | null) => void) => {
      exits.add(cb);
      return () => {
        exits.delete(cb);
      };
    },
    list: () => [session.id],
  } satisfies TerminalHost;
  const core = {
    sessionDesign: vi
      .fn<NonNullable<HelixCore['sessionDesign']>>()
      .mockResolvedValue({ design: null }),
    changeDesign: vi
      .fn<NonNullable<HelixCore['changeDesign']>>()
      .mockResolvedValue({ design: null }),
    setup: vi.fn<NonNullable<SetupCore['setup']>>().mockResolvedValue(setupResponse),
    events,
    terminals,
    start: vi.fn<HelixCore['start']>().mockResolvedValue(undefined),
    shutdown: vi.fn<HelixCore['shutdown']>().mockResolvedValue(undefined),
    projectIntake: vi
      .fn<NonNullable<HelixCore['projectIntake']>>()
      .mockResolvedValue({ draft: null }),
    changeIntake: vi
      .fn<NonNullable<HelixCore['changeIntake']>>()
      .mockResolvedValue({ draft: null }),
    discoveryIntake: vi
      .fn<NonNullable<HelixCore['discoveryIntake']>>()
      .mockResolvedValue({ draft: null }),
    changeDiscovery: vi
      .fn<NonNullable<HelixCore['changeDiscovery']>>()
      .mockResolvedValue({ draft: null }),
    health: vi.fn<HelixCore['health']>().mockResolvedValue({ status: 'ok', version: 'test' }),
    harnesses: vi
      .fn<HelixCore['harnesses']>()
      .mockResolvedValue([{ agent: 'codex', installed: true }]),
    listProjects: vi.fn<HelixCore['listProjects']>().mockResolvedValue([project]),
    addProject: vi.fn<HelixCore['addProject']>().mockResolvedValue(project),
    projectEvents: vi
      .fn<HelixCore['projectEvents']>()
      .mockResolvedValue({ events: [], lastSeq: 0 }),
    createSession: vi.fn<HelixCore['createSession']>().mockResolvedValue(session),
    sendMessage: vi.fn<HelixCore['sendMessage']>().mockResolvedValue(undefined),
    stopSession: vi.fn<HelixCore['stopSession']>().mockResolvedValue(undefined),
    stopAll: vi.fn<HelixCore['stopAll']>().mockResolvedValue({ stopped: [session.id] }),
    archiveSession: vi.fn<HelixCore['archiveSession']>().mockResolvedValue(session),
    decideApproval: vi.fn<HelixCore['decideApproval']>().mockResolvedValue(approval),
    diff: vi.fn<HelixCore['diff']>().mockResolvedValue({ unifiedDiff: '', files: [] }),
    merge: vi.fn<HelixCore['merge']>().mockResolvedValue({ mergeSha: 'merged-sha' }),
    submitPlan: vi.fn<HelixCore['submitPlan']>().mockResolvedValue(plan),
    decidePlan: vi
      .fn<HelixCore['decidePlan']>()
      .mockResolvedValue({ planId: plan.id, status: 'approved' }),
    explain: vi.fn<HelixCore['explain']>().mockResolvedValue(explanation),
    recordNote: vi.fn<HelixCore['recordNote']>().mockResolvedValue(explanation),
    submitReview: vi.fn<HelixCore['submitReview']>().mockResolvedValue(verdict),
    exportRecording: vi
      .fn<HelixCore['exportRecording']>()
      .mockResolvedValue('{"recording":true}\n'),
    importRecording: vi
      .fn<HelixCore['importRecording']>()
      .mockResolvedValue({ project, eventCount: 0, lastSeq: 0 }),
  } satisfies SetupCore;
  return { core, attachment, outputs };
}
