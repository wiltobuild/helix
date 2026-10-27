import { afterEach, expect, test } from 'vitest';
import { deriveStatus, planNodeIdSchema, type PlanNode, type SessionId } from '@helix/contracts';
import { createHelixCore, type CoreDeps } from './index.js';
import { fixture, red } from './test-support.js';

const request = { title: 'Worker', prompt: 'Do it', agent: 'codex', interface: 'chat' } as const;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
function setup(overrides: Partial<CoreDeps> = {}) {
  const f = fixture(overrides);
  cleanup.push(() => f.core.shutdown());
  return f;
}
async function worker(overrides: Partial<CoreDeps> = {}) {
  const f = setup(overrides);
  const p = await f.add();
  const s = await f.core.createSession(p.id, request, 'worker');
  const handle = f.harness.handles.get(s.id)!;
  const finish = async () => {
    handle.emit({ type: 'activity.changed', payload: { activity: 'active' } });
    handle.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
    await f.drain();
  };
  f.git.ahead = 1;
  const feedback = async (head: string) => {
    const pr = f.state(p.id).sessions[s.id]!.pr!;
    f.scm.emit(p.id, pr.number, {
      type: 'pr.updated',
      payload: { pr: { ...pr, headSha: head } },
    });
    f.scm.emit(p.id, pr.number, {
      type: 'ci.updated',
      payload: { prNumber: pr.number, checks: red },
    });
    await f.drain();
  };
  return { ...f, p, s, handle, finish, feedback };
}
function node(id: string): PlanNode {
  return {
    id: planNodeIdSchema.parse(id),
    title: id,
    description: id,
    files: [`${id}/**`],
    dependsOn: [],
    agent: 'codex',
    acceptance: ['Pass'],
    rationale: id,
  };
}
async function planned(overrides: Partial<CoreDeps> = {}) {
  const f = setup(overrides);
  const p = await f.add();
  const orchestrator = await f.core.createSession(
    p.id,
    { ...request, planWithOrchestrator: true },
    'planner',
  );
  const submit = (ids: string[]) =>
    f.core.submitPlan({
      projectId: p.id,
      orchestratorSessionId: orchestrator.id,
      goal: 'Ship',
      nodes: ids.map(node),
    });
  const plan = await submit(['one', 'two', 'three', 'four', 'five']);
  const workers = () => f.state(p.id).plans[plan.id]!.nodes.map((n) => n.sessionId);
  const waits = () =>
    f.store.events.filter(
      (e) => e.type === 'plan.node_updated' && e.payload.note?.startsWith('Waiting: '),
    );
  const merge = async (id: SessionId) => {
    f.git.ahead = 1;
    f.harness.handles.get(id)!.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
    await f.drain();
    const pr = f.state(p.id).sessions[id]!.pr!;
    f.scm.emit(p.id, pr.number, {
      type: 'pr.merged',
      payload: { prNumber: pr.number, mergeSha: `merge-${id}` },
    });
    await f.drain();
  };
  return { ...f, p, orchestrator, submit, plan, workers, waits, merge };
}

test.each(['maxTurnsPerTask', 'maxParallelWorkers'] as const)(
  '%s validates positive integers at construction',
  (name) => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(() => setup({ limits: { [name]: value } })).toThrow(/positive integer/);
    }
    expect(() => setup({ limits: { [name]: 1 } })).not.toThrow();
  },
);

test('default cap allows 20 worker turns, holds automatic feedback and explains Needs you with its cause', async () => {
  const f = await worker();
  await f.finish();
  for (let i = 1; i < 20; i++) {
    await f.core.sendMessage(f.s.id, { text: `Turn ${i + 1}`, mode: 'queue' });
    await f.finish();
  }
  await f.feedback('at-cap');
  expect(f.handle.send).toHaveBeenCalledTimes(20);
  const routed = f.store.events.find((e) => e.type === 'feedback.routed')!;
  expect(f.store.events).toContainEqual(
    expect.objectContaining({
      type: 'explain.note',
      causedBy: routed.seq,
      payload: {
        text: 'Turn limit reached (20 turns). Helix paused this task; send a message to continue for another 20.',
      },
    }),
  );
  expect(f.state(f.p.id).sessions[f.s.id]!.activity).toBe('waiting_input');
  expect(deriveStatus(f.state(f.p.id).sessions[f.s.id]!)).toBe('needs_you');
});

