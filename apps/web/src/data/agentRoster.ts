import {
  deriveStatus,
  type AgentKind,
  type HelixEvent,
  type ProjectState,
  type SessionState,
} from '@helix/contracts';
import { approvedText, resolveProjectIdentities } from './identity';
import { isReviewEvent, reviewerTarget } from './crossReview';
import type { PlanTree } from './observatory';

export interface RosterEntry {
  id: string;
  name: string;
  agent: AgentKind;
  role: 'Worker' | 'Reviewer';
  task: string;
  status: string;
  active: boolean;
  sessionId?: string;
  nodeId?: string;
  activity: string;
  relationships: { id: string; name: string; label: string }[];
  review?: string;
}

/** Consume only the selected projection and cursor-bounded events, never live state. */
export function agentRoster(
  state: ProjectState,
  tree: PlanTree | undefined,
  events: readonly HelixEvent[],
  index: number,
): RosterEntry[] {
  const identities = resolveProjectIdentities(state);
  const visibleEvents = events.slice(0, index + 1).filter((e) => e.seq <= state.lastSeq);
  const nodes = new Set<string>(tree?.plan.nodes.map((n) => n.id));
  const sessions = Object.values(state.sessions);
  const authors = sessions.filter(
    (s) =>
      s.session.role === 'worker' &&
      (!tree ||
        nodes.has(s.session.planNodeId ?? '') ||
        tree.tasks.some((t) => t.node.sessionId === s.session.id) ||
        s.session.parentSessionId === tree.plan.orchestratorSessionId),
  );
  const authorIds = new Set<string>(authors.map((s) => s.session.id));
  const reviewers = sessions.filter(
    (s) =>
      s.session.role === 'reviewer' &&
      (!tree ||
        authorIds.has(
          reviewerTarget(s, state, visibleEvents, state.lastSeq)?.worker.session.id ?? '',
        )),
  );
  const status = (s: SessionState) => {
    const derived = deriveStatus(s);
    if (derived === 'merged') return 'Completed';
    if (derived === 'archived') return 'Archived';
    if (s.activity === 'blocked') return 'Blocked';
    if (derived === 'working') return 'Active';
    if (derived === 'exited') return 'Stopped';
    if (derived === 'pending') return 'Waiting';
    return derived.replaceAll('_', ' ');
  };
  const entry = (s: SessionState): RosterEntry => ({
    id: s.session.id,
    sessionId: s.session.id,
    ...(s.session.planNodeId ? { nodeId: s.session.planNodeId } : {}),
    name: identities.sessions.get(s.session.id)!.name,
    agent: s.session.agent,
    role: s.session.role === 'reviewer' ? 'Reviewer' : 'Worker',
    task: approvedText(s, state),
    status: status(s),
    active: deriveStatus(s) === 'working',
    activity: s.activity.replaceAll('_', ' '),
    relationships: [],
  });
  const result = authors.map(entry);
  for (const reviewer of reviewers) {
    const card = entry(reviewer);
    const target = reviewerTarget(reviewer, state, visibleEvents, state.lastSeq)?.worker;
    if (target) {
      card.task = approvedText(target, state);
      card.relationships.push({
        id: target.session.id,
        name: identities.sessions.get(target.session.id)!.name,
        label: 'Reviews',
      });
      result
        .find((a) => a.id === target.session.id)
        ?.relationships.push({ id: card.id, name: card.name, label: 'Reviewer' });
    }
    const lastReview = visibleEvents
      .filter((e) => isReviewEvent(e) && e.sessionId === card.id)
      .at(-1);
    if (lastReview?.type === 'agent_review.abandoned') {
      card.status = 'Stopped';
      card.active = false;
      const hadVerdict = visibleEvents.some(
        (e) => e.type === 'agent_review.submitted' && e.sessionId === card.id,
      );
      card.review = hadVerdict
        ? `Historical verdict recorded; no verdict for the current revision: ${lastReview.payload.reason}`
        : `No verdict: ${lastReview.payload.reason}`;
    } else if (lastReview?.type === 'agent_review.submitted') {
      card.status = 'Completed';
      card.active = false;
      const current = target?.agentReview;
      card.review =
        current?.reviewerSessionId === card.id && current.headSha === target?.pr?.headSha
          ? current.status.replaceAll('_', ' ')
          : 'Historical verdict — not approval of the current revision';
    } else if (reviewer.activity === 'exited' || reviewer.session.archivedAt) {
      card.review = 'No recorded verdict';
    } else if (lastReview?.type === 'agent_review.requested') {
      card.review = 'Verdict pending';
    }
    result.push(card);
  }
  for (const task of tree?.tasks ?? []) {
    if (
      authors.some(
        (s) => s.session.id === task.node.sessionId || s.session.planNodeId === task.node.id,
      )
    )
      continue;
    result.push({
      id: `node:${task.node.id}`,
      nodeId: task.node.id,
      name: identities.nodes.get(task.node.id)!.name,
      agent: task.node.agent,
      role: 'Worker',
      task: task.node.title,
      status: 'Planned',
      active: false,
      activity:
        task.waitingNote ??
        (task.waitsOn.length ? `Waiting for ${task.waitsOn.join(', ')}` : 'Not started'),
      relationships: [],
    });
  }
  return result;
}
