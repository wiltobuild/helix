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
  const workerId = request?.payload.workerSessionId ?? session.session.parentSessionId;
  const worker = workerId ? state.sessions[workerId] : undefined;
  return worker ? { worker, prNumber: request?.payload.prNumber ?? worker.pr?.number } : undefined;
}
