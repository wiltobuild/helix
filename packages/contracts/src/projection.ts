import type {
  AgentActivity,
  Approval,
  ChatItem,
  Plan,
  Project,
  PullRequestFacts,
  Session,
} from './entities.js';
import type { ApprovalId, PlanId, PlanNodeId, SessionId } from './ids.js';
import { parseEvent, type EventType, type HelixEvent, type PayloadFor } from './events.js';
import { deriveStatus, type DisplayStatus } from './status.js';

export type Worktree = PayloadFor<'worktree.created'>;
export type WorktreeState = Worktree & { diff?: PayloadFor<'worktree.diff_updated'> };
export type SessionState = {
  session: Session;
  activity: AgentActivity;
  pr?: PullRequestFacts;
  worktree?: WorktreeState;
  chat: ChatItem[];
  lastEventSeq: number;
  pendingApprovalIds: ApprovalId[];
};
export type ProjectState = {
  project: Project;
  sessions: Record<SessionId, SessionState>;
  plans: Record<PlanId, Plan & { nodeStatus: Record<PlanNodeId, DisplayStatus> }>;
  approvals: Record<ApprovalId, Approval>;
  lastSeq: number;
  anomalies: Anomaly[];
};
export type Anomaly = { seq: number; type: EventType; reason: string };
export type ProjectionOptions = { strict?: boolean };
export type Projector = { at(seq: number): ProjectState };
type PreparedEvent = { event: HelixEvent; error: string | undefined };

function prepareEvent(event: HelixEvent): PreparedEvent {
  const parsed = parseEvent(event);
  return parsed.success
    ? { event: parsed.data, error: undefined }
    : { event: { ...event }, error: parsed.error.message };
}
function sessionFor(state: ProjectState, id: SessionId | undefined): SessionState {
  if (id === undefined || !Object.hasOwn(state.sessions, id))
    throw new Error(`Unknown or missing session: ${id}`);
  return state.sessions[id]!;
}
function refreshNodes(state: ProjectState): void {
  for (const plan of Object.values(state.plans)) {
    plan.nodeStatus = Object.fromEntries(
      plan.nodes.map((node) => {
        const session =
          node.sessionId && Object.hasOwn(state.sessions, node.sessionId)
            ? state.sessions[node.sessionId]
            : undefined;
        return [node.id, session ? deriveStatus(session) : 'pending'];
      }),
    );
  }
}

function planForNode(state: ProjectState, id: PlanNodeId) {
  const plan = Object.values(state.plans).find((p) => p.nodes.some((n) => n.id === id));
  if (!plan) throw new Error('Unknown plan node');
  return plan;
}

/** Validate all references before mutation: skipped events must have no partial effects. */
function assertApplicable(state: ProjectState, e: HelixEvent): void {
  if (e.seq <= state.lastSeq) throw new Error('Event seq must increase');
  if (e.sessionId !== undefined && e.type !== 'session.created') sessionFor(state, e.sessionId);
  switch (e.type) {
    case 'project.added':
      throw new Error('Project already added');
    case 'session.created':
      if (
        e.payload.session.projectId !== state.project.id ||
        (e.sessionId !== undefined && e.sessionId !== e.payload.session.id)
      )
        throw new Error('Session identity mismatch');
      if (Object.hasOwn(state.sessions, e.payload.session.id))
        throw new Error('Session already exists');
      break;
    case 'approval.requested':
      sessionFor(state, e.payload.approval.sessionId);
      if (e.sessionId !== undefined && e.sessionId !== e.payload.approval.sessionId)
        throw new Error('Approval session mismatch');
      if (Object.hasOwn(state.approvals, e.payload.approval.id))
        throw new Error('Approval already exists');
      break;
    case 'approval.decided': {
      const approval = Object.hasOwn(state.approvals, e.payload.approvalId)
        ? state.approvals[e.payload.approvalId]
        : undefined;
      if (!approval) throw new Error('Unknown approval');
      sessionFor(state, approval.sessionId);
      if (e.sessionId !== undefined && e.sessionId !== approval.sessionId)
        throw new Error('Approval session mismatch');
      break;
    }
    case 'plan.submitted':
      if (e.payload.plan.projectId !== state.project.id) throw new Error('Plan project mismatch');
      if (Object.hasOwn(state.plans, e.payload.plan.id)) throw new Error('Plan already submitted');
      sessionFor(state, e.payload.plan.orchestratorSessionId);
      break;
    case 'plan.node_updated': {
      const plan = planForNode(state, e.payload.nodeId);
      if (e.payload.sessionId) sessionFor(state, e.payload.sessionId);
      if (e.payload.note !== undefined) sessionFor(state, plan.orchestratorSessionId);
      break;
    }
    case 'ci.updated':
    case 'review.updated':
    case 'pr.merged': {
      const pr = sessionFor(state, e.sessionId).pr;
      if (!pr || pr.number !== e.payload.prNumber)
        throw new Error('PR update requires matching PR');
      break;
    }
    case 'worktree.diff_updated':
      if (!sessionFor(state, e.sessionId).worktree) throw new Error('Diff requires a worktree');
      break;
    case 'feedback.routed':
      sessionFor(state, e.payload.toSessionId);
      break;
    case 'explain.note':
      if (!e.sessionId && e.planNodeId)
        sessionFor(state, planForNode(state, e.planNodeId).orchestratorSessionId);
      break;
    default:
      sessionFor(state, e.sessionId);
  }
}

