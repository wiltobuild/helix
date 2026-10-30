import {
  crossReviewerFor,
  type HelixEvent,
  type ProjectState,
  type SessionState,
} from '@helix/contracts';
import { agentMeta } from '@helix/ui';

/** Display facts only; merge eligibility continues to come from deriveStatus. */
export function crossReview(session: SessionState, state: ProjectState) {
  const review = session.agentReview;
  if (session.session.role !== 'worker' || !review) return undefined;
  const agent =
    state.sessions[review.reviewerSessionId]?.session.agent ??
    crossReviewerFor(session.session.agent) ??
    'reviewer';
  const name = agentMeta(agent).label;
  const stale = review.headSha !== session.pr?.headSha;
  const status = stale ? 'reviewing' : review.status;
  const label = stale
    ? `${name} review pending · new head`
    : status === 'reviewing'
      ? `${name} reviewing`
      : status === 'approved'
        ? `Approved by ${name}`
        : `Changes requested · ${review.review?.findings.length ?? 0}`;
  return { agent, name, stale, status, label, reviewerSessionId: review.reviewerSessionId };
}

export type CrossReview = NonNullable<ReturnType<typeof crossReview>>;
export type ReviewEvent = HelixEvent<
  'agent_review.requested' | 'agent_review.submitted' | 'agent_review.abandoned'
>;

export function isReviewEvent(event: HelixEvent): event is ReviewEvent {
  return (
    event.type === 'agent_review.requested' ||
    event.type === 'agent_review.submitted' ||
    event.type === 'agent_review.abandoned'
  );
}

/** Review events belong to the reviewer, but also explain the worker's history. */
export function sessionHistory(events: readonly HelixEvent[], id: string, upTo: number) {
  return events
    .filter(
      (e) =>
        e.seq <= upTo &&
        (e.sessionId === id ||
          (isReviewEvent(e) && e.payload.workerSessionId === id) ||
          (e.type === 'feedback.routed' && e.payload.toSessionId === id)),
    )
    .reverse();
}

export function reviewerTarget(
  session: SessionState,
  state: ProjectState,
  events: readonly HelixEvent[],
  upTo: number,
) {
  if (session.session.role !== 'reviewer') return undefined;
  const request = events
    .filter(
      (e): e is ReviewEvent =>
        e.seq <= upTo && e.sessionId === session.session.id && isReviewEvent(e),
    )
    .at(-1);
  const linked = Object.values(state.sessions).find(
    (worker) => worker.agentReview?.reviewerSessionId === session.session.id,
  );
  const workerId =
    linked?.session.id ?? request?.payload.workerSessionId ?? session.session.parentSessionId;
  const worker = workerId ? state.sessions[workerId] : undefined;
  return worker ? { worker, prNumber: request?.payload.prNumber ?? worker.pr?.number } : undefined;
}

/** A review slot reflects current facts even when a recording has no reviewer session. */
export function reviewSlot(worker: SessionState, state: ProjectState, live: boolean) {
  const review = crossReview(worker, state);
  if (review)
    return {
      label: review.label,
      status: review.status,
      detail: review.stale ? 'Waiting for a verdict on the current PR head.' : 'Cross-agent review',
    };
  const pr = worker.pr;
  if (pr?.state === 'merged')
    return { label: 'PR merged', status: 'merged', detail: 'Merged by a human.' };
  if (pr?.state === 'closed')
    return { label: 'PR closed', status: 'closed', detail: 'No active review.' };
  if (pr?.review.decision === 'approved')
    return { label: 'Approved on GitHub', status: 'approved', detail: 'GitHub review verdict' };
  if (pr?.review.decision === 'changes_requested')
    return {
      label: 'Changes requested on GitHub',
      status: 'changes_requested',
      detail: 'GitHub review verdict',
    };
  if (!pr) return { label: 'Standing by', status: 'idle', detail: 'Waiting for a pull request.' };
  if (pr.checks.failed > 0)
    return {
      label: 'Waiting for CI fixes',
      status: 'idle',
      detail: 'The builder is responsible for fixing failing checks.',
    };
  if (pr.checks.pending > 0)
    return { label: 'Waiting for CI', status: 'idle', detail: 'Checks are still running.' };
  return {
    label: live ? 'Awaiting reviewer assignment' : 'PR ready for review',
    status: 'idle',
    detail: live
      ? 'Review starts when a reviewer is assigned.'
      : 'This recording does not include an agent verdict.',
  };
}
