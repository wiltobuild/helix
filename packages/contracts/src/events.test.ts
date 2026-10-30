import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  projectUpTo,
  eventSchemas,
  fixtures,
  isEventOf,
  parseEvent,
  projectIdSchema,
  sessionIdSchema,
  eventSeqSchema,
  pullRequestNumberSchema,
  planNodesSchema,
  checkSummarySchema,
  agentKindSchema,
  type EventType,
  type HelixEvent,
  type PayloadFor,
  type ProjectId,
  type SessionId,
  type UnsequencedEvent,
} from './index.js';

const samples = Object.fromEntries(
  [...fixtures.crossReviewRun, ...fixtures.passwordResetRun].map((e) => [e.type, e]),
);
const base = fixtures.passwordResetRun[2]!;
samples['scheduling.changed'] = eventSchemas['scheduling.changed'].parse({
  ...fixtures.passwordResetRun[0],
  type: 'scheduling.changed',
  payload: { paused: true },
});
samples['session.exited'] = eventSchemas['session.exited'].parse({
  ...base,
  type: 'session.exited',
  payload: { code: 0 },
});
samples['session.archived'] = eventSchemas['session.archived'].parse({
  ...base,
  type: 'session.archived',
  payload: {},
});
samples['plan.rejected'] = eventSchemas['plan.rejected'].parse({
  ...base,
  type: 'plan.rejected',
  payload: { planId: fixtures.passwordResetPlan.id, reason: 'Split the task further' },
});
samples['agent_review.abandoned'] = eventSchemas['agent_review.abandoned'].parse({
  ...fixtures.crossReviewRun.find((e) => e.type === 'agent_review.requested'),
  type: 'agent_review.abandoned',
  payload: {
    workerSessionId: fixtures.crossReviewIds.worker,
    prNumber: 7,
    headSha: 'sha',
    reason: 'The reviewer stopped without a verdict.',
  },
});
samples['terminal.output_marker'] = eventSchemas['terminal.output_marker'].parse({
  ...base,
  type: 'terminal.output_marker',
  payload: { bytesOffset: 1024 },
});
samples['design.updated'] = eventSchemas['design.updated'].parse({
  ...base,
  type: 'design.updated',
  payload: {
    design: {
      sessionId: base.sessionId,
      revision: 1,
      brief: 'A storefront',
      status: 'unavailable',
      rounds: [],
      conversation: [],
      references: [],
      receipts: [],
      blocker: 'Provider unavailable',
    },
  },
});
samples['plan.reviewed'] = eventSchemas['plan.reviewed'].parse({
  ...base,
  type: 'plan.reviewed',
  payload: {
    planId: fixtures.passwordResetPlan.id,
    review: {
      hash: 'a'.repeat(64),
      attempt: 1,
      status: 'failed',
      reviewer: 'codex',
      message: 'Unavailable',
    },
  },
});
const invalid: Record<EventType, unknown> = {
  'plan.reviewed': { planId: '', review: {} },
  'design.updated': { design: { revision: -1 } },
  'project.added': { project: { ...fixtures.passwordResetProject, id: '' } },
  'scheduling.changed': { paused: 'true' },
  'session.created': { session: { id: 'x' } },
  'session.started': { unexpected: true },
  'session.exited': { code: '0' },
  'session.archived': { unexpected: true },
  'activity.changed': { activity: 'dead' },
  'chat.item': { item: { kind: 'message', role: 'bot', text: 'hello' } },
  'approval.requested': { approval: { id: 'x' } },
  'approval.decided': { approvalId: 'x', decision: 'yes' },
  'reasoning.summary': { text: 'why', source: 'human' },
  'plan.submitted': {
    plan: {
      ...fixtures.passwordResetPlan,
      nodes: [{ ...fixtures.passwordResetPlan.nodes[0], dependsOn: ['missing'] }],
    },
  },
  'plan.node_updated': { nodeId: '' },
  'plan.approved': { planId: fixtures.passwordResetPlan.id, approvedBy: 'agent' },
  'plan.rejected': { planId: fixtures.passwordResetPlan.id, reason: '  ' },
  'explain.note': { text: 3 },
  'worktree.created': { branch: 'b', path: '', baseSha: 'sha' },
  'worktree.diff_updated': { filesChanged: -1, insertions: 0, deletions: 0 },
  'pr.opened': { pr: {} },
  'pr.updated': { pr: {} },
  'ci.updated': {
    prNumber: 142,
    checks: { total: 1, passed: 2, failed: 0, pending: 0, failingNames: [] },
  },
  'review.updated': { prNumber: 142, review: { decision: 'approved', unresolvedThreads: -1 } },
  'feedback.routed': { prNumber: 142, reason: 'slow', summary: 'fix', toSessionId: 's' },
  'agent_review.requested': { workerSessionId: 's', prNumber: 7, headSha: '' },
  'agent_review.submitted': {
    workerSessionId: 's',
    prNumber: 7,
    headSha: 'sha',
    review: { verdict: 'lgtm', summary: 'ok', findings: [] },
  },
  'agent_review.abandoned': { workerSessionId: 's', prNumber: 7, headSha: 'sha', reason: ' ' },
  'pr.merged': { prNumber: 0, mergeSha: 'sha' },
  'terminal.output_marker': { bytesOffset: 0.5 },
};
describe.each(Object.keys(eventSchemas) as EventType[])('%s', (type) => {
  it('accepts its valid payload and envelope', () => {
    expect(samples[type]).toBeDefined();
    expect(eventSchemas[type].shape.payload.safeParse(samples[type]!.payload).success).toBe(true);
    expect(parseEvent(samples[type]).success).toBe(true);
  });
  it('rejects an invalid payload without throwing', () => {
    expect(eventSchemas[type].shape.payload.safeParse(invalid[type]).success).toBe(false);
    expect(parseEvent({ ...samples[type], payload: invalid[type] }).success).toBe(false);
  });
});
it('accepts structured guardrails and legacy payloads, rejecting unknown codes and wait reasons', () => {
  const note = eventSchemas['explain.note'].shape.payload;
  for (const code of ['turn_limit_reached', 'turn_limit_extended'])
    expect(note.safeParse({ text: 'Wording may change', code }).success).toBe(true);
  expect(note.safeParse({ text: 'Legacy note' }).success).toBe(true);
  expect(note.safeParse({ text: 'Invalid', code: 'future_code' }).success).toBe(false);
  const update = eventSchemas['plan.node_updated'].shape.payload;
  const nodeId = fixtures.passwordResetIds.apiNode;
  expect(update.safeParse({ nodeId, waiting: 'worker_slot' }).success).toBe(true);
  expect(update.safeParse({ nodeId, note: 'Legacy note' }).success).toBe(true);
  expect(update.safeParse({ nodeId, waiting: 'dependency' }).success).toBe(false);
});
it('requires scheduling changes to be project-level boolean events', () => {
  const sample = samples['scheduling.changed']!;
  expect(parseEvent({ ...sample, payload: { paused: false } }).success).toBe(true);
  expect(parseEvent({ ...sample, sessionId: base.sessionId }).success).toBe(false);
  expect(parseEvent({ ...sample, planNodeId: fixtures.passwordResetIds.apiNode }).success).toBe(
    false,
  );
  expect(parseEvent({ ...sample, payload: {} }).success).toBe(false);
});
it.each([
  null,
  {},
  1,
  'event',
  { ...base, v: 2 },
  { ...base, seq: 0 },
  { ...base, seq: 1.5 },
  { ...base, causedBy: 0 },
  { ...base, ts: '2026-10-01T09:00:00+01:00' },
  { ...base, type: 'future.event' },
])('rejects malformed envelope %#', (value) => {
  expect(parseEvent(value).success).toBe(false);
});
it('validates every golden event and every backward cause', () => {
  const run = fixtures.passwordResetRun;
  for (const e of run) {
    expect(parseEvent(e).success).toBe(true);
    if (e.seq > 1) {
      expect(e.causedBy).toBeLessThan(e.seq);
      expect(run.some((cause) => cause.seq === e.causedBy)).toBe(true);
    }
  }
});
it('brands IDs and preserves discriminant/payload correlation', () => {
  expectTypeOf<ProjectId>().not.toEqualTypeOf<SessionId>();
  const matches = fixtures.passwordResetRun.filter(isEventOf('ci.updated'));
  expectTypeOf(matches).toEqualTypeOf<HelixEvent<'ci.updated'>[]>();
  expect(matches).toHaveLength(3);
  const e = matches[0]!;
  expectTypeOf(e.payload).toEqualTypeOf<PayloadFor<'ci.updated'>>();
  const appendable: UnsequencedEvent = e;
  if (appendable.type === 'ci.updated')
    expectTypeOf(appendable.payload).toEqualTypeOf<PayloadFor<'ci.updated'>>();
});
it('validates numeric and string ID boundaries', () => {
  expect(projectIdSchema.safeParse('').success).toBe(false);
  expect(sessionIdSchema.safeParse('x'.repeat(65)).success).toBe(false);
  expect(projectIdSchema.safeParse('x'.repeat(64)).success).toBe(true);
  for (const schema of [eventSeqSchema, pullRequestNumberSchema]) {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity])
      expect(schema.safeParse(value).success).toBe(false);
  }
  expect(agentKindSchema.safeParse('future-harness').success).toBe(true);
});
it('rejects invalid plan graphs and inconsistent check counts', () => {
  const nodes = fixtures.passwordResetPlan.nodes;
  expect(planNodesSchema.safeParse([nodes[0], nodes[0]]).success).toBe(false);
  expect(planNodesSchema.safeParse([{ ...nodes[0], dependsOn: [nodes[0]!.id] }]).success).toBe(
    false,
  );
  expect(
    planNodesSchema.safeParse([
      { ...nodes[0], dependsOn: [nodes[1]!.id] },
      { ...nodes[1], dependsOn: [nodes[0]!.id] },
    ]).success,
  ).toBe(false);
  expect(
    checkSummarySchema.safeParse({ total: 3, passed: 3, failed: 1, pending: 0, failingNames: [] })
      .success,
  ).toBe(false);
});

