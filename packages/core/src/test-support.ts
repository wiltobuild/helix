import path from 'node:path';
import { vi } from 'vitest';
import {
  HelixError,
  parseEvent,
  projectUpTo,
  pullRequestNumberSchema,
  type AgentHarness,
  type ApprovingHarnessSession,
  type DiffResponse,
  type GitService,
  type HarnessEmission,
  type HarnessStartOptions,
  type HelixEvent,
  type HelixStore,
  type MetaValue,
  type Project,
  type ProjectId,
  type PullRequestFacts,
  type ScmEmission,
  type ScmObserver,
  type SessionId,
  type TerminalHost,
  type TerminalOutput,
  type UnsequencedEvent,
} from '@helix/contracts';
import { createHelixCore, type CoreDeps } from './index.js';

export const timestamp = '2026-10-20T12:00:00.000Z';
export const green = { total: 1, passed: 1, failed: 0, pending: 0, failingNames: [] };
export const red = { total: 1, passed: 0, failed: 1, pending: 0, failingNames: ['api.test.ts'] };
export const pending = { total: 1, passed: 0, failed: 0, pending: 1, failingNames: [] };

export class MemoryStore implements HelixStore {
  events: HelixEvent[] = [];
  projects = new Map<ProjectId, Project>();
  records = new Map<string, { hash: string; response: unknown }>();
  metadata = new Map<string, MetaValue>();
  getMeta(scope: string, key: string): Promise<MetaValue | undefined> {
    return Promise.resolve(structuredClone(this.metadata.get(JSON.stringify([scope, key]))));
  }
  setMeta(scope: string, key: string, value: MetaValue): Promise<void> {
    this.metadata.set(JSON.stringify([scope, key]), structuredClone(value));
    return Promise.resolve();
  }
  listeners = new Set<(event: HelixEvent) => void>();
  append(input: UnsequencedEvent[]): Promise<HelixEvent[]> {
    const events = input.map((event, index) => {
      const result = parseEvent({ ...event, seq: this.events.length + index + 1 });
      if (!result.success) throw result.error;
      return result.data;
    });
    this.events.push(...events);
    for (const e of events) for (const listener of this.listeners) listener(structuredClone(e));
    return Promise.resolve(structuredClone(events));
  }
  read(projectId: ProjectId, since: number, limit: number): Promise<HelixEvent[]> {
    return Promise.resolve(
      structuredClone(
        this.events
          .filter((e) => e.projectId === projectId && e.seq > since)
          .slice(0, Math.min(limit, 1000)),
      ),
    );
  }
  subscribe(since: number, cb: (event: HelixEvent) => void): () => void {
    for (const event of this.events) if (event.seq > since) cb(structuredClone(event));
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  saveProject(project: Project): Promise<void> {
    this.projects.set(project.id, structuredClone(project));
    return Promise.resolve();
  }
  getProject(id: ProjectId): Promise<Project | undefined> {
    return Promise.resolve(structuredClone(this.projects.get(id)));
  }
  listProjects(): Promise<Project[]> {
    return Promise.resolve(structuredClone([...this.projects.values()]));
  }
  findProjectByRepoPath(repoPath: string): Promise<Project | undefined> {
    return Promise.resolve(
      structuredClone([...this.projects.values()].find((p) => p.repoPath === repoPath)),
    );
  }
  recall(scope: string, key: string, hash: string): Promise<unknown> {
    const record = this.records.get(JSON.stringify([scope, key]));
    if (record && record.hash !== hash)
      return Promise.reject(new HelixError('IDEMPOTENCY_CONFLICT', 'Request differs'));
    return Promise.resolve(structuredClone(record?.response));
  }
  remember(scope: string, key: string, hash: string, response: unknown): Promise<void> {
    const id = JSON.stringify([scope, key]);
    const record = this.records.get(id);
    if (record && record.hash !== hash)
      return Promise.reject(new HelixError('IDEMPOTENCY_CONFLICT', 'Request differs'));
    if (!record) this.records.set(id, { hash, response: structuredClone(response) });
    return Promise.resolve();
  }
  exportProject = vi.fn((id: ProjectId) =>
    Promise.resolve(JSON.stringify(this.events.filter((e) => e.projectId === id))),
  );
  importRecording = vi.fn<HelixStore['importRecording']>(() =>
    Promise.resolve({
      project: [...this.projects.values()][0]!,
      eventCount: this.events.length,
      lastSeq: this.events.at(-1)?.seq ?? 0,
    }),
  );
  close = vi.fn(() => Promise.resolve());
}

export class FakeHandle implements ApprovingHarnessSession {
  callbacks = new Set<(event: HarnessEmission) => void>();
  resumeToken = '';
  send = vi.fn<ApprovingHarnessSession['send']>(() => Promise.resolve());
  interrupt = vi.fn(() => Promise.resolve());
  stop = vi.fn(() => Promise.resolve());
  decide = vi.fn<ApprovingHarnessSession['decide']>(() => Promise.resolve());
  onEvent(cb: (event: HarnessEmission) => void): () => void {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }
  emit(event: HarnessEmission): void {
    for (const cb of this.callbacks) cb(structuredClone(event));
  }
}
export class FakeHarness implements AgentHarness {
  readonly kind = 'codex';
  handles = new Map<SessionId, FakeHandle>();
  failStart = false;
  detect = vi.fn(() => Promise.resolve({ agent: this.kind, installed: true, signedIn: true }));
  start = vi.fn((options: HarnessStartOptions) => {
    if (this.failStart) return Promise.reject(new Error('resume probe failed'));
    const handle = new FakeHandle();
    handle.resumeToken = options.resumeToken ?? `resume-${options.session.id}`;
    this.handles.set(options.session.id, handle);
    return Promise.resolve(handle);
  });
}
export class FakeGit implements GitService {
  dirty = false;
  ahead = 0;
  remote: string | undefined = 'git@github.com:acme/helix.git';
  diffResult: DiffResponse = {
    unifiedDiff: '',
    files: [{ path: 'api.ts', status: 'modified', insertions: 5, deletions: 2, binary: false }],
  };
  isGitRepo = vi.fn<GitService['isGitRepo']>(() => Promise.resolve(true));
  defaultBranch = vi.fn<GitService['defaultBranch']>(() => Promise.resolve('main'));
  remoteUrl = vi.fn<GitService['remoteUrl']>(() => Promise.resolve(this.remote));
  headSha = vi.fn<GitService['headSha']>(() => Promise.resolve('head-1'));
  commitsAhead = vi.fn<GitService['commitsAhead']>(() => Promise.resolve(this.ahead));
  markTurn = vi.fn<GitService['markTurn']>(() => Promise.resolve());
  commitAll = vi.fn<GitService['commitAll']>(() => {
    this.dirty = false;
    this.ahead++;
    return Promise.resolve('abcdef1234567890');
  });
  push = vi.fn<GitService['push']>(() => Promise.resolve());
  fetchBase = vi.fn<GitService['fetchBase']>(() => Promise.resolve('base-1'));
  create = vi.fn<GitService['create']>((projectId, sessionId, ...args) =>
    Promise.resolve({
      branch: `helix/${args[1]?.slug ?? sessionId}`,
      path: path.join(path.resolve('fake-worktrees'), projectId, sessionId),
      baseSha: 'base-1',
    }),
  );
  diff = vi.fn<GitService['diff']>(() => Promise.resolve(structuredClone(this.diffResult)));
  status = vi.fn<GitService['status']>(() => Promise.resolve({ dirty: this.dirty }));
  remove = vi.fn<GitService['remove']>(() =>
    this.dirty ? Promise.reject(new HelixError('DIRTY_WORKTREE', 'Dirty')) : Promise.resolve(),
  );
}
export class FakeScm implements ScmObserver {
  callbacks = new Map<string, (event: ScmEmission) => void>();
  unsubscribe = vi.fn();
  nextNumber = 1;
  openPr = vi.fn<ScmObserver['openPr']>((): Promise<PullRequestFacts> =>
    Promise.resolve({
      number: pullRequestNumberSchema.parse(this.nextNumber++),
      url: 'https://github.com/acme/helix/pull/1',
      state: 'open',
      draft: false,
      headSha: 'head-1',
      mergeable: 'mergeable',
      checks: pending,
      review: { decision: 'review_required', unresolvedThreads: 0 },
      updatedAt: timestamp,
    }),
  );
  watch = vi.fn<ScmObserver['watch']>((project, number, cb) => {
    const key = `${project.id}:${number}`;
    if (cb) this.callbacks.set(key, cb);
    return () => {
      this.unsubscribe();
      this.callbacks.delete(key);
    };
  });
  merge = vi.fn<ScmObserver['merge']>(() => Promise.resolve({ mergeSha: 'merge-1' }));
  emit(projectId: ProjectId, number: number, event: ScmEmission): void {
    this.callbacks.get(`${projectId}:${number}`)?.(structuredClone(event));
  }
}
export class FakeTerminals implements TerminalHost {
  running = new Set<SessionId>();
  callbacks = new Set<(id: SessionId, code: number | null) => void>();
  detach = vi.fn();
  write = vi.fn<(data: string) => void>();
  output = new Map<SessionId, (m: TerminalOutput) => void>();
  spawn = vi.fn<TerminalHost['spawn']>((id) => {
    this.running.add(id);
    return Promise.resolve();
  });
  attach = vi.fn((id: SessionId, cb: (m: TerminalOutput) => void) => {
    this.output.set(id, cb);
    return Promise.resolve({ write: this.write, resize: vi.fn(), detach: this.detach });
  });
  kill = vi.fn((id: SessionId) => {
    this.exit(id, 0);
    return Promise.resolve();
  });
  onExit(cb: (id: SessionId, code: number | null) => void): () => void {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }
  list(): SessionId[] {
    return [...this.running];
  }
  exit(id: SessionId, code: number | null): void {
    this.running.delete(id);
    for (const cb of this.callbacks) cb(id, code);
  }
}

export function fixture(overrides: Partial<CoreDeps> = {}) {
  const store = new MemoryStore();
  const harness = new FakeHarness();
  const git = new FakeGit();
  const scm = new FakeScm();
  const terminals = new FakeTerminals();
  let next = 0;
  const deps: CoreDeps = {
    store,
    harnesses: { codex: harness },
    worktrees: git,
    scm,
    terminals,
    clock: () => timestamp,
    ids: (prefix) => `${prefix}-${++next}`,
    log: { error: vi.fn() },
    buildFeedbackMessage: vi.fn<CoreDeps['buildFeedbackMessage']>(
      ({ reason, pr, details }) =>
        `Repair ${reason} for PR #${pr.number} (${pr.headSha})${details ? `: ${details}` : ''}`,
    ),
    ...overrides,
  };
  const core = createHelixCore(deps);
  const drain = async () => {
    for (let i = 0; i < 3; i++) await core.health();
  };
  const state = (id: ProjectId) =>
    projectUpTo(
      store.events.filter((e) => e.projectId === id),
      store.events.at(-1)!.seq,
      { strict: true },
    );
  const add = () => core.addProject({ repoPath: path.resolve('fake-repo') });
  return { store, harness, git, scm, terminals, deps, core, drain, state, add };
}
