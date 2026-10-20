import type { AgentActivity, Approval, ChatItem, Plan, Project, PullRequestFacts, Session } from './entities.js';
import type { ApprovalId, PlanId, PlanNodeId, SessionId } from './ids.js';
import type { HelixEvent, PayloadFor } from './events.js';
import { deriveStatus, type DisplayStatus } from './status.js';

export type Worktree = PayloadFor<'worktree.created'>;
export type WorktreeState = Worktree & { diff?: PayloadFor<'worktree.diff_updated'> };
export type SessionState = {
  session: Session; activity: AgentActivity; pr?: PullRequestFacts; worktree?: WorktreeState;
  chat: ChatItem[]; lastEventSeq: number; pendingApprovalIds: ApprovalId[];
};
export type ProjectState = {
  project: Project; sessions: Record<SessionId, SessionState>;
  plans: Record<PlanId, Plan & { nodeStatus: Record<PlanNodeId, DisplayStatus> }>;
  approvals: Record<ApprovalId, Approval>; lastSeq: number;
};
function sessionFor(state: ProjectState, id: SessionId | undefined): SessionState {
  if (id === undefined || !Object.hasOwn(state.sessions, id)) throw new Error(`Unknown or missing session: ${id}`);
  return state.sessions[id]!;
}
function refreshNodes(state: ProjectState): void {
  for (const plan of Object.values(state.plans)) {
    plan.nodeStatus = Object.fromEntries(plan.nodes.map((node) => {
      const session = node.sessionId && Object.hasOwn(state.sessions, node.sessionId) ? state.sessions[node.sessionId] : undefined;
      return [node.id, session ? deriveStatus(session) : 'pending'];
    }));
  }
}

/** Applies one project-scoped event, in strictly increasing (possibly gapped) seq order.
 * Missing history, duplicate seqs and foreign projects are errors, never silent data loss.
 * Detached clones prevent mutations of returned states from changing earlier states/events.
 */
export function applyEvent(state: ProjectState | undefined, input: HelixEvent): ProjectState {
  const e = structuredClone(input);
  if (!state) {
    if (e.type !== 'project.added' || e.projectId !== e.payload.project.id) throw new Error('Projection must begin with matching project.added');
    return { project: e.payload.project, sessions: {}, plans: {}, approvals: {}, lastSeq: e.seq };
  }
  if (e.projectId !== state.project.id) throw new Error('Projection cannot mix projects');
  if (e.seq <= state.lastSeq) throw new Error('Event seq must increase');
  const next = structuredClone(state);
  const getSession = () => sessionFor(next, e.sessionId);
  switch (e.type) {
    case 'project.added': throw new Error('Project already added');
    case 'session.created': {
      const session = e.payload.session;
      if (session.projectId !== next.project.id || (e.sessionId !== undefined && e.sessionId !== session.id)) throw new Error('Session identity mismatch');
      if (Object.hasOwn(next.sessions, session.id)) throw new Error('Session already exists');
      Object.defineProperty(next.sessions, session.id, { enumerable: true, configurable: true, writable: true, value: {
        session, activity: 'unknown', chat: [], lastEventSeq: e.seq, pendingApprovalIds: [],
      } });
      for (const plan of Object.values(next.plans)) {
        for (const node of plan.nodes) if (node.id === session.planNodeId) node.sessionId = session.id;
      }
      break;
    }
    case 'session.started': getSession().activity = 'starting'; break;
    case 'session.exited': getSession().activity = 'exited'; break;
    case 'session.archived': getSession().session.archivedAt = e.ts; break;
    case 'activity.changed': getSession().activity = e.payload.activity; break;
    case 'chat.item': getSession().chat.push(e.payload.item); break;
    case 'reasoning.summary': getSession().chat.push({ kind: 'reasoning_summary', text: e.payload.text }); break;
    case 'approval.requested': {
      const approval = e.payload.approval;
      const s = sessionFor(next, approval.sessionId);
      if (e.sessionId !== undefined && e.sessionId !== approval.sessionId) throw new Error('Approval session mismatch');
      if (Object.hasOwn(next.approvals, approval.id)) throw new Error('Approval already exists');
      Object.defineProperty(next.approvals, approval.id, { value: approval, enumerable: true, writable: true, configurable: true });
      if (!approval.decision) s.pendingApprovalIds.push(approval.id);
      s.chat.push({ kind: 'approval', approvalId: approval.id });
      s.lastEventSeq = e.seq;
      break;
    }
    case 'approval.decided': {
      const approval = Object.hasOwn(next.approvals, e.payload.approvalId) ? next.approvals[e.payload.approvalId] : undefined;
      if (!approval) throw new Error('Unknown approval');
      if (e.sessionId !== undefined && e.sessionId !== approval.sessionId) throw new Error('Approval session mismatch');
      approval.decision = e.payload.decision;
      approval.decidedAt = e.ts;
      const s = sessionFor(next, approval.sessionId);
      s.pendingApprovalIds = s.pendingApprovalIds.filter((id) => id !== approval.id);
      s.lastEventSeq = e.seq;
      break;
    }
    case 'plan.submitted': {
      const plan = e.payload.plan;
      if (plan.projectId !== next.project.id) throw new Error('Plan project mismatch');
      if (Object.hasOwn(next.plans, plan.id)) throw new Error('Plan already submitted');
      for (const node of plan.nodes) {
        const s = Object.values(next.sessions).find((s) => s.session.planNodeId === node.id);
        if (!node.sessionId && s) node.sessionId = s.session.id;
      }
      Object.defineProperty(next.plans, plan.id, { value: { ...plan, nodeStatus: {} }, enumerable: true, writable: true, configurable: true });
      const s = sessionFor(next, plan.orchestratorSessionId);
      s.chat.push({ kind: 'plan_update', planId: plan.id, text: plan.goal });
      s.lastEventSeq = e.seq;
      break;
    }
    case 'plan.node_updated': {
      const plan = Object.values(next.plans).find((p) => p.nodes.some((n) => n.id === e.payload.nodeId));
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
        s.chat.push({ kind: 'plan_update', planId: plan.id, nodeId: node.id, text: e.payload.note });
        s.lastEventSeq = e.seq;
      }
      break;
    }
    case 'worktree.created': {
      const s = getSession();
      s.worktree = e.payload;
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
    case 'pr.opened': case 'pr.updated': getSession().pr = e.payload.pr; break;
    case 'ci.updated': case 'review.updated': case 'pr.merged': {
      const pr = getSession().pr;
      if (!pr || pr.number !== e.payload.prNumber) throw new Error('PR update requires matching PR');
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
      if (e.sessionId) getSession().chat.push({ kind: 'message', role: 'system', text: e.payload.text });
      break;
    case 'terminal.output_marker': getSession(); break;
    default: { const exhaustive: never = e; return exhaustive; }
  }
  if (e.sessionId !== undefined) getSession().lastEventSeq = e.seq;
  next.lastSeq = e.seq;
  refreshNodes(next);
  return next;
}

/** Sorts a copy by daemon sequence. Empty/before-genesis prefixes cannot form ProjectState. */
export function projectUpTo(events: readonly HelixEvent[], seq: number): ProjectState {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid projection cursor');
  let state: ProjectState | undefined;
  for (const e of events.filter((e) => e.seq <= seq).sort((a, b) => a.seq - b.seq)) state = applyEvent(state, e);
  if (!state) throw new Error('No project.added at or before cursor');
  return state;
}