/** Internal fold: owns state; prepared events are never mutated. */
function reduceInto(
  state: ProjectState | undefined,
  prepared: PreparedEvent,
  options: ProjectionOptions,
): ProjectState {
  const e = prepared.event;
  if (state && e.projectId !== state.project.id) throw new Error('Projection cannot mix projects');
  if (e.type === 'project.added' && (prepared.error || e.projectId !== e.payload.project.id))
    throw new Error('Projection must begin with matching project.added');
  if (!state) {
    if (e.type !== 'project.added' || prepared.error)
      throw new Error('Projection must begin with matching project.added');
    return {
      project: structuredClone(e.payload.project),
      sessions: {},
      plans: {},
      approvals: {},
      lastSeq: e.seq,
      anomalies: [],
    };
  }
  try {
    if (prepared.error) throw new Error(prepared.error);
    assertApplicable(state, e);
  } catch (error) {
    if (options.strict) throw error;
    state.anomalies.push({
      seq: e.seq,
      type: e.type,
      reason: error instanceof Error ? error.message : String(error),
    });
    if (state.anomalies.length > 100) state.anomalies.splice(0, state.anomalies.length - 100);
    // Advance past rejected events so reconnecting does not loop on the same bad event.
    if (Number.isSafeInteger(e.seq)) state.lastSeq = Math.max(state.lastSeq, e.seq);
    return state;
  }
  const next = state;
  const getSession = () => sessionFor(next, e.sessionId);
  switch (e.type) {
    case 'project.added':
      throw new Error('Project already added');
    case 'session.created': {
      const session = structuredClone(e.payload.session);
      if (
        session.projectId !== next.project.id ||
        (e.sessionId !== undefined && e.sessionId !== session.id)
      )
        throw new Error('Session identity mismatch');
      if (Object.hasOwn(next.sessions, session.id)) throw new Error('Session already exists');
      Object.defineProperty(next.sessions, session.id, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: {
          session,
          activity: 'unknown',
          chat: [],
          lastEventSeq: e.seq,
          pendingApprovalIds: [],
        },
      });
      for (const plan of Object.values(next.plans)) {
        for (const node of plan.nodes)
          if (node.id === session.planNodeId) node.sessionId = session.id;
      }
      break;
    }
    case 'session.started':
      getSession().activity = 'starting';
      break;
    case 'session.exited':
      getSession().activity = 'exited';
      break;
    case 'session.archived':
      getSession().session.archivedAt = e.ts;
      break;
    case 'activity.changed':
      getSession().activity = e.payload.activity;
      break;
    case 'chat.item':
      getSession().chat.push(e.payload.item);
      break;
    case 'reasoning.summary':
      getSession().chat.push({ kind: 'reasoning_summary', text: e.payload.text });
      break;
    case 'approval.requested': {
      const approval = structuredClone(e.payload.approval);
      const s = sessionFor(next, approval.sessionId);
      if (e.sessionId !== undefined && e.sessionId !== approval.sessionId)
        throw new Error('Approval session mismatch');
      if (Object.hasOwn(next.approvals, approval.id)) throw new Error('Approval already exists');
      Object.defineProperty(next.approvals, approval.id, {
        value: approval,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (!approval.decision) s.pendingApprovalIds.push(approval.id);
      s.chat.push({ kind: 'approval', approvalId: approval.id });
      s.lastEventSeq = e.seq;
      break;
    }
    case 'approval.decided': {
      const approval = Object.hasOwn(next.approvals, e.payload.approvalId)
        ? next.approvals[e.payload.approvalId]
        : undefined;
      if (!approval) throw new Error('Unknown approval');
      if (e.sessionId !== undefined && e.sessionId !== approval.sessionId)
        throw new Error('Approval session mismatch');
      approval.decision = e.payload.decision;
      approval.decidedAt = e.ts;
      const s = sessionFor(next, approval.sessionId);
      s.pendingApprovalIds = s.pendingApprovalIds.filter((id) => id !== approval.id);
      s.lastEventSeq = e.seq;
      break;
    }
    case 'plan.submitted': {
      const plan = structuredClone(e.payload.plan);
      if (plan.projectId !== next.project.id) throw new Error('Plan project mismatch');
      if (Object.hasOwn(next.plans, plan.id)) throw new Error('Plan already submitted');
      for (const node of plan.nodes) {
        const s = Object.values(next.sessions).find((s) => s.session.planNodeId === node.id);
        if (!node.sessionId && s) node.sessionId = s.session.id;
      }
      Object.defineProperty(next.plans, plan.id, {
        value: { ...plan, nodeStatus: {} },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const s = sessionFor(next, plan.orchestratorSessionId);
      s.chat.push({ kind: 'plan_update', planId: plan.id, text: plan.goal });
      s.lastEventSeq = e.seq;
      break;
    }
    case 'plan.node_updated': {
      const plan = Object.values(next.plans).find((p) =>
        p.nodes.some((n) => n.id === e.payload.nodeId),
      );
      const node = plan?.nodes.find((n) => n.id === e.payload.nodeId);
      if (!node || !plan) throw new Error('Unknown plan node');
      if (e.payload.sessionId) {
        const s = sessionFor(next, e.payload.sessionId);
        node.sessionId = s.session.id;
        s.session.planNodeId = node.id;
        s.lastEventSeq = e.seq;
      }
      if (e.payload.note !== undefined) {
        const s = sessionFor(next, plan.orchestratorSessionId);
        s.chat.push({
          kind: 'plan_update',
          planId: plan.id,
          nodeId: node.id,
          text: e.payload.note,
        });
        s.lastEventSeq = e.seq;
      }
      break;
    }
    case 'worktree.created': {
      const s = getSession();
      s.worktree = { ...e.payload };
      s.session.branch = e.payload.branch;
      s.session.worktreePath = e.payload.path;
      break;
    }
    case 'worktree.diff_updated': {
      const s = getSession();
      if (!s.worktree) throw new Error('Diff requires a worktree');
      s.worktree.diff = e.payload;
      break;
    }
    case 'pr.opened':
    case 'pr.updated':
      getSession().pr = structuredClone(e.payload.pr);
      break;
    case 'ci.updated':
    case 'review.updated':
    case 'pr.merged': {
      const pr = getSession().pr;
      if (!pr || pr.number !== e.payload.prNumber)
        throw new Error('PR update requires matching PR');
      if (e.type === 'ci.updated') pr.checks = e.payload.checks;
      else if (e.type === 'review.updated') pr.review = e.payload.review;
      else pr.state = 'merged'; // mergeSha is not the PR branch headSha.
      pr.updatedAt = e.ts;
      break;
    }
    case 'feedback.routed': {
      const s = sessionFor(next, e.payload.toSessionId);
      s.chat.push({ kind: 'message', role: 'system', text: e.payload.summary });
      s.lastEventSeq = e.seq;
      break;
    }
    case 'explain.note':
      if (e.sessionId)
        getSession().chat.push({ kind: 'message', role: 'system', text: e.payload.text });
      else if (e.planNodeId) {
        const plan = planForNode(next, e.planNodeId);
        const s = sessionFor(next, plan.orchestratorSessionId);
        s.chat.push({
          kind: 'plan_update',
          planId: plan.id,
          nodeId: e.planNodeId,
          text: e.payload.text,
        });
        s.lastEventSeq = e.seq;
      }
      break;
    case 'terminal.output_marker':
      getSession();
      break;
    default: {
      const exhaustive: never = e;
      return exhaustive;
    }
  }
  if (e.sessionId !== undefined) getSession().lastEventSeq = e.seq;
  next.lastSeq = e.seq;
  refreshNodes(next);
  return next;
}

/** Pure single-event update: clone state once. Default tolerates bad events after genesis.
 * Project identity errors and missing genesis always throw. strict restores fail-fast behavior.
 */
export function applyEvent(
  state: ProjectState | undefined,
  event: HelixEvent,
  options: ProjectionOptions = {},
): ProjectState {
  return reduceInto(state ? structuredClone(state) : undefined, prepareEvent(event), options);
}

function assertCursor(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid projection cursor');
}

/** One mutable fold; no growing-state clones. Parses each included event exactly once.
 * Sorts a copy; empty/before-genesis prefixes cannot form ProjectState.
 */
export function projectUpTo(
  events: readonly HelixEvent[],
  seq: number,
  options: ProjectionOptions = {},
): ProjectState {
  assertCursor(seq);
  let state: ProjectState | undefined;
  for (const e of events.filter((e) => e.seq <= seq).sort((a, b) => a.seq - b.seq))
    state = reduceInto(state, prepareEvent(e), options);
  if (!state) throw new Error('No project.added at or before cursor');
  return state;
}

function freezeTree(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

/** Fork only containers the reducer mutates. All shared leaves are already frozen. */
function forkCheckpoint(state: ProjectState): ProjectState {
  return {
    ...state,
    sessions: Object.fromEntries(
      Object.entries(state.sessions).map(([id, s]) => [
        id,
        {
          ...s,
          session: { ...s.session },
          chat: [...s.chat],
          pendingApprovalIds: [...s.pendingApprovalIds],
          ...(s.pr ? { pr: { ...s.pr } } : {}),
          ...(s.worktree ? { worktree: { ...s.worktree } } : {}),
        },
      ]),
    ),
    plans: Object.fromEntries(
      Object.entries(state.plans).map(([id, p]) => [
        id,
        {
          ...p,
          nodes: p.nodes.map((n) => ({ ...n })),
          nodeStatus: { ...p.nodeStatus },
        },
      ]),
    ),
    approvals: Object.fromEntries(Object.entries(state.approvals).map(([id, a]) => [id, { ...a }])),
    anomalies: [...state.anomalies],
  };
}

/** Immutable snapshot of the supplied history (not a live subscription).
 * Builds checkpoints every 100 event positions, not seq values (daemon gaps are valid).
 * at() binary-searches the cursor and folds at most 99 events. Returned states are
 * deeply frozen in all environments: callers must treat them as read-only.
 * Frozen chat entries are shared; only arrays and mutable entity containers are copied.
 */
export function createProjector(
  events: readonly HelixEvent[],
  options: ProjectionOptions = {},
): Projector {
  const prepared = [...events].sort((a, b) => a.seq - b.seq).map(prepareEvent);
  const settings = { ...options };
  const checkpoints: ProjectState[] = [];
  let state: ProjectState | undefined;
  for (const [index, e] of prepared.entries()) {
    if (!e.error) freezeTree(e.event);
    state = reduceInto(state, e, settings);
    if ((index + 1) % 100 === 0) {
      freezeTree(state);
      checkpoints.push(state);
      state = forkCheckpoint(state);
    }
  }
  return {
    at(seq) {
      assertCursor(seq);
      let low = 0;
      let high = prepared.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (prepared[middle]!.event.seq <= seq) low = middle + 1;
        else high = middle;
      }
      const count = low;
      if (!count) throw new Error('No project.added at or before cursor');
      const checkpointCount = Math.floor(count / 100);
      const checkpoint = checkpoints[checkpointCount - 1];
      if (checkpoint && count % 100 === 0) return checkpoint;
      let result = checkpoint ? forkCheckpoint(checkpoint) : undefined;
      for (let index = checkpointCount * 100; index < count; index++)
        result = reduceInto(result, prepared[index]!, settings);
      if (!result) throw new Error('No project.added at or before cursor');
      freezeTree(result);
      return result;
    },
  };
}
