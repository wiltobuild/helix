import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolveExecutable, reviewerPrompt as defaultReviewerPrompt } from '@helix/harness';
import {
  HelixError,
  isHelixError,
  applyEvent,
  deriveStatus,
  crossReviewerFor,
  approvalDecisionRequestSchema,
  createProjectRequestSchema,
  createSessionRequestSchema,
  diffScopeSchema,
  explainRequestSchema,
  planIdSchema,
  planDecisionRequestSchema,
  projectIdSchema,
  sendMessageRequestSchema,
  sessionIdSchema,
  sessionSchema,
  submitPlanRequestSchema,
  submitReviewRequestSchema,
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
  type PlanDecisionResponse,
  type PlanNode,
  type Project,
  type ProjectId,
  type ProjectState,
  type PullRequestFacts,
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
import { validateFileOwnership } from './plan-validation.js';

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
  /** Prepended to the first delivery only; the stored user prompt is unchanged. */
  orchestratorPrompt?: (ctx: { project: Project; session: Session }) => string;
  /** Cross reviews are opt-in outside the daemon composition. */
  crossReview?: boolean;
  /** Scratch directories live at <dataDir or tmpdir>/reviews/<sessionId>. */
  dataDir?: string;
  reviewerPrompt?: (ctx: {
    project: Project;
    worker: Session;
    reviewer: Session;
    pr: PullRequestFacts;
    node?: PlanNode;
  }) => string;
  /** Process environment additions evaluated for each launch, including resumes. */
  sessionEnv?: (ctx: { project: Project; session: Session }) => Record<string, string> | undefined;
  limits?: { maxTurnsPerTask?: number; maxParallelWorkers?: number };
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
type Recheck = {
  cause: EventSeq;
  attempts: number;
  resolved?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
const RESUME_SCOPE = 'helix:core:resume:v1';
const DELIVERY_SCOPE = 'helix:core:delivered:v1';
const MESSAGE_SCOPE = 'helix:core:message:v1';
const TURN_SCOPE = 'helix:core:turn:v1';
const EXTENSION_SCOPE = 'helix:core:turn-extension:v1';
const SCHEDULING_SCOPE = 'helix:core:scheduling-paused:v1';
const EXTENSION_PREFIX = 'Turn allowance extended to ';
const META_HASH = 'v1';
const REVIEW_REMINDER = 'Submit your verdict with `helix review submit`';
const submitCommand = (headSha: string) => `helix review submit verdict.json --head ${headSha}`;

/** A single writer owns domain commands and adapter callbacks. State is only a replay cache. */
export function createHelixCore(deps: CoreDeps): HelixCore {
  const { maxTurnsPerTask = 20, maxParallelWorkers = 3 } = deps.limits ?? {};
  for (const [name, value] of Object.entries({ maxTurnsPerTask, maxParallelWorkers }))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new HelixError('INVALID_REQUEST', `${name} must be a positive integer`);
  const states = new Map<ProjectId, ProjectState>();
  const history = new Map<ProjectId, HelixEvent[]>();
  const runtimes = new Map<SessionId, Runtime>();
  const watchers = new Map<SessionId, Unsubscribe>();
  const rechecks = new Map<SessionId, Recheck>();
  const refreshing = new Map<SessionId, Promise<void>>();
  const mergeBatches = new Map<
    ProjectId,
    { merges: HelixEvent<'pr.merged'>[]; timer: ReturnType<typeof setTimeout> }
  >();
  const held = new Map<SessionId, Delivery[]>();
  const resumes = new Map<SessionId, string>();
  const seenFeedback = new Set<string>();
  const attempts = new Map<string, number>();
  const escalated = new Set<string>();
  const turnLimits = new Map<SessionId, number>();
  const turnReceipts = new Set<EventSeq>();
  const extendedMessages = new Set<EventSeq>();
  const cappedDeliveries = new Set<EventSeq>();
  const waitingNodes = new Set<string>();
  const pausedProjects = new Set<ProjectId>();
  let tail = Promise.resolve();
  let loaded = false;
  let started = false;
  let closing = false;
  let shutdownRequested = false;
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
  function background(sessionId: SessionId, work: () => void | Promise<void>): void {
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
  async function readMeta(scope: string, key: string) {
    const value = await deps.store.getMeta(scope, key);
    if (value !== undefined) return value;
    const legacy = await deps.store.recall(scope, key, META_HASH);
    if (legacy === true || typeof legacy === 'string') {
      await deps.store.setMeta(scope, key, legacy);
      return legacy;
    }
    return undefined;
  }
  async function emit<T extends EventType>(
    type: T,
    payload: PayloadFor<T>,
    ctx: Context,
  ): Promise<HelixEvent<T>> {
    // Notes core writes itself are Helix's recorded facts; `explain` sets agent/orchestrator.
    const body =
      type === 'explain.note' && !('source' in (payload as object))
        ? { ...(payload as PayloadFor<'explain.note'>), source: 'helix' as const }
        : payload;
    // The generic pair is correlated at each call; TS cannot distribute generic object construction.
    const input = { v: 1, ts: deps.clock(), ...ctx, type, payload: body } as UnsequencedEvent;
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
      const scheduling = recovered.events.findLast((e) => e.type === 'scheduling.changed');
      // Older logs have no scheduling event; keep recovering their persisted pause metadata.
      const paused =
        scheduling?.type === 'scheduling.changed'
          ? scheduling.payload.paused
          : await deps.store.getMeta(SCHEDULING_SCOPE, p.id);
      if (paused) pausedProjects.add(p.id);
      const heads = new Map<SessionId, string>();
      for (const e of recovered.events) {
        if (e.type === 'explain.note' && e.sessionId) {
          // Text fallback preserves recovery of logs written before structured guardrails.
          if (
            (e.payload.code === 'turn_limit_reached' ||
              (e.payload.code === undefined &&
                e.payload.text.startsWith('Turn limit reached ('))) &&
            e.causedBy
          )
            cappedDeliveries.add(e.causedBy);
        }
        if (
          e.type === 'chat.item' &&
          e.sessionId &&
          e.payload.item.kind === 'message' &&
          e.payload.item.role === 'user'
        ) {
          const limit = await deps.store.getMeta(EXTENSION_SCOPE, String(e.seq));
          if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0) {
            turnLimits.set(e.sessionId, Math.max(turnLimit(e.sessionId), limit));
            extendedMessages.add(e.seq);
          }
        }
        if (e.type === 'plan.node_updated') {
          const key = JSON.stringify([p.id, e.payload.nodeId]);
          // Text fallback preserves recovery of logs written before structured guardrails.
          if (
            !e.payload.sessionId &&
            (e.payload.waiting === 'worker_slot' ||
              (e.payload.waiting === undefined && e.payload.note?.startsWith('Waiting: ')))
          )
            waitingNodes.add(key);
          else waitingNodes.delete(key);
        }
        if (e.type === 'session.created' && e.payload.session.planNodeId)
          waitingNodes.delete(JSON.stringify([p.id, e.payload.session.planNodeId]));
        if (await deps.store.getMeta(TURN_SCOPE, String(e.seq))) turnReceipts.add(e.seq);
        if ((e.type === 'pr.opened' || e.type === 'pr.updated') && e.sessionId)
          heads.set(e.sessionId, e.payload.pr.headSha);
        if (e.type === 'feedback.routed') {
          const s = session(e.payload.toSessionId).session;
          const key = reasonKey(s, e.payload.prNumber, e.payload.reason);
          attempts.set(key, (attempts.get(key) ?? 0) + 1);
          seenFeedback.add(
            feedbackKey(s, e.payload.prNumber, e.payload.reason, heads.get(s.id) ?? 'unknown'),
          );
          if (!(await readMeta(DELIVERY_SCOPE, String(e.seq))))
            hold(s.id, { text: e.payload.summary, mode: 'queue', cause: e.seq, automatic: true });
        }
        if (
          e.type === 'chat.item' &&
          e.sessionId &&
          e.payload.item.kind === 'message' &&
          e.payload.item.role === 'user' &&
          !(await readMeta(DELIVERY_SCOPE, String(e.seq)))
        ) {
          // Receipts cannot make harness delivery exactly-once without an adapter ack.
          const mode = await readMeta(MESSAGE_SCOPE, String(e.seq));
          hold(e.sessionId, {
            text: e.payload.item.text,
            mode: mode === 'interrupt' ? 'interrupt' : 'queue',
            cause: e.seq,
          });
        }
      }
      for (const s of Object.values(project(p.id).sessions)) {
        const latest = await deps.store.getMeta(RESUME_SCOPE, s.session.id);
        if (typeof latest === 'string') {
          resumes.set(s.session.id, latest);
          continue;
        }
        if (latest !== undefined) continue;
        // Read through pre-metadata tokens, newest event first, then migrate once.
        for (const e of [...eventsFor(s.session)].reverse()) {
          const token = await deps.store.recall(
            RESUME_SCOPE,
            `${s.session.id}:${e.seq}`,
            META_HASH,
          );
          if (typeof token === 'string') {
            await deps.store.setMeta(RESUME_SCOPE, s.session.id, token);
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
  async function saveResume(id: SessionId): Promise<void> {
    const token = runtimes.get(id)?.handle?.resumeToken;
    if (token && token !== resumes.get(id)) {
      await deps.store.setMeta(RESUME_SCOPE, id, token);
      resumes.set(id, token);
    }
  }
  async function deliver(id: SessionId, delivery: Delivery): Promise<void> {
    const s = session(id);
    const runtime = runtimes.get(id);
    if (s.session.role === 'reviewer') {
      const trigger = eventsFor(s.session).find((e) => e.seq === delivery.cause);
      if (
        trigger?.type === 'agent_review.requested' ||
        (trigger?.type === 'explain.note' && trigger.payload.text.startsWith(REVIEW_REMINDER))
      ) {
        const pending = pendingReview(s.session);
        if (!pending || delivery.cause < pending.request.seq) return;
      }
    }
    if (delivery.automatic && s.pr?.state !== 'open') return;
    if (s.session.archivedAt || s.activity === 'exited' || runtime?.stopped) return;
    if (blocked(s) || !runtime?.handle) {
      hold(id, delivery);
      return;
    }
    if (runtime.turnOpen) {
      if (runtime.awaitingInput && !delivery.automatic) {
        await runtime.handle.send(delivery.text, delivery.mode);
        await deps.store.setMeta(DELIVERY_SCOPE, String(delivery.cause), true);
        return;
      }
      hold(id, delivery);
      // The old turn retains its cause through cancellation and end-of-turn shipping.
      if (delivery.mode === 'interrupt') await runtime.handle.interrupt();
      return;
    }
    if (
      s.session.role === 'worker' &&
      runtime.turnNumber >= turnLimit(id) &&
      !delivery.automatic &&
      !extendedMessages.has(delivery.cause)
    ) {
      const trigger = eventsFor(s.session).find((e) => e.seq === delivery.cause);
      if (
        trigger?.type === 'chat.item' &&
        trigger.payload.item.kind === 'message' &&
        trigger.payload.item.role === 'user'
      ) {
        const limit = turnLimit(id) + maxTurnsPerTask;
        await deps.store.setMeta(EXTENSION_SCOPE, String(delivery.cause), limit);
        extendedMessages.add(delivery.cause);
        turnLimits.set(id, limit);
        await emit(
          'explain.note',
          {
            text: `${EXTENSION_PREFIX}${limit} turns by user message.`,
            code: 'turn_limit_extended',
          },
          context(s.session, delivery.cause),
        );
      }
    }
    if (s.session.role === 'worker' && runtime.turnNumber >= turnLimit(id)) {
      hold(id, delivery);
      if (!cappedDeliveries.has(delivery.cause)) {
        await emit(
          'explain.note',
          {
            text: `Turn limit reached (${turnLimit(id)} turns). Helix paused this task; send a message to continue for another ${maxTurnsPerTask}.`,
            code: 'turn_limit_reached',
          },
          context(s.session, delivery.cause),
        );
        cappedDeliveries.add(delivery.cause);
      }
      await emit(
        'activity.changed',
        { activity: 'waiting_input' },
        context(s.session, delivery.cause),
      );
      return;
    }
    runtime.cause = delivery.cause;
    runtime.turnOpen = true;
    runtime.turnNumber++;
    delete runtime.lastAssistantMessage;
    try {
      await runtime.handle.send(delivery.text, 'queue');
      // Backstop recovery when the daemon dies before an adapter publishes active.
      await deps.store.setMeta(TURN_SCOPE, String(delivery.cause), true);
      turnReceipts.add(delivery.cause);
      await deps.store.setMeta(DELIVERY_SCOPE, String(delivery.cause), true);
      await saveResume(id);
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
    while (queue.length && !runtimes.get(id)?.turnOpen) {
      const delivery = queue.shift()!;
      await deliver(id, delivery);
      // A capped delivery was put back; leave it held until human continuation.
      const requeued = queue.findIndex((d) => d.cause === delivery.cause);
      if (requeued !== -1) {
        queue.splice(requeued, 1);
        queue.unshift(delivery);
        break;
      }
    }
    if (!queue.length) held.delete(id);
  }
  function turnLimit(id: SessionId): number {
    return turnLimits.get(id) ?? maxTurnsPerTask;
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
        const exited = await emit('session.exited', { code }, context(s.session, rt?.cause));
        if (rt) {
          rt.stopped = true;
          rt.attachment?.detach();
        }
        await schedule(s.session.projectId, exited.seq);
      }),
    );
  }
  function sessionEnv(s: Session): Record<string, string> | undefined {
    return deps.sessionEnv?.({ project: project(s.projectId).project, session: s });
  }
  function initialPrompt(s: Session): string {
    return s.role === 'orchestrator' && deps.orchestratorPrompt
      ? `${deps.orchestratorPrompt({ project: project(s.projectId).project, session: s })}\n\n${s.prompt}`
      : s.prompt;
  }
  function pendingReview(reviewer: Session) {
    const worker = reviewer.parentSessionId ? findSession(reviewer.parentSessionId) : undefined;
    const review = worker?.agentReview;
    if (review?.status !== 'reviewing' || review.reviewerSessionId !== reviewer.id) return;
    const request = eventsFor(reviewer).findLast(
      (e): e is HelixEvent<'agent_review.requested'> =>
        e.type === 'agent_review.requested' && e.payload.headSha === review.headSha,
    );
    return request && worker ? { worker, review, request } : undefined;
  }
  function reviewMessage(reviewer: Session, request: HelixEvent<'agent_review.requested'>): string {
    const worker = session(request.payload.workerSessionId);
    const p = project(worker.session.projectId);
    const node = Object.values(p.plans)
      .flatMap((plan) => plan.nodes)
      .find((n) => n.id === worker.session.planNodeId);
    const previous = eventsFor(reviewer).findLast(
      (e) => e.type === 'agent_review.submitted' && e.seq < request.seq,
    );
    const instructions = (deps.reviewerPrompt ?? defaultReviewerPrompt)({
      project: p.project,
      worker: worker.session,
      reviewer,
      pr: worker.pr!,
      ...(node ? { node } : {}),
    });
    // Exact paths and the exact submit line: Helix only answers literal commands without asking,
    // and a reviewer's shell starts in its scratch folder, not in the worktree it reviews.
    const where = worker.worktree
      ? `\nWorktree under review (read-only): ${worker.worktree.path}. Read it with \`git -C "${worker.worktree.path}" …\` or by reading files there.`
      : '';
    return `${instructions}\n\nRequested head: ${request.payload.headSha}. One verdict for this request.${where}\nWhen done, write verdict.json in your scratch folder and run exactly: ${submitCommand(request.payload.headSha)}${previous?.type === 'agent_review.submitted' ? `\nRe-review: the worker pushed changes since ${previous.payload.headSha}. Inspect git diff ${previous.payload.headSha}...${request.payload.headSha} and verify the previous findings are resolved:\n${JSON.stringify(previous.payload.review)}` : ''}`;
  }
  async function abandonReview(reviewer: Session, reason: string, cause?: EventSeq): Promise<void> {
    const pending = pendingReview(reviewer);
    if (!pending) return;
    const e = await emit(
      'agent_review.abandoned',
      { ...pending.request.payload, reason },
      context(reviewer, cause ?? pending.request.seq),
    );
    held.delete(reviewer.id);
    await emit(
      'explain.note',
      {
        text: `${reason} This PR now relies on CI and GitHub review.`,
      },
      context(pending.worker.session, e.seq),
    );
  }
  async function stopReviewers(worker: Session, reason: string, cause?: EventSeq): Promise<void> {
    for (const s of Object.values(project(worker.projectId).sessions)) {
      if (s.session.role !== 'reviewer' || s.session.parentSessionId !== worker.id) continue;
      await abandonReview(s.session, reason, cause);
      if (
        s.activity !== 'exited' &&
        runtimes.get(s.session.id)?.handle &&
        !runtimes.get(s.session.id)?.stopped
      )
        await stop(s.session.id);
    }
  }
  async function reviewFallback(
    worker: SessionState,
    reason: string,
    cause: EventSeq,
    noteWithoutReview = false,
  ): Promise<void> {
    const review = worker.agentReview;
    const stale = review && worker.pr && review.headSha !== worker.pr.headSha;
    let noteCause = cause;
    if (stale) {
      const reviewer = session(review.reviewerSessionId).session;
      const abandoned = await emit(
        'agent_review.abandoned',
        {
          workerSessionId: worker.session.id,
          prNumber: worker.pr!.number,
          headSha: review.headSha,
          reason,
        },
        context(reviewer, cause),
      );
      held.delete(reviewer.id);
      noteCause = abandoned.seq;
    }
    const text = `${reason} This PR now relies on CI and human review.`;
    if (
      stale ||
      (noteWithoutReview &&
        !eventsFor(worker.session).some(
          (e) => e.type === 'explain.note' && e.payload.text === text,
        ))
    )
      await emit('explain.note', { text }, context(worker.session, noteCause));
  }
  async function requestReview(id: SessionId, cause: EventSeq): Promise<void> {
    const worker = session(id);
    const pr = worker.pr;
    if (
      closing ||
      shutdownRequested ||
      pausedProjects.has(worker.session.projectId) ||
      worker.session.role !== 'worker' ||
      worker.session.archivedAt ||
      worker.activity === 'exited' ||
      runtimes.get(id)?.stopped ||
      !worker.worktree ||
      pr?.state !== 'open' ||
      !pr.checks.total ||
      pr.checks.failed ||
      pr.checks.pending
    )
      return;
    // A verdict or request for this exact head stands, even if policy/availability changes.
    if (worker.agentReview?.headSha === pr.headSha) return;
    if (!deps.crossReview) {
      await reviewFallback(worker, 'Cross-agent review is turned off.', cause);
      return;
    }
    const p = project(worker.session.projectId);
    const agent = crossReviewerFor(worker.session.agent);
    let available = false;
    try {
      available =
        !!agent &&
        !!deps.harnesses[agent] &&
        (await detectHarnesses()).some(
          (h) => h.agent === agent && h.installed && h.signedIn !== false,
        );
    } catch {
      /* Detection failure is also unavailability; never substitute the worker's agent. */
    }
    if (!agent || !available) {
      await reviewFallback(
        worker,
        `No cross-agent reviewer is available (${agent ?? worker.session.agent} is not configured, installed or signed in); Helix never lets an agent review its own work.`,
        cause,
        true,
      );
      return;
    }
    // Includes abandoned requests: fallback must not become an endless retry loop on this head.
    if (
      (history.get(p.project.id) ?? []).some(
        (e) =>
          e.type === 'agent_review.requested' &&
          e.payload.workerSessionId === id &&
          e.payload.headSha === pr.headSha,
      )
    )
      return;
    let reviewer = Object.values(p.sessions).findLast(
      (s) =>
        s.session.role === 'reviewer' &&
        s.session.parentSessionId === id &&
        s.session.agent === agent &&
        !s.session.archivedAt &&
        s.activity !== 'exited' &&
        !runtimes.get(s.session.id)?.stopped,
    )?.session;
    if (reviewer) await abandonReview(reviewer, 'The PR moved on to a new head.', cause);
    if (!reviewer) {
      const reviewerId = validate(sessionIdSchema, deps.ids('session'));
      reviewer = {
        id: reviewerId,
        projectId: p.project.id,
        role: 'reviewer',
        agent,
        parentSessionId: id,
        title: `Review: ${worker.session.title}`,
        interface: 'chat',
        prompt: `Review PR #${pr.number} against the worker task and acceptance criteria.`,
        worktreePath: path.resolve(deps.dataDir ?? tmpdir(), 'reviews', reviewerId),
        createdAt: deps.clock(),
      };
      await mkdir(reviewer.worktreePath!, { recursive: true });
      const created = await emit(
        'session.created',
        { session: reviewer },
        context(reviewer, cause),
      );
      await emit('session.started', {}, context(reviewer, created.seq));
    }
    try {
      if (!runtimes.get(reviewer.id)?.handle) await launch(reviewer, cause, false, false);
    } catch (error) {
      deps.log.error('Could not start cross-agent review', error);
      await reviewFallback(worker, 'The cross-agent reviewer could not start.', cause, true);
      return;
    }
    const requested = await emit(
      'agent_review.requested',
      {
        workerSessionId: id,
        prNumber: pr.number,
        headSha: pr.headSha,
      },
      context(reviewer, cause),
    );
    try {
      await deliver(reviewer.id, {
        text: reviewMessage(reviewer, requested),
        mode: 'queue',
        cause: requested.seq,
      });
    } catch (error) {
      deps.log.error('Could not start cross-agent review', error);
      await abandonReview(reviewer, 'The reviewer could not start.', requested.seq);
    }
  }
  async function launch(
    s: Session,
    cause: EventSeq,
    resume: boolean,
    sendInitial = !resume,
  ): Promise<void> {
    const events = eventsFor(s);
    const deliveryCauses = new Set(
      events
        .filter(
          (e) =>
            e.type === 'session.started' ||
            e.type === 'feedback.routed' ||
            (e.type === 'chat.item' &&
              e.payload.item.kind === 'message' &&
              e.payload.item.role === 'user'),
        )
        .map((e) => e.seq),
    );
    const turnNumber = new Set(
      events
        .filter(
          (e) =>
            e.type === 'activity.changed' &&
            (e.payload.activity === 'active' || e.payload.activity === 'idle') &&
            e.causedBy !== undefined &&
            deliveryCauses.has(e.causedBy),
        )
        .map((e) => e.causedBy)
        .concat(events.filter((e) => turnReceipts.has(e.seq)).map((e) => e.seq)),
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
        } else if (!deps.terminals.list().includes(s.id)) {
          const options = { ...(await terminalOptions(s)) };
          const additions = sessionEnv(s);
          if (additions) {
            const env = { ...options.env };
            for (const [key, value] of Object.entries(additions)) {
              if (process.platform === 'win32')
                for (const existing of Object.keys(env))
                  if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
              env[key] = value;
            }
            options.env = env;
          }
          await deps.terminals.spawn(s.id, options);
        }
        runtime.attachment = await deps.terminals.attach(s.id, () => {
          /* Terminal bytes are not domain activity. */
        });
        if (!resume && sendInitial) {
          // Bracketed paste preserves multiline prompts in interactive CLIs and .cmd shims.
          runtime.attachment.write(
            `\x1b[200~${initialPrompt(s).replace(/\r\n/g, '\n')}\x1b[201~\r`,
          );
        }
        await emit('activity.changed', { activity: 'active' }, context(s, cause));
        return;
      }
      const token = resumes.get(s.id);
      const env = sessionEnv(s);
      const reviewedWorker =
        s.role === 'reviewer' && s.parentSessionId ? session(s.parentSessionId) : undefined;
      if (s.role === 'reviewer') {
        if (!reviewedWorker?.worktree)
          throw new HelixError('INVALID_REQUEST', 'Reviewer has no worker worktree');
        await mkdir(s.worktreePath!, { recursive: true });
      }
      runtime.handle = await harnessFor(s.agent).start({
        session: s,
        cwd: s.worktreePath!,
        ...(env ? { env } : {}),
        ...(token ? { resumeToken: token } : {}),
        ...(reviewedWorker?.worktree
          ? { review: { worktreePath: reviewedWorker.worktree.path } }
          : {}),
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
      await saveResume(s.id);
      if (sendInitial) {
        await deliver(s.id, { text: initialPrompt(s), mode: 'queue', cause });
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
      if (s.role === 'reviewer')
        await abandonReview(s, 'The reviewer failed to start or resume.', cause);
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
    await saveResume(id);
    if (emission.type === 'activity.changed') {
      if (
        before.session.role === 'reviewer' &&
        ['unknown', 'exited'].includes(emission.payload.activity)
      )
        await abandonReview(
          before.session,
          'The reviewer failed or exited without a verdict.',
          e.seq,
        );
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
        const exited = await emit('session.exited', { code: null }, context(before.session, e.seq));
        await schedule(before.session.projectId, exited.seq);
      } else await flush(id);
    }
    armWatchdog(id);
  }
  async function endTurn(id: SessionId, cause: EventSeq): Promise<void> {
    let s = session(id);
    if (s.session.role === 'reviewer') {
      const pending = pendingReview(s.session);
      if (!pending) return;
      if (runtimes.get(id)!.cause < pending.request.seq) return;
      const reminder = eventsFor(s.session).find(
        (e) =>
          e.type === 'explain.note' &&
          e.causedBy === pending.request.seq &&
          e.payload.text.startsWith(REVIEW_REMINDER),
      );
      if (reminder)
        await abandonReview(s.session, 'The reviewer ended two turns without a verdict.', cause);
      else {
        const text = `${REVIEW_REMINDER}: from your scratch folder, run exactly \`${submitCommand(pending.review.headSha)}\` (no variables or command substitution).`;
        const e = await emit('explain.note', { text }, context(s.session, pending.request.seq));
        hold(id, { text, mode: 'queue', cause: e.seq });
      }
      return;
    }
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
  function cancelRecheck(id: SessionId): void {
    clearTimeout(rechecks.get(id)?.timer);
    rechecks.delete(id);
  }
  function canRecheck(id: SessionId): boolean {
    const s = session(id);
    return (
      !closing &&
      !shutdownRequested &&
      watchers.has(id) &&
      !s.session.archivedAt &&
      s.pr?.state === 'open'
    );
  }
  function refreshPr(id: SessionId, job: Recheck): void {
    if (rechecks.get(id) !== job) return;
    if (!canRecheck(id) || job.resolved) {
      cancelRecheck(id);
      return;
    }
    job.attempts++;
    const s = session(id);
    // Keep network I/O outside the writer queue so shutdown can unsubscribe and abort it.
    // A later merge must get a read started after that merge, even if an older refresh is slow.
    const pending = Promise.resolve(refreshing.get(id))
      .then(() => {
        if (canRecheck(id) && rechecks.get(id) === job)
          return deps.scm!.refresh!(project(s.session.projectId).project, s.pr!.number);
      })
      .catch((error: unknown) => deps.log.error('Post-merge PR refresh failed', error));
    refreshing.set(id, pending);
    void pending.finally(() => {
      if (refreshing.get(id) === pending) refreshing.delete(id);
      background(id, () => {
        if (rechecks.get(id) !== job) return;
        if (!canRecheck(id) || job.resolved || job.attempts >= 4) {
          cancelRecheck(id);
          return;
        }
        // Watch callbacks are queued before refresh resolves; inspect their latest result.
        job.timer = setTimeout(() => refreshPr(id, job), 20_000);
        job.timer.unref();
      });
    });
  }
  function recheckAfterMerge(merged: HelixEvent<'pr.merged'>): void {
    if (!deps.scm?.refresh || closing || shutdownRequested) return;
    const pending = mergeBatches.get(merged.projectId);
    if (pending) {
      pending.merges.push(merged);
      return;
    }
    const merges = [merged];
    const timer = setTimeout(() => {
      background(merged.sessionId!, async () => {
        mergeBatches.delete(merged.projectId);
        if (closing || shutdownRequested) return;
        const latest = merges.at(-1)!;
        for (const s of Object.values(project(merged.projectId).sessions)) {
          const id = s.session.id;
          if (!canRecheck(id)) continue;
          cancelRecheck(id);
          const note = await emit(
            'explain.note',
            {
              text: `Re-checking PR #${s.pr!.number} after ${merges.map((e) => `PR #${e.payload.prNumber} merged (event #${e.seq})`).join(', ')}.`,
            },
            context(s.session, latest.seq),
          );
          const job: Recheck = { cause: note.seq, attempts: 0 };
          rechecks.set(id, job);
          refreshPr(id, job);
        }
      });
    }, 250);
    timer.unref();
    mergeBatches.set(merged.projectId, { merges, timer });
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
        const observationCause =
          emission.type === 'pr.updated' ? (rechecks.get(id)?.cause ?? cause) : cause;
        background(id, async () => {
          await onScm(id, copy, observationCause);
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
    const recheck = rechecks.get(id);
    if (emission.type === 'pr.updated' && recheck && recheck.cause === cause)
      recheck.resolved =
        emission.payload.pr.state !== 'open' || emission.payload.pr.mergeable !== 'unknown';
    if (session(id).pr?.state !== 'open')
      await stopReviewers(s.session, 'The worker PR was closed or merged.', e.seq);
    if (emission.type === 'pr.merged') {
      cancelRecheck(id);
      watchers.get(id)?.();
      watchers.delete(id);
      recheckAfterMerge(e as HelixEvent<'pr.merged'>);
      await schedule(s.session.projectId, e.seq);
    } else if (emission.type === 'pr.updated' && emission.payload.pr.state === 'closed') {
      cancelRecheck(id);
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
    if (emission.type === 'ci.updated') await requestReview(id, e.seq);
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
    const summary =
      reason === 'review_findings'
        ? details!
        : deps.buildFeedbackMessage({ reason, pr, ...(details ? { details } : {}) });
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
      // Every task starts from the remote's default branch: the user's local branch may be behind
      // merges made on GitHub (including merges from earlier Helix tasks).
      let base = p.defaultBranch;
      try {
        base = await deps.worktrees.fetchBase(p.repoPath, p.defaultBranch);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (prerequisites.length) {
          await emit(
            'explain.note',
            {
              text: `Cannot start dependent worker: fetching origin/${p.defaultBranch} failed: ${reason}`,
            },
            context(s, cause),
          );
          await emit('activity.changed', { activity: 'waiting_input' }, context(s, cause));
          return s;
        }
        // Independent work can still start offline, from the local branch.
        await emit(
          'explain.note',
          {
            text: `Could not fetch origin/${p.defaultBranch} (${reason}); starting from the local ${p.defaultBranch}, which may be behind.`,
          },
          context(s, cause),
        );
      }
      if (prerequisites.length) {
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
      const delivered = await readMeta(DELIVERY_SCOPE, String(start.seq));
      await launch(s, start.seq, false, !delivered);
    }
    await deps.store.remember(`${scope}:result`, key, hash, s);
    return structuredClone(s);
  }
  async function schedule(projectId: ProjectId, cause: EventSeq): Promise<void> {
    if (closing || shutdownRequested || pausedProjects.has(projectId)) return;
    const p = project(projectId);
    const plans = Object.values(p.plans).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const plan of plans) {
      const legacyRunning =
        plan.status === 'awaiting_approval' && plan.nodes.some((node) => node.sessionId);
      if (plan.status !== 'approved' && !legacyRunning) continue;
      const approval = (history.get(projectId) ?? []).find(
        (e) => e.type === 'plan.approved' && e.payload.planId === plan.id,
      );
      for (const node of plan.nodes) {
        if (
          node.sessionId &&
          (session(node.sessionId).worktree ||
            session(node.sessionId).session.archivedAt ||
            session(node.sessionId).activity === 'exited')
        )
          continue;
        const merges = node.dependsOn.map((id) => {
          const dep = plan.nodes.find((n) => n.id === id);
          return dep?.sessionId
            ? eventsFor(session(dep.sessionId).session).find((e) => e.type === 'pr.merged')
            : undefined;
        });
        if (merges.some((e) => !e)) continue;
        const waitingKey = JSON.stringify([projectId, node.id]);
        const occupied = Object.values(project(projectId).sessions).filter(
          (s) =>
            s.session.role === 'worker' &&
            !s.session.archivedAt &&
            s.activity !== 'exited' &&
            eventsFor(s.session).some((e) => e.type === 'session.started') &&
            !eventsFor(s.session).some((e) => e.type === 'pr.merged'),
        ).length;
        if (occupied >= maxParallelWorkers) {
          if (!waitingNodes.has(waitingKey)) {
            await emit(
              'plan.node_updated',
              {
                nodeId: node.id,
                note: `Waiting: ${occupied} of ${maxParallelWorkers} worker slots are in use.`,
                waiting: 'worker_slot',
              },
              {
                ...context(session(plan.orchestratorSessionId).session, cause),
                planNodeId: node.id,
              },
            );
            waitingNodes.add(waitingKey);
          }
          continue;
        }
        const wasWaiting = waitingNodes.delete(waitingKey);
        const unblockedBy =
          (wasWaiting ? cause : undefined) ||
          merges.reduce((latest, e) => (e && e.seq > latest ? e.seq : latest), 0 as EventSeq) ||
          approval?.seq ||
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
  }
  async function stop(id: SessionId): Promise<void> {
    const s = session(id);
    if (!closing) {
      if (s.session.role === 'reviewer')
        await abandonReview(s.session, 'The reviewer was stopped.');
      else await stopReviewers(s.session, 'The worker was stopped.');
    }
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
    // Daemon shutdown preserves the review request for conversation recovery at next startup.
    if (closing && s.session.role === 'reviewer') return;
    const exited = await emit('session.exited', { code: null }, context(s.session, rt?.cause));
    await schedule(s.session.projectId, exited.seq);
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
              if (s.session.role === 'reviewer') {
                const pending = pendingReview(s.session);
                if (
                  pending &&
                  (pausedProjects.has(p.project.id) ||
                    pending.worker.session.archivedAt ||
                    pending.worker.pr?.state !== 'open')
                ) {
                  await abandonReview(
                    s.session,
                    'Review cannot resume because the worker is no longer scheduled.',
                    last.seq,
                  );
                  continue;
                }
                if (pending) {
                  const reminder = eventsFor(s.session).findLast(
                    (e) =>
                      e.type === 'explain.note' &&
                      e.causedBy === pending.request.seq &&
                      e.payload.text.startsWith(REVIEW_REMINDER),
                  );
                  // Resume the interrupted request, never append a second requested event.
                  hold(s.session.id, {
                    text: reviewMessage(s.session, pending.request),
                    mode: 'queue',
                    cause: reminder?.seq ?? pending.request.seq,
                  });
                }
                await launch(s.session, last.seq, true, false);
              } else if (!s.worktree)
                await emit(
                  'activity.changed',
                  { activity: 'unknown' },
                  context(s.session, last.seq),
                );
              else {
                const initial = eventsFor(s.session).find((e) => e.type === 'session.started');
                const delivered = initial && (await readMeta(DELIVERY_SCOPE, String(initial.seq)));
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
    shutdown: () => {
      // Suppress scheduling even for exit callbacks already ahead of shutdown in the queue.
      shutdownRequested = true;
      for (const batch of mergeBatches.values()) clearTimeout(batch.timer);
      mergeBatches.clear();
      for (const id of rechecks.keys()) cancelRecheck(id);
      return enqueue(async () => {
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
      });
    },
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
        const before = history.get(id)?.at(-1)?.seq ?? 0;
        const created = await create(project(id).project, input, key);
        const creation = eventsFor(created).find((e) => e.type === 'session.created')!;
        if (pausedProjects.has(id) && creation.seq > before) {
          await emit(
            'scheduling.changed',
            { paused: false },
            { projectId: id, causedBy: creation.seq },
          );
          await deps.store.setMeta(SCHEDULING_SCOPE, id, false);
          pausedProjects.delete(id);
          await schedule(id, creation.seq);
        }
        return created;
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
        await deps.store.setMeta(MESSAGE_SCOPE, String(e.seq), input.mode);
        await deliver(id, { ...input, cause: e.seq });
      }),
    stopSession: (id) => command(() => stop(id)),
    stopAll: (id) =>
      command(async () => {
        const p = project(id);
        // Persist before stopping: exits and later SCM callbacks must not restart workers.
        await emit('scheduling.changed', { paused: true }, { projectId: id });
        await deps.store.setMeta(SCHEDULING_SCOPE, id, true);
        pausedProjects.add(id);
        const stopped: SessionId[] = [];
        const failures: unknown[] = [];
        const running = Object.values(p.sessions).filter((s) => {
          const rt = runtimes.get(s.session.id);
          return rt && !rt.stopped && s.activity !== 'exited' && !s.session.archivedAt;
        });
        for (const s of running) {
          try {
            await stop(s.session.id);
            stopped.push(s.session.id);
          } catch (error) {
            failures.push(error);
            deps.log.error(`Failed to stop ${s.session.id}`, error);
          }
        }
        if (failures.length)
          throw new HelixError('INTERNAL_ERROR', `Failed to stop ${failures.length} sessions`);
        return { stopped };
      }),
    archiveSession: (id) =>
      command(async () => {
        const s = session(id);
        if (s.session.archivedAt) return structuredClone(s.session);
        await stop(id);
        watchers.get(id)?.();
        watchers.delete(id);
        const archived = await emit('session.archived', {}, context(s.session));
        await schedule(s.session.projectId, archived.seq);
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
        const warnings = validateFileOwnership(input.nodes);
        const plan: Plan = {
          ...input,
          id: validate(planIdSchema, deps.ids('plan')),
          createdAt: deps.clock(),
        };
        const e = await emit('plan.submitted', { plan }, context(orchestrator.session));
        for (const text of warnings)
          await emit('explain.note', { text }, context(orchestrator.session, e.seq));
        const projected = project(input.projectId).plans[plan.id]!;
        return { ...plan, nodes: structuredClone(projected.nodes) };
      }),
    decidePlan: (id, request) =>
      command<PlanDecisionResponse>(async () => {
        const planId = validate(planIdSchema, id);
        const input = validate(planDecisionRequestSchema, request);
        const plan = [...states.values()]
          .flatMap((p) => Object.values(p.plans))
          .find((p) => p.id === planId);
        if (!plan) throw new HelixError('NOT_FOUND', 'Unknown plan');
        const status = input.decision === 'approve' ? 'approved' : 'rejected';
        const reason = input.reason ?? 'Rejected by human';
        if (plan.status !== 'awaiting_approval') {
          if (plan.status !== status || (status === 'rejected' && plan.rejectionReason !== reason))
            throw new HelixError('CONFLICT', 'Plan already decided');
          return { planId, status };
        }
        const submitted = (history.get(plan.projectId) ?? []).find(
          (e) => e.type === 'plan.submitted' && e.payload.plan.id === planId,
        );
        const ctx = context(session(plan.orchestratorSessionId).session, submitted?.seq);
        if (status === 'approved') {
          const approved = await emit('plan.approved', { planId, approvedBy: 'human' }, ctx);
          if (pausedProjects.has(plan.projectId))
            await emit(
              'scheduling.changed',
              { paused: false },
              { projectId: plan.projectId, causedBy: approved.seq },
            );
          await deps.store.setMeta(SCHEDULING_SCOPE, plan.projectId, false);
          pausedProjects.delete(plan.projectId);
          await schedule(plan.projectId, approved.seq);
        } else await emit('plan.rejected', { planId, reason }, ctx);
        return { planId, status };
      }),
    submitReview: (request) =>
      command(async () => {
        const input = validate(submitReviewRequestSchema, request);
        const reviewer = findSession(input.reviewerSessionId);
        if (
          !reviewer ||
          reviewer.session.role !== 'reviewer' ||
          reviewer.session.archivedAt ||
          reviewer.activity === 'exited'
        )
          throw new HelixError('INVALID_REQUEST', 'A live reviewer session is required');
        const pending = pendingReview(reviewer.session);
        if (
          !pending ||
          pending.review.headSha !== input.headSha ||
          pending.worker.pr?.headSha !== input.headSha ||
          pending.worker.pr.state !== 'open'
        )
          throw new HelixError('INVALID_REQUEST', 'The PR moved on; review the new head');
        const e = await emit(
          'agent_review.submitted',
          {
            ...pending.request.payload,
            review: input.review,
          },
          context(reviewer.session, pending.request.seq),
        );
        held.delete(reviewer.session.id);
        if (input.review.verdict === 'request_changes') {
          const name = reviewer.session.agent === 'claude-code' ? 'Claude Code' : 'Codex';
          const oneLine = (text: string) => text.trim().replace(/\s+/g, ' ');
          const summary = [
            `${name} reviewed PR #${pending.worker.pr.number} and requested changes:`,
            ...input.review.findings.map(
              (f) =>
                `[${f.severity}] ${oneLine(f.title)}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}: ${oneLine(f.detail)}`,
            ),
          ]
            .join('\n')
            .slice(0, 2500);
          await feedback(pending.worker.session.id, 'review_findings', e.seq, summary);
        }
        return e;
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
          // The caller never chooses the source: it is the calling session's role.
          { text: input.text, source: s.role === 'orchestrator' ? 'orchestrator' : 'agent' },
          {
            ...context(s, input.causedBy),
            ...(input.planNodeId ? { planNodeId: input.planNodeId } : {}),
          },
        );
      }),
    recordNote: (id, text) =>
      command(async () => {
        const s = session(validate(sessionIdSchema, id)).session;
        if (typeof text !== 'string' || !text.trim())
          throw new HelixError('INVALID_REQUEST', 'Note text is required');
        return emit('explain.note', { text, source: 'helix' }, context(s));
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