it('preserves legacy plan approval without review metadata', () => {
  const state = projectUpTo(fixtures.passwordResetRun, fixtures.passwordResetRun.at(-1)!.seq);
  expect(state.plans[fixtures.passwordResetPlan.id]?.status).toBe('approved');
});

it('binds projected approval to a passing exact review revision', () => {
  const run = structuredClone(fixtures.passwordResetRun);
  const at = run.findIndex((e) => e.type === 'plan.submitted');
  const submitted = run[at]!;
  if (submitted.type !== 'plan.submitted') throw new Error('Missing plan');
  const review = {
    hash: 'a'.repeat(64),
    attempt: 1,
    status: 'reviewing' as const,
    reviewer: 'codex' as const,
    message: 'Pending',
  };
  submitted.payload.plan.review = review;
  const prefix = run.slice(0, at + 1);
  const reviewed = eventSchemas['plan.reviewed'].parse({
    ...submitted,
    seq: submitted.seq + 1,
    type: 'plan.reviewed',
    payload: {
      planId: submitted.payload.plan.id,
      review: {
        ...review,
        status: 'passed',
        result: { verdict: 'passed', summary: 'Pass', findings: [] },
      },
    },
  });
  const approved = eventSchemas['plan.approved'].parse({
    ...submitted,
    seq: submitted.seq + 2,
    type: 'plan.approved',
    payload: { planId: submitted.payload.plan.id, approvedBy: 'human', reviewHash: review.hash },
  });
  expect(
    eventSchemas['plan.submitted'].safeParse({
      ...submitted,
      payload: { plan: { ...submitted.payload.plan, review: { ...review, status: 'passed' } } },
    }).success,
  ).toBe(false);
  const priorAttempt = {
    ...reviewed,
    payload: { ...reviewed.payload, review: { ...reviewed.payload.review, attempt: 2 } },
  };
  expect(
    projectUpTo([...prefix, priorAttempt], priorAttempt.seq).plans[submitted.payload.plan.id]
      ?.review?.status,
  ).toBe('reviewing');
  const events = [...prefix, reviewed, approved];
  expect(projectUpTo(events, approved.seq).plans[submitted.payload.plan.id]?.status).toBe(
    'approved',
  );
  const wrong = structuredClone(events);
  const decision = wrong.at(-1)!;
  if (decision.type !== 'plan.approved') throw new Error('Missing approval');
  decision.payload.reviewHash = 'b'.repeat(64);
  expect(projectUpTo(wrong, decision.seq).plans[submitted.payload.plan.id]?.status).toBe(
    'awaiting_approval',
  );
  const stale = {
    ...reviewed,
    payload: { ...reviewed.payload, review: { ...reviewed.payload.review, hash: 'b'.repeat(64) } },
  };
  expect(
    projectUpTo([...prefix, stale], stale.seq).plans[submitted.payload.plan.id]?.review?.status,
  ).toBe('reviewing');
});

