import path from 'node:path';
import { resolveExecutable } from '@helix/harness';
import {
  HelixError,
  isHelixError,
  applyEvent,
  deriveStatus,
  approvalDecisionRequestSchema,
  createProjectRequestSchema,
  createSessionRequestSchema,
  diffScopeSchema,
  explainRequestSchema,
  planIdSchema,
  projectIdSchema,
  sendMessageRequestSchema,
  sessionIdSchema,
  sessionSchema,
  submitPlanRequestSchema,
  type AgentHarness,
  type AgentKind,
  type ApprovingHarnessSession,
  type CreateSessionRequest,
  type EventSeq,
  type EventType,
  type FeedbackMessageBuilder,
  type GitService,
  type HarnessEmission,
  type HarnessSession,
  type HarnessInfo,
  type HelixCore,
  type HelixEvent,
  type HelixStore,
  type MessageMode,
  type PayloadFor,
  type Plan,
  type PlanNode,
  type Project,
  type ProjectId,
  type ProjectState,
  type ScmEmission,
  type ScmObserver,
  type Session,
  type SessionId,
  type SessionState,
  type TerminalAttachment,
  type TerminalHost,
  type TerminalSpawnOptions,
  type UnsequencedEvent,
  type Unsubscribe,
} from '@helix/contracts';
import { fingerprint, githubRemote, repoPath, slug, validate } from './helpers.js';
import { reload } from './reload.js';

export type CoreLog = { error(message: string, error?: unknown): void };
export type CoreDeps = {
  store: HelixStore;
  harnesses: Record<AgentKind, AgentHarness>;
  worktrees: GitService;
  scm?: ScmObserver;
  buildFeedbackMessage: FeedbackMessageBuilder;
  terminals: TerminalHost;
  clock: () => string;
  ids: (prefix: string) => string;
  log: CoreLog;
  /** @deprecated Ignored: start establishes a session; core always owns initial delivery. */
  harnessStartsWithPrompt?: (agent: AgentKind) => boolean;
  /** Explicit opt-in: token-based conversation resume alone does not imply process reattachment. */
  canReattach?: (agent: AgentKind) => boolean;
  /** Allows executable resolution/configuration at the composition root; no shell strings. */
  terminalOptions?: (session: Session) => TerminalSpawnOptions;
  /** Silence timeout for active chat sessions; defaults to three minutes. */
  stallTimeoutMs?: number;
  /** Composition may supply cached detection shared with the HTTP endpoint. */
  detectHarnesses?: () => Promise<HarnessInfo[]>;
};

type Delivery = { text: string; mode: MessageMode; cause: EventSeq; automatic?: true };
type Runtime = {
  handle?: HarnessSession;
  off?: Unsubscribe;
  attachment?: TerminalAttachment;
  cause: EventSeq;
  turnOpen: boolean;
  turnNumber: number;
  lastAssistantMessage?: string;
  stopped: boolean;
  awaitingInput?: boolean;
  stalled?: boolean;
  lastEmissionAt?: number;
  watchdog?: ReturnType<typeof setTimeout>;
};
type Context = {
  projectId: ProjectId;
  sessionId?: SessionId;
  planNodeId?: PlanNode['id'];
  causedBy?: EventSeq;
};
type Reason = PayloadFor<'feedback.routed'>['reason'];
const RESUME_SCOPE = 'helix:core:resume:v1';
const DELIVERY_SCOPE = 'helix:core:delivered:v1';
const MESSAGE_SCOPE = 'helix:core:message:v1';
const META_HASH = 'v1';