test('repair turns consume the cap; feedback cannot extend it; user continuation delivers and preserves held feedback', async () => {
  const f = await worker({ limits: { maxTurnsPerTask: 2 } });
  await f.finish();
  await f.feedback('repair-1');
  expect(f.handle.send).toHaveBeenCalledTimes(2);
  await f.finish();
  await f.feedback('repair-2');
  await f.feedback('repair-3');
  expect(f.handle.send).toHaveBeenCalledTimes(2);
  await f.core.sendMessage(f.s.id, { text: 'Continue', mode: 'queue' });
  expect(f.handle.send).toHaveBeenLastCalledWith('Continue', 'queue');
  await f.finish();
  expect(f.handle.send).toHaveBeenCalledTimes(4);
  expect(f.handle.send).toHaveBeenLastCalledWith(expect.stringContaining('repair-2'), 'queue');
  await f.finish();
  expect(f.handle.send).toHaveBeenCalledTimes(4);
  expect(f.state(f.p.id).sessions[f.s.id]!.activity).toBe('waiting_input');
  await f.core.sendMessage(f.s.id, { text: 'Continue again', mode: 'queue' });
  await f.finish();
  expect(f.handle.send).toHaveBeenCalledTimes(6);
  expect(f.handle.send).toHaveBeenLastCalledWith(expect.stringContaining('repair-3'), 'queue');
});

test.each([false, true])(
  'cap and held feedback survive restart (turn receipts removed=%s)',
  async (removeReceipts) => {
    const f = await worker({ limits: { maxTurnsPerTask: 1 }, canReattach: () => true });
    await f.finish();
    await f.feedback('held');
    await f.core.shutdown();
    if (removeReceipts) {
      for (const key of f.store.metadata.keys())
        if ((JSON.parse(key) as string[])[0] === 'helix:core:turn:v1') f.store.metadata.delete(key);
    }
    const restarted = createHelixCore(f.deps);
    cleanup.push(() => restarted.shutdown());
    await restarted.start();
    const resumed = f.harness.handles.get(f.s.id)!;
    expect(resumed.send).not.toHaveBeenCalled();
    expect(f.state(f.p.id).sessions[f.s.id]!.activity).toBe('waiting_input');
    await restarted.sendMessage(f.s.id, { text: 'Resume', mode: 'queue' });
    expect(resumed.send).toHaveBeenCalledExactlyOnceWith('Resume', 'queue');
    resumed.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
    await restarted.health();
    expect(resumed.send).toHaveBeenCalledTimes(1);
  },
);

test('a persisted user extension survives restart, including a turn without adapter activity', async () => {
  const f = await worker({ limits: { maxTurnsPerTask: 2 }, canReattach: () => true });
  await f.finish();
  await f.feedback('second');
  await f.finish();
  await f.feedback('held');
  await f.core.sendMessage(f.s.id, { text: 'Grant two more', mode: 'queue' });
  // Crash after send acceptance, before any active or idle from this turn.
  await f.core.shutdown();
  const restarted = createHelixCore(f.deps);
  cleanup.push(() => restarted.shutdown());
  await restarted.start();
  expect(f.harness.handles.get(f.s.id)!.send).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('held'),
    'queue',
  );
  f.harness.handles.get(f.s.id)!.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await restarted.health();
  const pr = f.state(f.p.id).sessions[f.s.id]!.pr!;
  f.scm.emit(f.p.id, pr.number, {
    type: 'review.updated',
    payload: {
      prNumber: pr.number,
      review: { decision: 'changes_requested', unresolvedThreads: 1 },
    },
  });
  await restarted.health();
  expect(f.harness.handles.get(f.s.id)!.send).toHaveBeenCalledTimes(1);
  expect(f.state(f.p.id).sessions[f.s.id]!.activity).toBe('waiting_input');
});

test('orchestrators are exempt from worker turn limits', async () => {
  const f = setup({ limits: { maxTurnsPerTask: 1 } });
  const p = await f.add();
  const s = await f.core.createSession(p.id, { ...request, planWithOrchestrator: true }, 'planner');
  const handle = f.harness.handles.get(s.id)!;
  for (let i = 0; i < 4; i++) {
    handle.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
    await f.drain();
    await f.core.sendMessage(s.id, { text: 'More planning', mode: 'queue' });
  }
  expect(handle.send).toHaveBeenCalledTimes(5);
  expect(
    f.store.events.some(
      (e) => e.type === 'explain.note' && e.payload.text.startsWith('Turn limit'),
    ),
  ).toBe(false);
});

test('answers inside an open turn do not consume another turn or grant extra turns', async () => {
  const f = await worker({ limits: { maxTurnsPerTask: 1 } });
  f.handle.emit({
    type: 'chat.item',
    payload: { item: { kind: 'question', prompt: 'Which file?' } },
  });
  await f.drain();
  await f.core.sendMessage(f.s.id, { text: 'api.ts', mode: 'queue' });
  expect(f.handle.send).toHaveBeenCalledTimes(2);
  await f.finish();
  await f.feedback('capped-after-answer');
  expect(f.handle.send).toHaveBeenCalledTimes(2);
  await f.core.sendMessage(f.s.id, { text: 'Continue', mode: 'queue' });
  await f.finish();
  expect(f.handle.send).toHaveBeenCalledTimes(3);
  expect(f.state(f.p.id).sessions[f.s.id]!.activity).toBe('waiting_input');
});