it('uses submission sequence rather than numeric key order for latest reviewed plan', () => {
  const run = structuredClone(fixtures.passwordResetRun);
  const at = run.findIndex((e) => e.type === 'plan.submitted');
  const original = run[at]!;
  if (original.type !== 'plan.submitted') throw new Error('Missing plan');
  const review = {
    hash: 'a'.repeat(64),
    attempt: 1,
    status: 'reviewing',
    reviewer: 'codex',
    message: 'Pending',
  };
  const first = eventSchemas['plan.submitted'].parse({
    ...original,
    payload: { plan: { ...original.payload.plan, id: '2', review } },
  });
  const second = eventSchemas['plan.submitted'].parse({
    ...first,
    seq: first.seq + 1,
    payload: { plan: { ...first.payload.plan, id: '1' } },
  });
  const prefix = [...run.slice(0, at), first, second];
  for (const id of ['2', '1']) {
    const reviewed = eventSchemas['plan.reviewed'].parse({
      ...second,
      seq: second.seq + 1,
      type: 'plan.reviewed',
      payload: {
        planId: id,
        review: {
          ...review,
          status: 'passed',
          result: { verdict: 'passed', summary: 'Pass', findings: [] },
        },
      },
    });
    const approved = eventSchemas['plan.approved'].parse({
      ...reviewed,
      seq: reviewed.seq + 1,
      type: 'plan.approved',
      payload: { planId: id, approvedBy: 'human', reviewHash: review.hash },
    });
    const state = projectUpTo([...prefix, reviewed, approved], approved.seq);
    expect(state.plans[first.payload.plan.id]?.status).toBe('awaiting_approval');
    expect(state.plans[second.payload.plan.id]?.status).toBe(
      id === '1' ? 'approved' : 'awaiting_approval',
    );
  }
});
