import { expect, test } from 'vitest';
import {
  crossReviewerFor,
  helixEventSchema,
  deriveStatus,
  fixtures,
  projectUpTo,
  submitReviewRequestSchema,
  type HelixEvent,
} from './index.js';

const { crossReviewRun: run, crossReviewIds: ids, crossReviewMilestones: at } = fixtures;
const statusAt = (seq: number) =>
  deriveStatus(projectUpTo(run, seq, { strict: true }).sessions[ids.worker]!);

test('reviewers are always the other agent kind', () => {
  expect(crossReviewerFor('codex')).toBe('claude-code');
  expect(crossReviewerFor('claude-code')).toBe('codex');
  expect(crossReviewerFor('future-agent')).toBeUndefined();
});

test('a cross review gates ready-to-merge on the current PR head', () => {
  const requested = run.find((e) => e.type === 'agent_review.requested')!.seq;
  expect(statusAt(requested - 1)).toBe('ready_to_merge'); // CI green, no review yet
  expect(statusAt(requested)).toBe('in_review');
  expect(statusAt(at.changesRequested)).toBe('changes_requested');
  const pushed = run.find((e) => e.type === 'pr.updated')!.seq;
  expect(statusAt(pushed + 2)).toBe('in_review'); // new head, CI green, old review is stale
  expect(statusAt(at.approved)).toBe('ready_to_merge');
  const final = projectUpTo(run, run.at(-1)!.seq, { strict: true });
  expect(final.anomalies).toEqual([]);
  expect(final.sessions[ids.worker]!.agentReview).toMatchObject({
    reviewerSessionId: ids.reviewer,
    status: 'approved',
  });
});

test('strict projection rejects self-review and verdicts nobody asked for', () => {
  const upTo = (seq: number) => run.filter((e) => e.seq <= seq);
  const created = run.find(
    (e): e is HelixEvent<'session.created'> =>
      e.type === 'session.created' && e.payload.session.id === ids.reviewer,
  )!;
  const selfReviewer = {
    ...created,
    payload: { session: { ...created.payload.session, agent: 'codex' } },
  };
  const selfRun = run.map((e) => (e.seq === created.seq ? selfReviewer : e));
  const requested = run.find((e) => e.type === 'agent_review.requested')!;
  expect(() => projectUpTo(selfRun, requested.seq, { strict: true })).toThrow(/no self-review/);
  const verdict = run.find((e) => e.seq === at.changesRequested)!;
  const unrequested = [...upTo(requested.seq - 1), { ...verdict, seq: requested.seq }];
  expect(() => projectUpTo(unrequested, requested.seq, { strict: true })).toThrow(
    /review in progress/,
  );
});

test('an abandoned review falls back to CI and GitHub status', () => {
  const requested = run.find((e) => e.type === 'agent_review.requested')!;
  const abandoned = {
    ...requested,
    seq: requested.seq + 1,
    type: 'agent_review.abandoned',
    payload: { ...requested.payload, reason: 'Reviewer exited without a verdict.' },
  } as HelixEvent;
  const events = [...run.filter((e) => e.seq <= requested.seq), abandoned];
  const state = projectUpTo(events, abandoned.seq, { strict: true });
  expect(state.sessions[ids.worker]!.agentReview).toBeUndefined();
  expect(deriveStatus(state.sessions[ids.worker]!)).toBe('ready_to_merge');
});

test('a finished review can be abandoned only after the PR head moves past it', () => {
  const approved = run.find((e) => e.seq === at.approved)! as HelixEvent<'agent_review.submitted'>;
  const upToApproval = run.filter((e) => e.seq <= at.approved);
  const abandon = (seq: number): HelixEvent =>
    helixEventSchema.parse({
      ...approved,
      seq,
      type: 'agent_review.abandoned',
      payload: {
        workerSessionId: ids.worker,
        prNumber: approved.payload.prNumber,
        headSha: approved.payload.headSha,
        reason: 'Codex is no longer available to review the new head.',
      },
    });
  // Same head: the verdict stands and cannot be abandoned.
  const early = [...upToApproval, abandon(at.approved + 1)];
  expect(() => projectUpTo(early, at.approved + 1, { strict: true })).toThrow(/review in progress/);
  // Head moved on with green CI and no reviewer: abandoning clears the gate.
  const pushed = run.find((e): e is HelixEvent<'pr.updated'> => e.type === 'pr.updated')!;
  const moved = helixEventSchema.parse({
    ...pushed,
    seq: at.approved + 1,
    payload: { pr: { ...pushed.payload.pr, headSha: 'f'.repeat(40), checks: approvedChecks() } },
  });
  const events = [...upToApproval, moved, abandon(at.approved + 2)];
  expect(
    deriveStatus(projectUpTo(events, at.approved + 1, { strict: true }).sessions[ids.worker]!),
  ).toBe('in_review');
  const state = projectUpTo(events, at.approved + 2, { strict: true });
  expect(state.sessions[ids.worker]!.agentReview).toBeUndefined();
  expect(deriveStatus(state.sessions[ids.worker]!)).toBe('ready_to_merge');
});

function approvedChecks() {
  return { total: 1, passed: 1, failed: 0, pending: 0, failingNames: [] };
}

test('submit-review requests carry a bounded, structured verdict', () => {
  const review = fixtures.crossReviewFindings;
  const request = { reviewerSessionId: ids.reviewer, headSha: 'abc', review };
  expect(submitReviewRequestSchema.safeParse(request).success).toBe(true);
  for (const bad of [
    { ...request, review: { ...review, verdict: 'maybe' } },
    { ...request, review: { ...review, summary: ' ' } },
    { ...request, review: { ...review, findings: [{ ...review.findings[0], file: '../x' }] } },
    { ...request, review: { ...review, findings: [{ ...review.findings[0], severity: 'meh' }] } },
    { ...request, extra: true },
  ])
    expect(submitReviewRequestSchema.safeParse(bad).success).toBe(false);
});
