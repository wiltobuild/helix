import { expect, test } from 'vitest';
import {
  crossReviewerFor,
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
