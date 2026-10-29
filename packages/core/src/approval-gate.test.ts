import { expect, test, vi } from 'vitest';
import { planNodeIdSchema, type PlanNode } from '@helix/contracts';
import { createHelixCore } from './index.js';
import { fixture, green, timestamp } from './test-support.js';

const request = {
  title: 'Planner',
  prompt: 'Ship this',
  agent: 'codex',
  interface: 'chat',
  planWithOrchestrator: true,
} as const;
function node(id: string, dependsOn: string[] = []): PlanNode {
  return {
    id: planNodeIdSchema.parse(id),
    title: id,
    description: id,
    files: [`src/${id}/**`],
    acceptance: ['Tests pass'],
    dependsOn: dependsOn.map((id) => planNodeIdSchema.parse(id)),
    agent: 'codex',
    rationale: id,
  };
}
async function setup() {
  const f = fixture();
  const p = await f.add();
  const orchestrator = await f.core.createSession(p.id, request, 'planner');
  const submit = (nodes: PlanNode[]) =>
    f.core.submitPlan({
      projectId: p.id,
      orchestratorSessionId: orchestrator.id,
      goal: 'Ship',
      nodes,
    });
  return { ...f, p, orchestrator, submit };
}

test('submission waits; approval starts roots caused by the approval event', async () => {
  const f = await setup();
  const plan = await f.submit([node('api')]);
  expect(plan.nodes[0]!.sessionId).toBeUndefined();
  expect(f.harness.start).toHaveBeenCalledTimes(1);
  await f.core.start();
  expect(f.harness.start).toHaveBeenCalledTimes(1);
  await f.core.decidePlan(plan.id, { decision: 'approve' });
  const approved = f.store.events.find((e) => e.type === 'plan.approved')!;
  const worker = f.store.events.find(
    (e) => e.type === 'session.created' && e.planNodeId === 'api',
  )!;
  expect(worker.causedBy).toBe(approved.seq);
  expect(f.harness.start).toHaveBeenCalledTimes(2);
  await f.core.decidePlan(plan.id, { decision: 'approve' });
  expect(f.harness.start).toHaveBeenCalledTimes(2);
  await f.core.shutdown();
});

test.each(['awaiting_approval', 'rejected'] as const)(
  'restart never schedules a %s plan',
  async (status) => {
    const f = await setup();
    const plan = await f.submit([node('api')]);
    if (status === 'rejected') await f.core.decidePlan(plan.id, { decision: 'reject' });
    const restarted = createHelixCore(f.deps);
    await restarted.start();
    await restarted.start();
    expect(f.state(f.p.id).plans[plan.id]!.status).toBe(status);
    expect(f.store.events.filter((e) => e.type === 'session.created' && e.planNodeId)).toEqual([]);
    expect(f.git.create).toHaveBeenCalledTimes(1);
    await restarted.shutdown();
  },
);

test('restart recovers an approval persisted before any root worker was created', async () => {
  const f = await setup();
  const plan = await f.submit([node('api')]);
  const submitted = f.store.events.find((e) => e.type === 'plan.submitted')!;
  const [approved] = await f.store.append([
    {
      v: 1,
      ts: timestamp,
      projectId: f.p.id,
      sessionId: f.orchestrator.id,
      causedBy: submitted.seq,
      type: 'plan.approved',
      payload: { planId: plan.id, approvedBy: 'human' },
    },
  ]);
  const restarted = createHelixCore(f.deps);
  await restarted.start();
  expect(
    f.store.events.find((e) => e.type === 'session.created' && e.planNodeId === 'api'),
  ).toMatchObject({ causedBy: approved!.seq });
  await restarted.shutdown();
});

test.each([false, true])('restart starts merged dependents (legacy=%s)', async (legacy) => {
  const f = await setup();
  const plan = await f.submit([node('api'), node('ui', ['api'])]);
  await f.core.decidePlan(plan.id, { decision: 'approve' });
  const root = f.state(f.p.id).plans[plan.id]!.nodes[0]!.sessionId!;
  f.git.ahead = 1;
  f.harness.handles.get(root)!.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await f.drain();
  const pr = f.state(f.p.id).sessions[root]!.pr!;
  if (legacy) {
    f.store.events = f.store.events.map((e) =>
      e.type === 'plan.approved'
        ? { ...e, type: 'explain.note' as const, payload: { text: 'Legacy worker scheduled' } }
        : e,
    );
    const submission = f.store.events.find((e) => e.type === 'plan.submitted')!;
    if (submission.type === 'plan.submitted')
      for (const n of submission.payload.plan.nodes) Reflect.deleteProperty(n, 'files');
  }
  // Simulate an authoritative merge persisted while the old daemon is unavailable.
  await f.store.append([
    {
      v: 1,
      ts: timestamp,
      projectId: f.p.id,
      sessionId: root,
      type: 'pr.merged',
      payload: { prNumber: pr.number, mergeSha: 'merged-root' },
    },
  ]);
  const restarted = createHelixCore(f.deps);
  await restarted.start();
  const recovered = f.state(f.p.id).plans[plan.id]!;
  expect(recovered.status).toBe(legacy ? 'awaiting_approval' : 'approved');
  if (legacy) expect(recovered.nodes.map((n) => n.files)).toEqual([[], []]);
  const dependent = recovered.nodes[1]!.sessionId!;
  expect(dependent).toBeDefined();
  // Every new task fetches its base, including the dependent started after the restart.
  expect(f.git.fetchBase).toHaveBeenLastCalledWith(f.p.repoPath, f.p.defaultBranch);
  const created = f.store.events.find(
    (e) => e.type === 'session.created' && e.sessionId === dependent,
  )!;
  expect(created.causedBy).toBe(f.store.events.find((e) => e.type === 'pr.merged')!.seq);
  await restarted.shutdown();
});