/** A single writer owns domain commands and adapter callbacks. State is only a replay cache. */
export function createHelixCore(deps: CoreDeps): HelixCore {
  const states = new Map<ProjectId, ProjectState>();
  const history = new Map<ProjectId, HelixEvent[]>();
  const runtimes = new Map<SessionId, Runtime>();
  const watchers = new Map<SessionId, Unsubscribe>();
  const held = new Map<SessionId, Delivery[]>();
  const resumes = new Map<SessionId, string>();
  const seenFeedback = new Set<string>();
  const attempts = new Map<string, number>();
  const escalated = new Set<string>();
  let tail = Promise.resolve();
  let loaded = false;
  let started = false;
  let closing = false;
  let exitOff: Unsubscribe | undefined;
  const stallTimeoutMs = deps.stallTimeoutMs ?? 180_000;
  if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0)
    throw new HelixError('INVALID_REQUEST', 'stallTimeoutMs must be positive');
  const detectHarnesses =
    deps.detectHarnesses ??
    (() => Promise.all(Object.values(deps.harnesses).map((h) => h.detect())));

  function armWatchdog(id: SessionId): void {
    const rt = runtimes.get(id)!;
    clearTimeout(rt.watchdog);
    if (closing || rt.stopped || rt.stalled || session(id).activity !== 'active') return;
    rt.watchdog = setTimeout(
      () =>
        background(id, async () => {
          if (rt.stopped || rt.stalled || session(id).activity !== 'active') return;
          if (Date.now() - (rt.lastEmissionAt ?? 0) < stallTimeoutMs) {
            armWatchdog(id);
            return;
          }
          rt.stalled = true;
          const s = session(id).session;
          const duration =
            stallTimeoutMs === 180_000 ? '3 minutes' : `${stallTimeoutMs / 1000} seconds`;
          await emit(
            'explain.note',
            {
              text: `No activity from ${s.agent === 'codex' ? 'Codex' : s.agent} for ${duration} — it may be waiting on something Helix doesn't understand. Check the protocol log.`,
            },
            context(s, rt.cause),
          );
          await emit('activity.changed', { activity: 'unknown' }, context(s, rt.cause));
        }),
      Math.max(1, stallTimeoutMs - (Date.now() - (rt.lastEmissionAt ?? Date.now()))),
    );
    rt.watchdog.unref();
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  function command<T>(work: () => Promise<T>): Promise<T> {
    return enqueue(async () => {
      if (closing) throw new HelixError('CONFLICT', 'Core is shut down');
      try {
        await load();
        return await work();
      } catch (error) {
        if (isHelixError(error)) throw error;
        throw new HelixError(
          'INTERNAL_ERROR',
          error instanceof Error ? error.message : String(error),
        );
      }
    });
  }
  function background(sessionId: SessionId, work: () => Promise<void>): void {
    if (closing) return;
    void enqueue(async () => {
      if (closing) return;
      try {
        await work();
      } catch (error) {
        deps.log.error(`Session ${sessionId} background operation failed`, error);
        const s = findSession(sessionId);
        if (s && !s.session.archivedAt) {
          await emit(
            'explain.note',
            { text: 'An adapter operation failed; inspect the daemon log and retry.' },
            context(s.session),
          );
          await emit('activity.changed', { activity: 'unknown' }, context(s.session));
        }
      }
    }).catch((error: unknown) => deps.log.error('Failed to record background failure', error));
  }
  function project(id: ProjectId): ProjectState {
    const state = states.get(id);
    if (!state) throw new HelixError('NOT_FOUND', `Unknown project: ${id}`);
    return state;
  }
  function findSession(id: SessionId): SessionState | undefined {
    for (const state of states.values())
      if (Object.hasOwn(state.sessions, id)) return state.sessions[id];
    return undefined;
  }
  function session(id: SessionId): SessionState {
    const found = findSession(id);
    if (!found) throw new HelixError('NOT_FOUND', `Unknown session: ${id}`);
    return found;
  }
  function context(s: Session, cause?: EventSeq): Context {
    return {
      projectId: s.projectId,
      sessionId: s.id,
      ...(s.planNodeId ? { planNodeId: s.planNodeId } : {}),
      ...(cause ? { causedBy: cause } : {}),
    };
  }
  function eventsFor(s: Session): HelixEvent[] {
    return (history.get(s.projectId) ?? []).filter((e) => e.sessionId === s.id);
  }
  async function emit<T extends EventType>(
    type: T,
    payload: PayloadFor<T>,
    ctx: Context,
  ): Promise<HelixEvent<T>> {
    // The generic pair is correlated at each call; TS cannot distribute generic object construction.
    const input = { v: 1, ts: deps.clock(), ...ctx, type, payload } as UnsequencedEvent;
    const [event] = await deps.store.append([input]);
    if (!event || event.type !== type)
      throw new HelixError('INTERNAL_ERROR', 'Store did not return the appended event');
    states.set(ctx.projectId, applyEvent(states.get(ctx.projectId), event, { strict: true }));
    const list = history.get(ctx.projectId) ?? [];
    list.push(event);
    history.set(ctx.projectId, list);
    return event as HelixEvent<T>;
  }
  function reasonKey(s: Session, prNumber: number, reason: Reason): string {
    return JSON.stringify([s.projectId, prNumber, reason]);
  }
  function feedbackKey(s: Session, prNumber: number, reason: Reason, headSha: string): string {
    return JSON.stringify([s.projectId, prNumber, reason, headSha]);
  }
  async function load(): Promise<void> {
    if (loaded) return;
    states.clear();
    history.clear();
    seenFeedback.clear();
    attempts.clear();
    held.clear();
    resumes.clear();
    for (const p of await deps.store.listProjects()) {
      const events: HelixEvent[] = [];
      let cursor = 0;
      for (;;) {
        const page = await deps.store.read(p.id, cursor, 1000);
        if (!page.length) break;
        events.push(...page);
        cursor = page[page.length - 1]!.seq;
      }
      history.set(p.id, events);
      if (!events.length) {
        // Repair an index save interrupted before its project.added append.
        await emit('project.added', { project: p }, { projectId: p.id });
        continue;
      }
      const recovered = reload(events, deps.log);
      if (!recovered.state) continue;
      states.set(p.id, recovered.state);
      // Invalid events stay in storage but must never be replayed as deliveries.
      history.set(p.id, recovered.events);
      const heads = new Map<SessionId, string>();
      for (const e of recovered.events) {
        if ((e.type === 'pr.opened' || e.type === 'pr.updated') && e.sessionId)
          heads.set(e.sessionId, e.payload.pr.headSha);
        if (e.type === 'feedback.routed') {
          const s = session(e.payload.toSessionId).session;
          const key = reasonKey(s, e.payload.prNumber, e.payload.reason);
          attempts.set(key, (attempts.get(key) ?? 0) + 1);
          seenFeedback.add(
            feedbackKey(s, e.payload.prNumber, e.payload.reason, heads.get(s.id) ?? 'unknown'),
          );
          if (!(await deps.store.recall(DELIVERY_SCOPE, String(e.seq), META_HASH)))
            hold(s.id, { text: e.payload.summary, mode: 'queue', cause: e.seq, automatic: true });
        }
        if (
          e.type === 'chat.item' &&
          e.sessionId &&
          e.payload.item.kind === 'message' &&
          e.payload.item.role === 'user' &&
          !(await deps.store.recall(DELIVERY_SCOPE, String(e.seq), META_HASH))
        ) {
          // CONTRACT-REQUEST: durable message/outbox records should be a dedicated
          // store seam. v1 receipts cannot make harness delivery exactly-once.
          const mode = await deps.store.recall(MESSAGE_SCOPE, String(e.seq), META_HASH);
          hold(e.sessionId, {
            text: e.payload.item.text,
            mode: mode === 'interrupt' ? 'interrupt' : 'queue',
            cause: e.seq,
          });
        }
      }
      for (const s of Object.values(project(p.id).sessions)) {
        // CONTRACT-REQUEST: add durable resume-token storage to HelixStore. v1 uses
        // immutable idempotency records keyed by the event where the token was observed.
        for (const e of [...eventsFor(s.session)].reverse()) {
          const token = await deps.store.recall(
            RESUME_SCOPE,
            `${s.session.id}:${e.seq}`,
            META_HASH,
          );
          if (typeof token === 'string') {
            resumes.set(s.session.id, token);
            break;
          }
        }
      }
    }
    loaded = true;
  }
  function hold(id: SessionId, delivery: Delivery): void {
    const queue = held.get(id) ?? [];
    if (!queue.some((d) => d.cause === delivery.cause)) {
      if (delivery.mode === 'interrupt') queue.unshift(delivery);
      else queue.push(delivery);
    }
    held.set(id, queue);
  }
  function blocked(s: SessionState): boolean {
    return s.pendingApprovalIds.length > 0 || s.activity === 'blocked';
  }
  async function saveResume(id: SessionId, seq: EventSeq): Promise<void> {
    const token = runtimes.get(id)?.handle?.resumeToken;
    if (token && token !== resumes.get(id)) {
      await deps.store.remember(RESUME_SCOPE, `${id}:${seq}`, META_HASH, token);
      resumes.set(id, token);
    }
  }
  async function deliver(id: SessionId, delivery: Delivery): Promise<void> {
    const s = session(id);
    const runtime = runtimes.get(id);
    if (delivery.automatic && s.pr?.state !== 'open') return;
    if (s.session.archivedAt || s.activity === 'exited' || runtime?.stopped) return;
    if (blocked(s) || !runtime?.handle) {
      hold(id, delivery);
      return;
    }
    if (runtime.turnOpen) {
      if (runtime.awaitingInput && !delivery.automatic) {
        await runtime.handle.send(delivery.text, delivery.mode);
        await deps.store.remember(DELIVERY_SCOPE, String(delivery.cause), META_HASH, true);
        return;
      }
      hold(id, delivery);
      // The old turn retains its cause through cancellation and end-of-turn shipping.
      if (delivery.mode === 'interrupt') await runtime.handle.interrupt();
      return;
    }
    runtime.cause = delivery.cause;
    runtime.turnOpen = true;
    runtime.turnNumber++;
    delete runtime.lastAssistantMessage;
    try {
      await runtime.handle.send(delivery.text, 'queue');
      await deps.store.remember(DELIVERY_SCOPE, String(delivery.cause), META_HASH, true);
      await saveResume(id, delivery.cause);
    } catch (error) {
      runtime.turnOpen = false;
      runtime.turnNumber--;
      hold(id, delivery);
      throw error;
    }
  }
  async function flush(id: SessionId): Promise<void> {
    if (blocked(session(id)) || !runtimes.get(id)?.handle || runtimes.get(id)?.turnOpen) return;
    const queue = held.get(id) ?? [];
    while (queue.length && !runtimes.get(id)?.turnOpen) await deliver(id, queue.shift()!);
    if (!queue.length) held.delete(id);
  }
  function harnessFor(agent: AgentKind): AgentHarness {
    const harness = Object.hasOwn(deps.harnesses, agent) ? deps.harnesses[agent] : undefined;
    if (!harness) throw new HelixError('HARNESS_UNAVAILABLE', `No harness configured for ${agent}`);
    return harness;
  }
  async function terminalOptions(s: Session): Promise<TerminalSpawnOptions> {
    if (deps.terminalOptions) return deps.terminalOptions(s);
    if (s.agent !== 'claude-code' && s.agent !== 'codex')
      throw new HelixError('HARNESS_UNAVAILABLE', `No terminal command configured for ${s.agent}`);
    const command = await resolveExecutable(s.agent === 'claude-code' ? 'claude' : 'codex');
    if (!command)
      throw new HelixError('HARNESS_UNAVAILABLE', `${s.agent} executable was not found`);
    return {
      command,
      args: [...(s.model ? ['--model', s.model] : [])],
      cwd: s.worktreePath!,
    };
  }
  function listenForExits(): void {
    exitOff ??= deps.terminals.onExit((id, code) =>
      background(id, async () => {
        const s = findSession(id);
        if (
          !s ||
          s.session.interface !== 'terminal' ||
          s.activity === 'exited' ||
          s.session.archivedAt
        )
          return;
        const rt = runtimes.get(id);
        await emit('activity.changed', { activity: 'exited' }, context(s.session, rt?.cause));
        await emit('session.exited', { code }, context(s.session, rt?.cause));
        if (rt) {
          rt.stopped = true;
          rt.attachment?.detach();
        }
      }),
    );
  }
  async function launch(
    s: Session,
    cause: EventSeq,
    resume: boolean,
    sendInitial = !resume,
  ): Promise<void> {
    const turnNumber = new Set(
      eventsFor(s)
        .filter(
          (e) =>
            e.type === 'activity.changed' &&
            e.payload.activity === 'active' &&
            e.causedBy !== undefined,
        )
        .map((e) => e.causedBy),
    ).size;
    const runtime: Runtime = { cause, turnOpen: false, turnNumber, stopped: false };
    runtimes.set(s.id, runtime);
    try {
      if (s.interface === 'terminal') {
        listenForExits();
        if (resume) {
          if (!deps.terminals.list().includes(s.id))
            throw new HelixError(
              'HARNESS_UNAVAILABLE',
              'Terminal process is not available for reattachment',
            );
        } else if (!deps.terminals.list().includes(s.id))
          await deps.terminals.spawn(s.id, await terminalOptions(s));
        runtime.attachment = await deps.terminals.attach(s.id, () => {
          /* Terminal bytes are not domain activity. */
        });
        if (!resume && sendInitial) {
          // Bracketed paste preserves multiline prompts in interactive CLIs and .cmd shims.
          runtime.attachment.write(`\x1b[200~${s.prompt.replace(/\r\n/g, '\n')}\x1b[201~\r`);
        }
        await emit('activity.changed', { activity: 'active' }, context(s, cause));
        return;
      }
      const token = resumes.get(s.id);
      runtime.handle = await harnessFor(s.agent).start({
        session: s,
        cwd: s.worktreePath!,
        ...(token ? { resumeToken: token } : {}),
      });
      let subscribing = true;
      runtime.off = runtime.handle.onEvent((event) => {
        runtime.lastEmissionAt = Date.now();
        const copy = structuredClone(event);
        // A fresh task remains starting until its first send. Do not publish a
        // buffered initialization idle as though that task had already finished.
        if (
          subscribing &&
          sendInitial &&
          copy.type === 'activity.changed' &&
          copy.payload.activity === 'idle'
        )
          return;
        // Startup emissions are buffered by adapters. Capture ownership before
        // initial delivery so a startup idle cannot complete the first real turn.
        const turnCause = runtime.cause;
        const turnWasOpen = runtime.turnOpen;
        background(s.id, async () => {
          if (!runtime.stopped) await onHarness(s.id, copy, turnCause, turnWasOpen);
        });
      });
      subscribing = false;
      await saveResume(s.id, cause);
      if (sendInitial) {
        await deliver(s.id, { text: s.prompt, mode: 'queue', cause });
      }
      await flush(s.id);
    } catch (error) {
      runtime.off?.();
      runtime.stopped = s.interface === 'chat' || !deps.terminals.list().includes(s.id);
      if (s.interface === 'terminal' && !resume && !runtime.stopped) {
        try {
          await deps.terminals.kill(s.id);
          runtime.stopped = true;
        } catch (stopError) {
          deps.log.error('Failed to stop incomplete terminal launch', stopError);
        }
      }
      if (runtime.handle)
        await runtime.handle
          .stop()
          .catch((stopError: unknown) =>
            deps.log.error('Failed to stop incomplete harness launch', stopError),
          );
      await emit('activity.changed', { activity: 'unknown' }, context(s, cause));
      if (resume) {
        deps.log.error(`Could not resume ${s.id}`, error);
        return;
      }
      throw isHelixError(error)
        ? error
        : new HelixError(
            'HARNESS_UNAVAILABLE',
            error instanceof Error ? error.message : String(error),
          );
    }
  }
  async function onHarness(
    id: SessionId,
    emission: HarnessEmission,
    cause: EventSeq,
    turnWasOpen: boolean,
  ): Promise<void> {
    const before = session(id);
    const rt = runtimes.get(id)!;
    if (before.session.archivedAt) return;
    clearTimeout(rt.watchdog);
    if (rt.stalled) {
      rt.stalled = false;
      if (emission.type !== 'activity.changed')
        await emit('activity.changed', { activity: 'active' }, context(before.session, cause));
    }
    if (emission.type === 'chat.item' && emission.payload.item.kind === 'question')
      rt.awaitingInput = true;
    if (
      rt.turnOpen &&
      rt.cause === cause &&
      emission.type === 'chat.item' &&
      emission.payload.item.kind === 'message' &&
      emission.payload.item.role === 'assistant'
    )
      rt.lastAssistantMessage = emission.payload.item.text;
    if (emission.type === 'activity.changed' && emission.payload.activity !== 'waiting_input')
      rt.awaitingInput = false;
    if (emission.type === 'approval.requested' && emission.payload.approval.sessionId !== id)
      throw new HelixError('INVALID_REQUEST', 'Harness approval has the wrong session');
    const e = await emit(emission.type, emission.payload, context(before.session, cause));
    await saveResume(id, e.seq);
    if (emission.type === 'activity.changed') {
      if (
        emission.payload.activity === 'idle' &&
        turnWasOpen &&
        rt.turnOpen &&
        rt.cause === cause
      ) {
        await endTurn(id, e.seq);
        rt.turnOpen = false;
      }
      if (emission.payload.activity === 'exited') {
        rt.stopped = true;
        await emit('session.exited', { code: null }, context(before.session, e.seq));
      } else await flush(id);
    }
    armWatchdog(id);
  }
  async function endTurn(id: SessionId, cause: EventSeq): Promise<void> {
    let s = session(id);
    if (!s.worktree) return;
    if ((await deps.worktrees.status(s.worktree.path)).dirty) {
      const rt = runtimes.get(id)!;
      const title = [...s.session.title.replace(/\s+/g, ' ').trim()].slice(0, 72).join('');
      const summary = [...(rt.lastAssistantMessage ?? '').replace(/\s+/g, ' ').trim()]
        .slice(0, 500)
        .join('');
      const message = `${title}\n\nTurn ${rt.turnNumber} by ${s.session.agent} via Helix${summary ? `\n\n${summary}` : ''}`;
      try {
        const sha = await deps.worktrees.commitAll(s.worktree.path, message);
        if (sha)
          await emit(
            'explain.note',
            { text: `Committed ${sha.slice(0, 7)}: ${title}` },
            context(s.session, cause),
          );
      } catch (error) {
        deps.log.error(`Could not commit turn for ${id}`, error);
        await emit(
          'explain.note',
          {
            text: `Helix could not commit this turn: ${error instanceof Error ? error.message : String(error)}`,
          },
          context(s.session, cause),
        );
        await emit('activity.changed', { activity: 'blocked' }, context(s.session, cause));
        return;
      }
    }
    await deps.worktrees.markTurn(s.worktree.path, id);
    const diff = await deps.worktrees.diff(s.worktree.path, 'pr');
    const stats = {
      filesChanged: diff.files.length,
      insertions: diff.files.reduce((n, f) => n + f.insertions, 0),
      deletions: diff.files.reduce((n, f) => n + f.deletions, 0),
    };
    if (fingerprint(stats) !== fingerprint(s.worktree.diff))
      await emit('worktree.diff_updated', stats, context(s.session, cause));
    s = session(id);
    const p = project(s.session.projectId).project;
    if (s.session.role !== 'worker' || !p.github || !deps.scm || s.session.archivedAt) return;
    if ((await deps.worktrees.commitsAhead(s.worktree!.path, p.defaultBranch)) === 0) return;
    // Push later repair commits as well as the first branch; otherwise CI never sees the fix.
    if (s.pr && s.pr.state !== 'open') return;
    await deps.worktrees.push(s.worktree!.path, s.worktree!.branch);
    if (s.pr) return;
    const node = Object.values(project(p.id).plans)
      .flatMap((plan) => plan.nodes)
      .find((n) => n.id === s.session.planNodeId);
    const body = [
      s.session.prompt,
      ...(node
        ? [
            `Rationale: ${node.rationale}`,
            `Acceptance criteria:\n${node.acceptance.map((a) => `- ${a}`).join('\n')}`,
          ]
        : []),
    ].join('\n\n');
    const pr = await deps.scm.openPr({
      project: p,
      sessionId: id,
      head: s.worktree!.branch,
      base: p.defaultBranch,
      title: s.session.title,
      body,
      draft: false,
    });
    const opened = await emit('pr.opened', { pr }, context(s.session, cause));
    watch(id, opened.seq);
  }
  function watch(id: SessionId, cause?: EventSeq): void {
    const s = session(id);
    const needsMerge =
      s.pr?.state === 'merged' && !eventsFor(s.session).some((e) => e.type === 'pr.merged');
    if (
      !deps.scm ||
      !s.pr ||
      (s.pr.state !== 'open' && !needsMerge) ||
      s.session.archivedAt ||
      watchers.has(id)
    )
      return;
    watchers.set(
      id,
      deps.scm.watch(project(s.session.projectId).project, s.pr.number, (emission) => {
        const copy = structuredClone(emission);
        background(id, async () => {
          await onScm(id, copy, cause);
        });
      }),
    );
  }
  async function onScm(id: SessionId, emission: ScmEmission, cause?: EventSeq): Promise<void> {
    const s = session(id);
    if (s.session.archivedAt || !s.pr) return;
    if (emission.type === 'pr.merged') {
      if (
        eventsFor(s.session).some(
          (e) => e.type === 'pr.merged' && e.payload.prNumber === emission.payload.prNumber,
        )
      )
        return;
    } else if (s.pr.state !== 'open') return;
    const number =
      emission.type === 'pr.updated' ? emission.payload.pr.number : emission.payload.prNumber;
    if (number !== s.pr.number)
      throw new HelixError('INVALID_REQUEST', 'SCM update has the wrong PR');
    const e = await emit(emission.type, emission.payload, context(s.session, cause));
    if (emission.type === 'pr.merged') {
      watchers.get(id)?.();
      watchers.delete(id);
      await schedule(s.session.projectId, e.seq);
    } else if (emission.type === 'pr.updated' && emission.payload.pr.state === 'closed') {
      watchers.get(id)?.();
      watchers.delete(id);
    } else if (emission.type === 'ci.updated' && emission.payload.checks.failed > 0) {
      await feedback(id, 'ci_failed', e.seq, emission.payload.checks.failingNames.join('\n'));
    } else if (
      emission.type === 'review.updated' &&
      emission.payload.review.decision === 'changes_requested'
    ) {
      await feedback(id, 'changes_requested', e.seq);
    } else if (emission.type === 'pr.updated' && emission.payload.pr.mergeable === 'conflicting') {
      await feedback(id, 'merge_conflict', e.seq);
    }
  }
  async function feedback(
    id: SessionId,
    reason: Reason,
    cause: EventSeq,
    details?: string,
  ): Promise<void> {
    const s = session(id);
    const pr = s.pr!;
    if (
      pr.state !== 'open' ||
      s.session.archivedAt ||
      s.activity === 'exited' ||
      runtimes.get(id)?.stopped
    )
      return;
    const key = reasonKey(s.session, pr.number, reason);
    const seenKey = feedbackKey(s.session, pr.number, reason, pr.headSha);
    if (seenFeedback.has(seenKey)) return;
    if ((attempts.get(key) ?? 0) >= 3) {
      if (!escalated.has(key)) {
        await emit(
          'explain.note',
          {
            text: `Automatic ${reason} repairs stopped after 3 attempts for PR #${pr.number}; human input is required.`,
          },
          context(s.session, cause),
        );
        await emit('activity.changed', { activity: 'waiting_input' }, context(s.session, cause));
        escalated.add(key);
      }
      return;
    }
    const summary = deps.buildFeedbackMessage({ reason, pr, ...(details ? { details } : {}) });
    const routed = await emit(
      'feedback.routed',
      { prNumber: pr.number, reason, summary, toSessionId: id },
      context(s.session, cause),
    );
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    seenFeedback.add(seenKey);
    await deliver(id, { text: summary, mode: 'queue', cause: routed.seq, automatic: true });
  }
  async function create(
    p: Project,
    request: CreateSessionRequest,
    key: string,
    node?: PlanNode,
    parent?: SessionId,
    cause?: EventSeq,
    prerequisites: string[] = [],
  ): Promise<Session> {
    const scope = `helix:create-session:${p.id}`;
    const hash = fingerprint({
      request,
      ...(node ? { planNodeId: node.id } : {}),
      ...(parent ? { parentSessionId: parent } : {}),
    });
    const completed = await deps.store.recall(`${scope}:result`, key, hash);
    if (completed) return validate(sessionSchema, completed);
    const reserved = await deps.store.recall(scope, key, hash);
    let s: Session;
    if (reserved) s = validate(sessionSchema, reserved);
    else {
      if (request.interface === 'chat') harnessFor(request.agent);
      s = {
        id: validate(sessionIdSchema, deps.ids('session')),
        projectId: p.id,
        role: request.planWithOrchestrator ? 'orchestrator' : 'worker',
        agent: request.agent,
        title: request.title,
        prompt: request.prompt,
        interface: request.interface,
        createdAt: deps.clock(),
        ...(request.model ? { model: request.model } : {}),
        ...(node ? { planNodeId: node.id } : {}),
        ...(parent ? { parentSessionId: parent } : {}),
      };
      if (s.interface === 'terminal') await terminalOptions({ ...s, worktreePath: p.repoPath });
      // Reserve identity before side effects so retries cannot create a second worker.
      await deps.store.remember(scope, key, hash, s);
    }
    let creation = eventsFor(s).find((e) => e.type === 'session.created');
    creation ??= await emit('session.created', { session: s }, context(s, cause));
    if (!session(s.id).worktree) {
      let base = p.defaultBranch;
      if (prerequisites.length) {
        try {
          base = await deps.worktrees.fetchBase(p.repoPath, p.defaultBranch);
        } catch (error) {
          await emit(
            'explain.note',
            {
              text: `Cannot start dependent worker: fetching origin/${p.defaultBranch} failed: ${error instanceof Error ? error.message : String(error)}`,
            },
            context(s, cause),
          );
          await emit('activity.changed', { activity: 'waiting_input' }, context(s, cause));
          return s;
        }
        await emit(
          'explain.note',
          {
            text: `Starting from fetched base ${base}; merged prerequisites: ${prerequisites.join(', ')}.`,
          },
          context(s, cause),
        );
      }
      const worktree = await deps.worktrees.create(p.id, s.id, base, {
        slug: slug(s.title),
      });
      await emit('worktree.created', worktree, context(s, creation.seq));
    }
    s = session(s.id).session;
    const worktreeEvent = eventsFor(s).find((e) => e.type === 'worktree.created')!;
    let start = eventsFor(s).find((e) => e.type === 'session.started');
    start ??= await emit(
      'session.started',
      {},
      context(s, prerequisites.length ? cause : worktreeEvent.seq),
    );
    if (
      !runtimes.has(s.id) ||
      runtimes.get(s.id)?.stopped ||
      (s.interface === 'terminal' && !runtimes.get(s.id)?.attachment)
    ) {
      const delivered = await deps.store.recall(DELIVERY_SCOPE, String(start.seq), META_HASH);
      await launch(s, start.seq, false, !delivered);
    }
    await deps.store.remember(`${scope}:result`, key, hash, s);
    return structuredClone(s);
  }
  async function schedule(projectId: ProjectId, cause: EventSeq): Promise<void> {
    const p = project(projectId);
    for (const plan of Object.values(p.plans))
      for (const node of plan.nodes) {
        if (
          node.sessionId &&
          (session(node.sessionId).worktree || session(node.sessionId).session.archivedAt)
        )
          continue;
        const merges = node.dependsOn.map((id) => {
          const dep = plan.nodes.find((n) => n.id === id);
          return dep?.sessionId
            ? eventsFor(session(dep.sessionId).session).find((e) => e.type === 'pr.merged')
            : undefined;
        });
        if (merges.some((e) => !e)) continue;
        const unblockedBy =
          merges.reduce((latest, e) => (e && e.seq > latest ? e.seq : latest), 0 as EventSeq) ||
          cause;
        const s = await create(
          p.project,
          {
            title: node.title,
            prompt: node.description || node.title,
            agent: node.agent,
            interface: 'chat',
          },
          `plan:${plan.id}:${node.id}`,
          node,
          plan.orchestratorSessionId,
          unblockedBy,
          merges.map((e, i) => `${node.dependsOn[i]} (PR #${e!.payload.prNumber})`),
        );
        await emit(
          'plan.node_updated',
          {
            nodeId: node.id,
            sessionId: s.id,
            note: !session(s.id).worktree
              ? 'Waiting for a successful base fetch.'
              : node.dependsOn.length
                ? 'All dependencies merged; worker started.'
                : 'No unmet dependencies; worker started.',
          },
          context(s, unblockedBy),
        );
      }
  }
  async function stop(id: SessionId): Promise<void> {
    const s = session(id);
    if (s.activity === 'exited') return;
    const rt = runtimes.get(id);
    if (s.session.interface === 'terminal') await deps.terminals.kill(id);
    else if (rt?.handle) await rt.handle.stop();
    else
      throw new HelixError(
        'HARNESS_UNAVAILABLE',
        'Cannot confirm termination without an attached harness',
      );
    if (rt) {
      clearTimeout(rt.watchdog);
      rt.stopped = true;
      rt.off?.();
      rt.attachment?.detach();
    }
    held.delete(id);
    await emit('session.exited', { code: null }, context(s.session, rt?.cause));
  }

  const api: HelixCore = {
    events: deps.store,
    terminals: deps.terminals,
    start: () =>
      command(async () => {
        if (started) return;
        listenForExits();
        for (const p of states.values())
          for (const s of Object.values(p.sessions)) {
            if (s.session.archivedAt) continue;
            if (s.activity !== 'exited' && !runtimes.has(s.session.id)) {
              const last = eventsFor(s.session).at(-1)!;
              if (!s.worktree)
                await emit(
                  'activity.changed',
                  { activity: 'unknown' },
                  context(s.session, last.seq),
                );
              else {
                const initial = eventsFor(s.session).find((e) => e.type === 'session.started');
                const delivered =
                  initial &&
                  (await deps.store.recall(DELIVERY_SCOPE, String(initial.seq), META_HASH));
                const sendInitial = Boolean(
                  initial && !delivered && s.session.interface === 'chat',
                );
                await launch(s.session, sendInitial ? initial!.seq : last.seq, true, sendInitial);
              }
            }
            watch(s.session.id);
          }
        for (const p of states.values()) {
          const cause = history.get(p.project.id)?.at(-1)?.seq;
          if (cause) await schedule(p.project.id, cause);
        }
        started = true;
      }),
    shutdown: () =>
      enqueue(async () => {
        if (closing) return;
        closing = true;
        for (const off of watchers.values()) off();
        watchers.clear();
        exitOff?.();
        const failures: unknown[] = [];
        for (const [id, rt] of runtimes) {
          clearTimeout(rt.watchdog);
          rt.off?.();
          rt.attachment?.detach();
          if (rt.stopped) continue;
          const s = session(id).session;
          // CONTRACT-REQUEST: AgentHarness needs an explicit supportsReattach capability.
          // Default to stopping; a resumeToken only promises conversation resume.
          if (s.interface === 'chat' && resumes.has(id) && deps.canReattach?.(s.agent)) continue;
          try {
            await stop(id);
          } catch (error) {
            failures.push(error);
            deps.log.error(`Failed to stop ${id}`, error);
          }
        }
        if (failures.length)
          throw new HelixError('INTERNAL_ERROR', `Failed to stop ${failures.length} sessions`);
        // Store lifetime belongs to the composition root, which also serves SSE/recordings.
      }),
    health: () => command(() => Promise.resolve({ status: 'ok', version: '0.0.0' })),
    harnesses: () => detectHarnesses(),
    listProjects: () => command(() => deps.store.listProjects()),
    addProject: (request) =>
      command(async () => {
        const input = validate(createProjectRequestSchema, request);
        const normalized = repoPath(input.repoPath);
        const originalPath = path.resolve(input.repoPath);
        const existing =
          (await deps.store.findProjectByRepoPath(normalized)) ??
          (await deps.store.listProjects()).find((p) => repoPath(p.repoPath) === normalized);
        if (existing) {
          if (!states.has(existing.id))
            await emit('project.added', { project: existing }, { projectId: existing.id });
          return existing;
        }
        if (!(await deps.worktrees.isGitRepo(originalPath)))
          throw new HelixError('INVALID_REQUEST', 'Path is not a git repository');
        const github = githubRemote(await deps.worktrees.remoteUrl(originalPath, 'origin'));
        const available = (await detectHarnesses()).filter(
          (h) => h.installed && h.signedIn === true,
        );
        const defaultAgent =
          ['codex', 'claude-code']
            .map((kind) => available.find((h) => h.agent === kind))
            .find(Boolean)?.agent ?? available[0]?.agent;
        if (!defaultAgent)
          throw new HelixError(
            'HARNESS_UNAVAILABLE',
            'Install and sign in to Codex or Claude Code before adding a project',
          );
        const p: Project = {
          id: validate(projectIdSchema, deps.ids('project')),
          name: input.name ?? path.basename(originalPath),
          repoPath: originalPath,
          defaultBranch: await deps.worktrees.defaultBranch(originalPath),
          defaultAgent,
          createdAt: deps.clock(),
          ...(github ? { github } : {}),
        };
        await deps.store.saveProject(p);
        await emit('project.added', { project: p }, { projectId: p.id });
        return structuredClone(p);
      }),
    projectEvents: (id, since, limit) =>
      command(async () => {
        project(id);
        if (
          !Number.isSafeInteger(since) ||
          since < 0 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 1000
        )
          throw new HelixError('INVALID_REQUEST', 'Invalid event cursor or limit');
        const events = await deps.store.read(id, since, limit);
        return { events, lastSeq: events.at(-1)?.seq ?? since };
      }),
    createSession: (id, request, key) =>
      command(async () => {
        const input = validate(createSessionRequestSchema, request);
        if (!key || key.length > 255)
          throw new HelixError(
            'INVALID_REQUEST',
            'Idempotency key must contain 1 to 255 characters',
          );
        return create(project(id).project, input, key);
      }),
    sendMessage: (id, request) =>
      command(async () => {
        const input = validate(sendMessageRequestSchema, request);
        const s = session(id);
        if (s.session.archivedAt || s.activity === 'exited')
          throw new HelixError('CONFLICT', 'Session is not running');
        if (s.session.interface === 'terminal')
          throw new HelixError('INVALID_REQUEST', 'Send terminal input through TerminalHost');
        const e = await emit(
          'chat.item',
          { item: { kind: 'message', role: 'user', text: input.text } },
          context(s.session),
        );
        await deps.store.remember(MESSAGE_SCOPE, String(e.seq), META_HASH, input.mode);
        await deliver(id, { ...input, cause: e.seq });
      }),
    stopSession: (id) => command(() => stop(id)),
    archiveSession: (id) =>
      command(async () => {
        const s = session(id);
        if (s.session.archivedAt) return structuredClone(s.session);
        await stop(id);
        watchers.get(id)?.();
        watchers.delete(id);
        const archived = await emit('session.archived', {}, context(s.session));
        if (s.worktree) {
          if ((await deps.worktrees.status(s.worktree.path)).dirty)
            await emit(
              'explain.note',
              {
                text: 'Dirty worktree retained after archival; commit or discard changes manually before removing it.',
              },
              context(s.session, archived.seq),
            );
          else {
            try {
              await deps.worktrees.remove(s.worktree.path, { force: false });
            } catch (error) {
              if (!isHelixError(error) || error.code !== 'DIRTY_WORKTREE') throw error;
              await emit(
                'explain.note',
                { text: 'Worktree became dirty during cleanup and was retained.' },
                context(s.session, archived.seq),
              );
            }
          }
        }
        return structuredClone(session(id).session);
      }),
    decideApproval: (id, request) =>
      command(async () => {
        const { decision } = validate(approvalDecisionRequestSchema, request);
        const p = [...states.values()].find((state) => Object.hasOwn(state.approvals, id));
        const approval = p?.approvals[id];
        if (!approval) throw new HelixError('NOT_FOUND', `Unknown approval: ${id}`);
        if (approval.decision) {
          if (approval.decision === decision) return structuredClone(approval);
          throw new HelixError('CONFLICT', 'Approval was already decided');
        }
        const handle = runtimes.get(approval.sessionId)?.handle;
        if (!handle || !('decide' in handle) || typeof handle.decide !== 'function')
          throw new HelixError('HARNESS_UNAVAILABLE', 'Harness cannot resolve approvals');
        const approving = handle as ApprovingHarnessSession;
        await approving.decide(id, decision);
        const s = session(approval.sessionId).session;
        const trigger = eventsFor(s).find(
          (e) => e.type === 'approval.requested' && e.payload.approval.id === id,
        );
        await emit('approval.decided', { approvalId: id, decision }, context(s, trigger?.seq));
        await flush(s.id);
        return structuredClone(project(s.projectId).approvals[id]!);
      }),
    diff: (id, scope) =>
      command(async () => {
        const s = session(id);
        if (!s.worktree) throw new HelixError('NOT_FOUND', 'Session has no worktree');
        return deps.worktrees.diff(s.worktree.path, validate(diffScopeSchema, scope));
      }),
    merge: (id) =>
      command(async () => {
        const s = session(id);
        if (!deps.scm || !project(s.session.projectId).project.github)
          throw new HelixError('MERGE_BLOCKED', 'GitHub integration is not configured');
        if (!s.pr || deriveStatus(s) !== 'ready_to_merge')
          throw new HelixError('MERGE_BLOCKED', 'PR is not ready to merge');
        const result = await deps.scm.merge({
          project: project(s.session.projectId).project,
          prNumber: s.pr.number,
          expectedHeadSha: s.pr.headSha,
          method: 'squash',
        });
        await onScm(id, {
          type: 'pr.merged',
          payload: { prNumber: s.pr.number, mergeSha: result.mergeSha },
        });
        return result;
      }),
    submitPlan: (request) =>
      command(async () => {
        const input = validate(submitPlanRequestSchema, request);
        const p = project(input.projectId);
        const orchestrator = session(input.orchestratorSessionId);
        if (
          orchestrator.session.projectId !== input.projectId ||
          orchestrator.session.role !== 'orchestrator' ||
          orchestrator.session.archivedAt
        )
          throw new HelixError(
            'INVALID_REQUEST',
            'Plan requires a live orchestrator in this project',
          );
        const known = new Set(
          Object.values(p.plans).flatMap((plan) => plan.nodes.map((n) => n.id)),
        );
        for (const node of input.nodes) {
          if (known.has(node.id) || node.sessionId)
            throw new HelixError(
              'INVALID_REQUEST',
              'Plan node IDs must be new and worker sessions are assigned by core',
            );
          harnessFor(node.agent);
        }
        const plan: Plan = {
          ...input,
          id: validate(planIdSchema, deps.ids('plan')),
          createdAt: deps.clock(),
        };
        const e = await emit('plan.submitted', { plan }, context(orchestrator.session));
        await schedule(input.projectId, e.seq);
        const projected = project(input.projectId).plans[plan.id]!;
        return { ...plan, nodes: structuredClone(projected.nodes) };
      }),
    explain: (request) =>
      command(async () => {
        const input = validate(explainRequestSchema, request);
        const s = session(input.sessionId).session;
        if (
          input.planNodeId &&
          !Object.values(project(s.projectId).plans).some((p) =>
            p.nodes.some((n) => n.id === input.planNodeId),
          )
        )
          throw new HelixError('INVALID_REQUEST', 'Unknown plan node');
        if (
          input.causedBy &&
          !(history.get(s.projectId) ?? []).some((e) => e.seq === input.causedBy)
        )
          throw new HelixError(
            'INVALID_REQUEST',
            'Cause must reference a prior event in this project',
          );
        return emit(
          'explain.note',
          { text: input.text },
          {
            ...context(s, input.causedBy),
            ...(input.planNodeId ? { planNodeId: input.planNodeId } : {}),
          },
        );
      }),
    exportRecording: (id) =>
      command(() => {
        project(id);
        return deps.store.exportProject(id);
      }),
    importRecording: (text) => command(() => deps.store.importRecording(text)),
  };
  return api;
}
