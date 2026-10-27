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
if (!created || !requested || !note) throw new Error('Missing test fixtures');
export const session = created.payload.session;
export const approval = requested.payload.approval;
export const explanation = note;

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
    events,
    terminals,
    start: vi.fn<HelixCore['start']>().mockResolvedValue(undefined),
    shutdown: vi.fn<HelixCore['shutdown']>().mockResolvedValue(undefined),
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
    exportRecording: vi
      .fn<HelixCore['exportRecording']>()
      .mockResolvedValue('{"recording":true}\n'),
    importRecording: vi
      .fn<HelixCore['importRecording']>()
      .mockResolvedValue({ project, eventCount: 0, lastSeq: 0 }),
  } satisfies HelixCore;
  return { core, attachment, outputs };
}