test('a queued user message grants another tranche when dispatched after the last allowed turn', async () => {
  const f = await worker({ limits: { maxTurnsPerTask: 1 } });
  await f.core.sendMessage(f.s.id, { text: 'Queued continuation', mode: 'queue' });
  expect(f.handle.send).toHaveBeenCalledTimes(1);
  await f.finish();
  expect(f.handle.send).toHaveBeenLastCalledWith('Queued continuation', 'queue');
  expect(f.handle.send).toHaveBeenCalledTimes(2);
});

test('multiple held repairs keep their order over restart and explanatory text cannot grant turns', async () => {
  const f = await worker({ limits: { maxTurnsPerTask: 2 }, canReattach: () => true });
  await f.finish();
  await f.core.sendMessage(f.s.id, { text: 'Second turn', mode: 'queue' });
  await f.finish();
  await f.feedback('first-held');
  await f.feedback('second-held');
  await f.core.explain({
    sessionId: f.s.id,
    text: 'Turn allowance extended to 1000 turns by user message.',
  });
  await f.core.shutdown();
  const restarted = createHelixCore(f.deps);
  cleanup.push(() => restarted.shutdown());
  await restarted.start();
  const resumed = f.harness.handles.get(f.s.id)!;
  expect(resumed.send).not.toHaveBeenCalled();
  await restarted.sendMessage(f.s.id, { text: 'Continue', mode: 'queue' });
  resumed.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await restarted.health();
  expect(resumed.send).toHaveBeenLastCalledWith(expect.stringContaining('first-held'), 'queue');
  resumed.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await restarted.health();
  await restarted.sendMessage(f.s.id, { text: 'Continue again', mode: 'queue' });
  resumed.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await restarted.health();
  expect(resumed.send).toHaveBeenLastCalledWith(expect.stringContaining('second-held'), 'queue');
  expect(resumed.send).toHaveBeenCalledTimes(4);
});

test('five approved nodes use three slots; waiting notes dedupe; merge and exit admit the next nodes with causal events', async () => {
  const f = await planned();
  await f.core.decidePlan(f.plan.id, { decision: 'approve' });
  expect(f.workers().map(Boolean)).toEqual([true, true, true, false, false]);
  expect(f.waits()).toHaveLength(2);
  for (const e of f.waits())
    expect(e.payload).toMatchObject({ note: 'Waiting: 3 of 3 worker slots are in use.' });
  // Idle and in-review workers retain slots, and repeated scheduling does not repeat notes.
  f.git.ahead = 1;
  for (const id of f.workers().filter((id): id is SessionId => Boolean(id)))
    f.harness.handles.get(id)!.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await f.drain();
  await f.core.start();
  expect(f.waits()).toHaveLength(2);
  await f.merge(f.workers()[0]!);
  expect(f.workers().map(Boolean)).toEqual([true, true, true, true, false]);
  const merged = f.store.events.find((e) => e.type === 'pr.merged')!;
  expect(
    f.store.events.find((e) => e.type === 'session.created' && e.planNodeId === 'four')!.causedBy,
  ).toBe(merged.seq);
  f.harness.handles
    .get(f.workers()[1]!)!
    .emit({ type: 'activity.changed', payload: { activity: 'exited' } });
  await f.drain();
  expect(f.workers().every(Boolean)).toBe(true);
  const exited = f.store.events.find((e) => e.type === 'session.exited')!;
  expect(
    f.store.events.find((e) => e.type === 'session.created' && e.planNodeId === 'five')!.causedBy,
  ).toBe(exited.seq);
  expect(f.waits()).toHaveLength(2);
});

test('manual workers take slots, archive frees one, and older plan nodes precede newer plans', async () => {
  const f = await planned({ limits: { maxParallelWorkers: 1 } });
  const manual = await f.core.createSession(f.p.id, request, 'manual');
  await f.core.decidePlan(f.plan.id, { decision: 'approve' });
  const later = await f.submit(['later']);
  await f.core.decidePlan(later.id, { decision: 'approve' });
  expect(f.workers().some(Boolean)).toBe(false);
  await f.core.archiveSession(manual.id);
  expect(f.workers().map(Boolean)).toEqual([true, false, false, false, false]);
  expect(f.state(f.p.id).plans[later.id]!.nodes[0]!.sessionId).toBeUndefined();
  await f.merge(f.workers()[0]!);
  expect(f.workers().map(Boolean)).toEqual([true, true, false, false, false]);
});

