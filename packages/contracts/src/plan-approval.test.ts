import { expect, expectTypeOf, it } from 'vitest';
import {
  applyEvent,
  createProjector,
  eventSchemas,
  fixtures,
  metaValueSchema,
  planDecisionRequestSchema,
  planDecisionResponseSchema,
  planNodeSchema,
  planSchema,
  projectUpTo,
  repoRelativeGlobSchema,
  routes,
  submitPlanRequestSchema,
  type HelixStore,
  type MetaValue,
} from './index.js';

const { passwordResetRun: run, passwordResetPlan: plan, passwordResetIds: ids } = fixtures;
const pending = () => projectUpTo(run, 5, { strict: true });
const rejected = () =>
  eventSchemas['plan.rejected'].parse({
    ...run[5],
    type: 'plan.rejected',
    payload: { planId: plan.id, reason: 'Separate the shared interface first' },
  });

it('keeps a submitted plan awaiting approval until a human decision, without starting workers', () => {
  const before = pending();
  expect(before.plans[plan.id]!.status).toBe('awaiting_approval');
  expect(before.plans[plan.id]!.decidedAt).toBeUndefined();
  expect(Object.values(before.plans[plan.id]!.nodeStatus)).toEqual([
    'pending',
    'pending',
    'pending',
  ]);
  expect(Object.keys(before.sessions)).toEqual([ids.orchestrator]);
  const after = applyEvent(before, run[5]!, { strict: true });
  expect(after.plans[plan.id]).toMatchObject({
    status: 'approved',
    approvedBy: 'human',
    decidedAt: run[5]!.ts,
  });
  expect(Object.keys(after.sessions)).toEqual([ids.orchestrator]);
  expect(before.plans[plan.id]!.status).toBe('awaiting_approval');
  expect(createProjector(run).at(5)).toEqual(before);
  expect(createProjector(run).at(6)).toEqual(after);
});

it('records rejection reasons and projects sessionless human decisions', () => {
  const event = rejected();
  const after = applyEvent(pending(), { ...event, sessionId: undefined }, { strict: true });
  expect(after.plans[plan.id]).toMatchObject({
    status: 'rejected',
    rejectionReason: event.payload.reason,
    decidedAt: event.ts,
  });
  expect(after.plans[plan.id]!.approvedBy).toBeUndefined();
  expect(after.sessions[ids.orchestrator]!.chat.at(-1)).toMatchObject({
    kind: 'plan_update',
    planId: plan.id,
    text: `Plan rejected: ${event.payload.reason}`,
  });
  expect(after.sessions[ids.orchestrator]!.lastEventSeq).toBe(event.seq);
  expect(createProjector([...run.slice(0, 5), event]).at(6)).toEqual(after);
});

it('rejects unknown plans and mismatched sessions without partially mutating state', () => {
  const before = projectUpTo(
    run.filter((e) => e.type !== 'plan.approved'),
    9,
  );
  for (const event of [
    eventSchemas['plan.approved'].parse({
      ...run[5],
      seq: 10,
      payload: { planId: 'missing', approvedBy: 'human' },
    }),
    eventSchemas['plan.approved'].parse({ ...run[5], seq: 10, sessionId: ids.api }),
  ]) {
    expect(() => applyEvent(before, event, { strict: true })).toThrow();
    const skipped = applyEvent(before, event);
    expect(skipped.plans).toEqual(before.plans);
    expect(skipped.sessions).toEqual(before.sessions);
    expect(skipped.anomalies).toHaveLength(1);
  }
});

it('does not overwrite a decision with a duplicate or conflicting later event', () => {
  for (const first of [run[5]!, rejected()]) {
    const before = applyEvent(pending(), first, { strict: true });
    for (const second of [run[5]!, rejected()]) {
      const event = eventSchemas[second.type].parse({ ...second, seq: 7 });
      expect(() => applyEvent(before, event, { strict: true })).toThrow('already decided');
      expect(applyEvent(before, event).plans).toEqual(before.plans);
    }
  }
});