test('all overlapping glob pairs are named for parallel tasks; ordered tasks may overlap transitively', async () => {
  const f = await setup();
  const a = { ...node('api'), files: ['src/shared/**', 'SRC/shared/types.ts'] };
  const b = { ...node('ui'), files: ['src/shared/types.ts'] };
  const before = f.store.events.length;
  await expect(f.submit([a, b])).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
    message:
      'Parallel tasks "api" and "ui" both claim files: src/shared/** ↔ src/shared/types.ts, SRC/shared/types.ts ↔ src/shared/types.ts',
  });
  expect(f.store.events).toHaveLength(before);
  await expect(
    f.submit([a, node('middle', ['api']), { ...b, dependsOn: [planNodeIdSchema.parse('middle')] }]),
  ).resolves.toBeDefined();
  await expect(f.submit([{ ...node('empty'), files: [] }])).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  });
  await f.core.shutdown();
});

test('shared-interface warning is causal, one per parallel pair, and recognizes transitive common dependencies', async () => {
  const f = await setup();
  await f.submit([
    { ...node('api'), description: 'Define the interface' },
    { ...node('ui'), description: 'Consume the API shape' },
  ]);
  const notes = f.store.events.filter((e) => e.type === 'explain.note');
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    sessionId: f.orchestrator.id,
    causedBy: f.store.events.find((e) => e.type === 'plan.submitted')!.seq,
  });
  expect(notes[0]!.payload.text).toContain('"api" and "ui"');
  await f.submit([
    node('contract'),
    node('bridge', ['contract']),
    { ...node('backend', ['contract']), description: 'Shared type schema' },
    { ...node('client', ['bridge']), description: 'Contract interface' },
  ]);
  expect(f.store.events.filter((e) => e.type === 'explain.note')).toHaveLength(1);
  await f.core.shutdown();
});

test('orchestrator receives injected instructions first while its stored prompt stays original', async () => {
  const orchestratorPrompt = vi.fn(() => 'Use the helix CLI to submit a plan.');
  const f = fixture({ orchestratorPrompt });
  const p = await f.add();
  const s = await f.core.createSession(p.id, request, 'planner');
  expect(orchestratorPrompt).toHaveBeenCalledExactlyOnceWith({ project: p, session: s });
  expect(f.harness.handles.get(s.id)!.send).toHaveBeenNthCalledWith(
    1,
    `Use the helix CLI to submit a plan.\n\n${request.prompt}`,
    'queue',
  );
  expect(f.state(p.id).sessions[s.id]!.session.prompt).toBe(request.prompt);
  f.harness.handles.get(s.id)!.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await f.drain();
  await f.core.sendMessage(s.id, { text: 'Follow up', mode: 'queue' });
  expect(f.harness.handles.get(s.id)!.send).toHaveBeenLastCalledWith('Follow up', 'queue');
  expect(orchestratorPrompt).toHaveBeenCalledOnce();
  const worker = await f.core.createSession(
    p.id,
    { ...request, planWithOrchestrator: false },
    'worker',
  );
  expect(f.harness.handles.get(worker.id)!.send).toHaveBeenCalledExactlyOnceWith(
    request.prompt,
    'queue',
  );
  expect(orchestratorPrompt).toHaveBeenCalledOnce();
  await f.core.shutdown();
});

test('after A merges, B conflicting updates route exactly one repair caused by B pr.updated', async () => {
  const f = await setup();
  const plan = await f.submit([node('api'), node('ui')]);
  await f.core.decidePlan(plan.id, { decision: 'approve' });
  const [a, b] = f.state(f.p.id).plans[plan.id]!.nodes.map((n) => n.sessionId!);
  f.git.ahead = 1;
  for (const id of [a!, b!])
    f.harness.handles.get(id)!.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await f.drain();
  const aPr = f.state(f.p.id).sessions[a!]!.pr!;
  const bPr = f.state(f.p.id).sessions[b!]!.pr!;
  f.scm.emit(f.p.id, aPr.number, {
    type: 'ci.updated',
    payload: { prNumber: aPr.number, checks: green },
  });
  f.scm.emit(f.p.id, aPr.number, {
    type: 'review.updated',
    payload: { prNumber: aPr.number, review: { decision: 'approved', unresolvedThreads: 0 } },
  });
  await f.drain();
  await f.core.merge(a!);
  for (let i = 0; i < 2; i++)
    f.scm.emit(f.p.id, bPr.number, {
      type: 'pr.updated',
      payload: { pr: { ...bPr, mergeable: 'conflicting' } },
    });
  await f.drain();
  const routed = f.store.events.filter((e) => e.type === 'feedback.routed');
  expect(routed).toHaveLength(1);
  expect(routed[0]).toMatchObject({
    sessionId: b,
    payload: { toSessionId: b, reason: 'merge_conflict' },
    causedBy: f.store.events.find((e) => e.type === 'pr.updated' && e.sessionId === b)!.seq,
  });
  expect(f.harness.handles.get(b!)!.send).toHaveBeenLastCalledWith(
    expect.stringContaining('merge_conflict'),
    'queue',
  );
  await f.core.shutdown();
});