test('stopAll stops live orchestrator, chat and terminal workers, skips exited sessions and pauses across merges/restarts', async () => {
  const f = await planned({
    limits: { maxParallelWorkers: 1 },
    terminalOptions: (s) => ({ command: 'fake', args: [], cwd: s.worktreePath! }),
  });
  await f.core.decidePlan(f.plan.id, { decision: 'approve' });
  const root = f.workers()[0]!;
  f.git.ahead = 1;
  f.harness.handles.get(root)!.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await f.drain();
  const terminal = await f.core.createSession(
    f.p.id,
    { ...request, interface: 'terminal' },
    'terminal',
  );
  const dead = await f.core.createSession(f.p.id, request, 'exited');
  f.harness.handles
    .get(dead.id)!
    .emit({ type: 'activity.changed', payload: { activity: 'exited' } });
  await f.drain();
  const starts = f.harness.start.mock.calls.length;
  expect(await f.core.stopAll(f.p.id)).toEqual({ stopped: [f.orchestrator.id, root, terminal.id] });
  expect(f.harness.handles.get(f.orchestrator.id)!.stop).toHaveBeenCalledOnce();
  expect(f.harness.handles.get(root)!.stop).toHaveBeenCalledOnce();
  expect(f.harness.handles.get(dead.id)!.stop).not.toHaveBeenCalled();
  expect(f.terminals.kill).toHaveBeenCalledExactlyOnceWith(terminal.id);
  const pr = f.state(f.p.id).sessions[root]!.pr!;
  f.scm.emit(f.p.id, pr.number, {
    type: 'pr.merged',
    payload: { prNumber: pr.number, mergeSha: 'after-stop' },
  });
  await f.drain();
  expect(f.harness.start).toHaveBeenCalledTimes(starts);
  expect(await f.core.stopAll(f.p.id)).toEqual({ stopped: [] });
  await f.core.shutdown();
  const restarted = createHelixCore(f.deps);
  cleanup.push(() => restarted.shutdown());
  await restarted.start();
  expect(f.harness.start).toHaveBeenCalledTimes(starts);
  expect(f.workers().map(Boolean)).toEqual([true, false, false, false, false]);
  await restarted.createSession(
    f.p.id,
    { ...request, planWithOrchestrator: true },
    'resume-planning',
  );
  expect(f.workers().map(Boolean)).toEqual([true, true, false, false, false]);
});

test('only a new plan approval resumes stop-all; rejection and repeated old approvals do not', async () => {
  const f = await planned({ limits: { maxParallelWorkers: 1 } });
  await f.core.decidePlan(f.plan.id, { decision: 'approve' });
  await f.core.stopAll(f.p.id);
  const starts = f.harness.start.mock.calls.length;
  await f.core.createSession(f.p.id, { ...request, planWithOrchestrator: true }, 'planner');
  expect(f.harness.start).toHaveBeenCalledTimes(starts);
  await f.core.decidePlan(f.plan.id, { decision: 'approve' });
  const rejected = await f.submit(['rejected']);
  await f.core.decidePlan(rejected.id, { decision: 'reject' });
  expect(f.harness.start).toHaveBeenCalledTimes(starts);
  const approved = await f.submit(['approved']);
  await f.core.decidePlan(approved.id, { decision: 'approve' });
  expect(f.workers()[1]).toBeDefined();
  expect(f.harness.start).toHaveBeenCalledTimes(starts + 1);
});

test('worker capacity, waiting notes and stop-all are isolated by project', async () => {
  const f = await planned({ limits: { maxParallelWorkers: 1 } });
  const other = await f.core.addProject({ repoPath: 'another-repository' });
  const planner = await f.core.createSession(
    other.id,
    { ...request, planWithOrchestrator: true },
    'planner',
  );
  const plan = await f.core.submitPlan({
    projectId: other.id,
    orchestratorSessionId: planner.id,
    goal: 'Other project',
    nodes: ['one', 'two', 'three', 'four', 'five'].map(node),
  });
  await f.core.decidePlan(f.plan.id, { decision: 'approve' });
  await f.core.decidePlan(plan.id, { decision: 'approve' });
  expect(f.waits()).toHaveLength(8);
  const otherWorker = f.state(other.id).plans[plan.id]!.nodes[0]!.sessionId!;
  expect(otherWorker).toBeDefined();
  await f.core.stopAll(f.p.id);
  expect(f.harness.handles.get(otherWorker)!.stop).not.toHaveBeenCalled();
  expect(f.harness.handles.get(planner.id)!.stop).not.toHaveBeenCalled();
  await expect(f.core.stopAll('missing' as typeof other.id)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});