it.each(['src/**', 'src/*.{ts,tsx}', 'src/[ab].ts', '**/*.test.ts', '.github/workflows/ci.yml'])(
  'accepts repository-relative file glob %s',
  (path) => expect(repoRelativeGlobSchema.safeParse(path).success).toBe(true),
);
it.each([
  '',
  '/tmp/file',
  '../file',
  'src/../file',
  './file',
  'C:/repo/file',
  'C:file',
  '\\\\server\\share',
  'src\\file',
  '!src/**',
  'src//file',
  'src/./file',
  'src/\u0000file',
  ' src/file',
])('rejects unsafe or ambiguous file glob %s', (path) =>
  expect(repoRelativeGlobSchema.safeParse(path).success).toBe(false),
);

it('requires files for new submissions but reads old stored plans without inventing ownership', () => {
  const { files, ...legacyNode } = plan.nodes[0]!;
  expect(files.length).toBeGreaterThan(0);
  expect(planNodeSchema.safeParse(legacyNode).success).toBe(false);
  const legacyPlan = { ...plan, nodes: [legacyNode] };
  expect(planSchema.parse(legacyPlan).nodes[0]!.files).toEqual([]);
  const request = {
    projectId: plan.projectId,
    orchestratorSessionId: plan.orchestratorSessionId,
    goal: plan.goal,
    nodes: [legacyNode],
  };
  expect(submitPlanRequestSchema.safeParse(request).success).toBe(false);
  expect(
    submitPlanRequestSchema.safeParse({ ...request, nodes: [{ ...legacyNode, files: ['src/**'] }] })
      .success,
  ).toBe(true);
  const legacyEvent = eventSchemas['plan.submitted'].parse({
    ...run[4],
    payload: { plan: legacyPlan },
  });
  expect(projectUpTo([...run.slice(0, 4), legacyEvent], 5).plans[plan.id]!.status).toBe(
    'awaiting_approval',
  );
});

it('defines strict decision request/response and plan-ID route schemas', () => {
  expect(routes.decidePlan).toMatchObject({
    method: 'POST',
    path: '/api/plans/:id/decision',
    status: 200,
  });
  expect(
    planDecisionRequestSchema.parse({ decision: 'reject', reason: '  Narrow the scope  ' }),
  ).toEqual({ decision: 'reject', reason: 'Narrow the scope' });
  for (const decision of ['approve', 'reject'])
    expect(planDecisionRequestSchema.safeParse({ decision }).success).toBe(true);
  for (const body of [
    { decision: 'approved' },
    { decision: 'approve', approvedBy: 'agent' },
    { decision: 'reject', reason: '' },
  ])
    expect(planDecisionRequestSchema.safeParse(body).success).toBe(false);
  expect(routes.decidePlan.params.safeParse({ id: '' }).success).toBe(false);
  expect(
    planDecisionResponseSchema.safeParse({ planId: plan.id, status: 'approved' }).success,
  ).toBe(true);
  expect(
    planDecisionResponseSchema.safeParse({ planId: plan.id, status: 'awaiting_approval' }).success,
  ).toBe(false);
});

it('defines JSON-only mutable metadata independently of idempotency records', () => {
  expectTypeOf<HelixStore['getMeta']>().toEqualTypeOf<
    (scope: string, key: string) => Promise<MetaValue | undefined>
  >();
  expectTypeOf<HelixStore['setMeta']>().toEqualTypeOf<
    (scope: string, key: string, value: MetaValue) => Promise<void>
  >();
  for (const value of [null, false, 'resume-token', 0, { receipt: ['id', true] }])
    expect(metaValueSchema.safeParse(value).success).toBe(true);
  for (const value of [undefined, NaN, Infinity, () => 1, { token: undefined }])
    expect(metaValueSchema.safeParse(value).success).toBe(false);
});
