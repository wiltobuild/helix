import { expect, test } from 'vitest';
import { planIdSchema } from '@helix/contracts';
import { createHelixCore } from './index.js';
import { fixture } from './test-support.js';

async function pendingPlan() {
  const f = fixture();
  const project = await f.add();
  const orchestrator = await f.core.createSession(
    project.id,
    {
      title: 'Plan',
      prompt: 'Plan the change',
      agent: 'codex',
      interface: 'chat',
      planWithOrchestrator: true,
    },
    'planner',
  );
  // Empty plan isolates the new decision command from the scheduler work in #4.
  const plan = await f.core.submitPlan({
    projectId: project.id,
    orchestratorSessionId: orchestrator.id,
    goal: 'Test decisions',
    nodes: [],
  });
  return { ...f, project, plan };
}

test.each(['approve', 'reject'] as const)(
  'records a causal human %s decision and deduplicates concurrent retries',
  async (decision) => {
    const f = await pendingPlan();
    try {
      const request = {
        decision,
        ...(decision === 'reject' ? { reason: 'Separate the interface' } : {}),
      };
      const status = decision === 'approve' ? 'approved' : 'rejected';
      const results = await Promise.all([
        f.core.decidePlan(f.plan.id, request),
        f.core.decidePlan(f.plan.id, request),
      ]);
      expect(results).toEqual([
        { planId: f.plan.id, status },
        { planId: f.plan.id, status },
      ]);
      const events = f.store.events.filter(
        (e) => e.type === 'plan.approved' || e.type === 'plan.rejected',
      );
      expect(events).toHaveLength(1);
      const submission = f.store.events.find((e) => e.type === 'plan.submitted')!;
      expect(events[0]!.causedBy).toBe(submission.seq);
      expect(events[0]!.payload).toEqual(
        decision === 'approve'
          ? { planId: f.plan.id, approvedBy: 'human' }
          : { planId: f.plan.id, reason: request.reason },
      );
      expect(f.state(f.project.id).plans[f.plan.id]!.status).toBe(status);
      await expect(
        f.core.decidePlan(f.plan.id, { decision: decision === 'approve' ? 'reject' : 'approve' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await f.core.shutdown();
      const restarted = createHelixCore(f.deps);
      try {
        await restarted.start();
        await expect(restarted.decidePlan(f.plan.id, request)).resolves.toEqual({
          planId: f.plan.id,
          status,
        });
        expect(f.store.events.filter((e) => e.type === events[0]!.type)).toHaveLength(1);
      } finally {
        await restarted.shutdown();
      }
    } finally {
      await f.core.shutdown();
    }
  },
);

test('rejects unknown plans and invalid requests, and supplies a reason for an unexplained rejection', async () => {
  const f = await pendingPlan();
  try {
    await expect(
      f.core.decidePlan(planIdSchema.parse('missing'), { decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      f.core.decidePlan(f.plan.id, { decision: 'reject', reason: ' ' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f.state(f.project.id).plans[f.plan.id]!.status).toBe('awaiting_approval');
    await f.core.decidePlan(f.plan.id, { decision: 'reject' });
    expect(f.state(f.project.id).plans[f.plan.id]!.rejectionReason).toBe('Rejected by human');
    await expect(
      f.core.decidePlan(f.plan.id, { decision: 'reject', reason: 'different' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally {
    await f.core.shutdown();
  }
});
