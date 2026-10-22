import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  HelixError,
  approvalIdSchema,
  boardColumn,
  deriveStatus,
  planNodeIdSchema,
  projectIdSchema,
  pullRequestNumberSchema,
  sessionIdSchema,
  type CreateSessionRequest,
  type HelixEvent,
  type PlanNode,
  type SessionId,
} from '@helix/contracts';
import { createHelixCore } from './index.js';
import { resolveExecutable } from '@helix/harness';
import { FakeHandle, FakeHarness, fixture, green, red, timestamp } from './test-support.js';

vi.mock('@helix/harness', () => ({
  resolveExecutable: vi.fn(() => Promise.resolve(process.execPath)),
}));

const request: CreateSessionRequest = {
  title: 'API worker',
  prompt: 'Implement the API',
  agent: 'codex',
  interface: 'chat',
};

test.each(['codex', 'claude-code'])(
  'terminal %s delivers multiline prompt through PTY after spawning the resolved shim',
  async (agent) => {
    const f = fixture();
    const p = await f.add();
    const resolved = path.resolve('CLI directory', `${agent}.cmd`);
    vi.mocked(resolveExecutable).mockResolvedValueOnce(resolved).mockResolvedValueOnce(resolved);
    const prompt = 'Quotes " & | %PATH% !NAME! ^\nsecond line';
    const s = await f.core.createSession(
      p.id,
      { ...request, agent, interface: 'terminal', prompt, model: 'model-1' },
      'resolved',
    );
    expect(resolveExecutable).toHaveBeenLastCalledWith(agent === 'codex' ? 'codex' : 'claude');
    expect(f.terminals.spawn).toHaveBeenCalledExactlyOnceWith(s.id, {
      command: resolved,
      args: ['--model', 'model-1'],
      cwd: s.worktreePath,
    });
    expect(f.terminals.write).toHaveBeenCalledExactlyOnceWith(`\x1b[200~${prompt}\x1b[201~\r`);
  },
);

test('terminal missing executable fails before creating a worker', async () => {
  const f = fixture();
  const p = await f.add();
  vi.mocked(resolveExecutable).mockResolvedValueOnce(undefined);
  await expect(
    f.core.createSession(p.id, { ...request, interface: 'terminal' }, 'missing'),
  ).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE' });
  expect(f.git.create).not.toHaveBeenCalled();
  expect(f.terminals.spawn).not.toHaveBeenCalled();
});

test('core owns initial prompt delivery even with the deprecated auto-start option', async () => {
  const f = fixture({ harnessStartsWithPrompt: () => true });
  const p = await f.add();
  const s = await f.core.createSession(p.id, request, 'auto-start');
  expect(f.harness.start.mock.calls[0]?.[0].session.prompt).toBe(request.prompt);
  expect(f.harness.handles.get(s.id)!.send).toHaveBeenCalledExactlyOnceWith(
    request.prompt,
    'queue',
  );
  // A fresh daemon with no usable token must not repeat the already-delivered task.
  f.store.records.clear();
  const started = f.store.events.find((e) => e.type === 'session.started')!;
  await f.store.remember('helix:core:delivered:v1', String(started.seq), 'v1', true);
  const restarted = createHelixCore(f.deps);
  await restarted.start();
  expect(f.harness.start.mock.calls.at(-1)?.[0].session.prompt).toBe(request.prompt);
  expect(f.harness.handles.get(s.id)!.send).not.toHaveBeenCalled();
  expect(f.state(p.id).sessions[s.id]!.session.prompt).toBe(request.prompt);
  await restarted.shutdown();
});

test('startup logs malformed stored events and never redelivers rejected feedback', async () => {
  const error = vi.fn();
  const f = fixture({ log: { error } });
  const p = await f.add();
  await f.store.append([
    {
      v: 1,
      ts: timestamp,
      projectId: p.id,
      type: 'feedback.routed',
      payload: {
        prNumber: pullRequestNumberSchema.parse(1),
        reason: 'ci_failed',
        summary: 'Do not deliver',
        toSessionId: sessionIdSchema.parse('missing'),
      },
    },
  ]);
  const restarted = createHelixCore(f.deps);
  await restarted.start();
  expect(await restarted.health()).toEqual({ status: 'ok', version: '0.0.0' });
  expect(error).toHaveBeenCalledWith(expect.stringContaining('1 anomalous events'));
  expect(f.harness.start).not.toHaveBeenCalled();
  await restarted.createSession(p.id, request, 'after-reload');
  expect(f.harness.start).toHaveBeenCalledOnce();
  await restarted.shutdown();
});
const nodes: PlanNode[] = [
  {
    id: planNodeIdSchema.parse('api'),
    title: 'API',
    files: ['src/api/**'],
    description: 'Implement API',
    acceptance: ['Tests pass', 'Errors are documented'],
    dependsOn: [],
    agent: 'codex',
    rationale: 'Unlock the client',
  },
  {
    id: planNodeIdSchema.parse('ui'),
    title: 'UI',
    files: ['src/ui/**'],
    description: 'Implement UI',
    acceptance: ['Accessible'],
    dependsOn: [],
    agent: 'codex',
    rationale: 'Independent shell',
  },
  {
    id: planNodeIdSchema.parse('integration'),
    title: 'Integrate',
    files: ['src/integration/**'],
    description: 'Wire the API',
    acceptance: ['End to end works'],
    dependsOn: [planNodeIdSchema.parse('api')],
    agent: 'codex',
    rationale: 'Requires the API contract',
  },
];
const types = (events: HelixEvent[]) => events.map((e) => e.type);
const activity = (value: 'active' | 'idle' | 'blocked' | 'exited') =>
  ({ type: 'activity.changed', payload: { activity: value } }) as const;

async function openWorker(f = fixture()) {
  const p = await f.add();
  const s = await f.core.createSession(p.id, request, 'worker');
  f.git.ahead = 1;
  f.harness.handles.get(s.id)!.emit(activity('idle'));
  await f.drain();
  const pr = f.state(p.id).sessions[s.id]!.pr!;
  return { ...f, p, s, pr };
}
async function fail(f: Awaited<ReturnType<typeof openWorker>>, head: string) {
  const current = f.state(f.p.id).sessions[f.s.id]!.pr!;
  f.scm.emit(f.p.id, f.pr.number, {
    type: 'pr.updated',
    payload: { pr: { ...current, headSha: head } },
  });
  f.scm.emit(f.p.id, f.pr.number, {
    type: 'ci.updated',
    payload: { prNumber: f.pr.number, checks: red },
  });
  await f.drain();
}
async function ready(f: Awaited<ReturnType<typeof openWorker>>) {
  f.scm.emit(f.p.id, f.pr.number, {
    type: 'ci.updated',
    payload: { prNumber: f.pr.number, checks: green },
  });
  f.scm.emit(f.p.id, f.pr.number, {
    type: 'review.updated',
    payload: { prNumber: f.pr.number, review: { decision: 'approved', unresolvedThreads: 0 } },
  });
  await f.drain();
}

test('a merged snapshot survives restart until the authoritative merge arrives, then dedupes it', async () => {
  const f = await openWorker();
  f.scm.emit(f.p.id, f.pr.number, {
    type: 'pr.updated',
    payload: { pr: { ...f.pr, state: 'merged' } },
  });
  await f.drain();
  expect(f.store.events.filter((e) => e.type === 'pr.merged')).toHaveLength(0);
  expect(f.scm.unsubscribe).not.toHaveBeenCalled();
  const restarted = createHelixCore(f.deps);
  await restarted.start();
  expect(f.scm.watch).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 2; i++)
    f.scm.emit(f.p.id, f.pr.number, {
      type: 'pr.merged',
      payload: { prNumber: f.pr.number, mergeSha: 'external-merge' },
    });
  await restarted.health();
  expect(f.store.events.filter((e) => e.type === 'pr.merged')).toHaveLength(1);
  expect(f.scm.unsubscribe).toHaveBeenCalledOnce();
  await restarted.shutdown();
});

async function golden() {
  const f = fixture();
  const p = await f.add();
  const orchestrator = await f.core.createSession(
    p.id,
    { ...request, title: 'Planner', planWithOrchestrator: true },
    'planner',
  );
  const plan = await f.core.submitPlan({
    projectId: p.id,
    orchestratorSessionId: orchestrator.id,
    goal: 'Ship an API and client',
    nodes,
  });
  const api = plan.nodes[0]!.sessionId!;
  const ui = plan.nodes[1]!.sessionId!;
  const columns = () => {
    const s = f.state(p.id);
    return {
      api: boardColumn(deriveStatus(s.sessions[api]!)),
      ui: boardColumn(deriveStatus(s.sessions[ui]!)),
      integration: s.plans[plan.id]!.nodeStatus[nodes[2]!.id],
    };
  };
  const checkpoints = [columns()];
  f.git.ahead = 1;
  const handle = f.harness.handles.get(api)!;
  handle.emit(activity('idle'));
  await f.drain();
  const pr = f.state(p.id).sessions[api]!.pr!;
  f.scm.emit(p.id, pr.number, {
    type: 'ci.updated',
    payload: { prNumber: pr.number, checks: red },
  });
  await f.drain();
  checkpoints.push(columns());
  const routed = f.store.events.find((e) => e.type === 'feedback.routed')!;
  expect(f.store.events.find((e) => e.seq === routed.causedBy)?.type).toBe('ci.updated');
  expect(handle.send).toHaveBeenLastCalledWith(expect.stringContaining('api.test.ts'), 'queue');
  handle.emit(activity('active'));
  handle.emit({
    type: 'reasoning.summary',
    payload: { text: 'Repair validation', source: 'agent' },
  });
  handle.emit(activity('idle'));
  await f.drain();
  f.scm.emit(p.id, pr.number, {
    type: 'pr.updated',
    payload: { pr: { ...pr, headSha: 'fixed-head' } },
  });
  f.scm.emit(p.id, pr.number, {
    type: 'ci.updated',
    payload: { prNumber: pr.number, checks: green },
  });
  f.scm.emit(p.id, pr.number, {
    type: 'review.updated',
    payload: { prNumber: pr.number, review: { decision: 'approved', unresolvedThreads: 0 } },
  });
  await f.drain();
  checkpoints.push(columns());
  await f.core.merge(api);
  checkpoints.push(columns());
  return { ...f, p, api, ui, plan, checkpoints, routed };
}

test('golden plan → PR → CI repair → approval → merge → dependent worker', async () => {
  const f = await golden();
  expect(f.checkpoints).toEqual([
    { api: 'working', ui: 'working', integration: 'pending' },
    { api: 'in_review', ui: 'working', integration: 'pending' },
    { api: 'ready_to_merge', ui: 'working', integration: 'pending' },
    { api: 'archive', ui: 'working', integration: 'working' },
  ]);
  expect(types(f.store.events)).toEqual([
    'project.added',
    'session.created',
    'worktree.created',
    'session.started',
    'plan.submitted',
    'session.created',
    'worktree.created',
    'session.started',
    'plan.node_updated',
    'session.created',
    'worktree.created',
    'session.started',
    'plan.node_updated',
    'activity.changed',
    'worktree.diff_updated',
    'pr.opened',
    'ci.updated',
    'feedback.routed',
    'activity.changed',
    'reasoning.summary',
    'activity.changed',
    'pr.updated',
    'ci.updated',
    'review.updated',
    'pr.merged',
    'session.created',
    'explain.note',
    'worktree.created',
    'session.started',
    'plan.node_updated',
  ]);
  const related = f.store.events.filter((e) => e.sessionId === f.api);
  const created = related.find((e) => e.type === 'session.created')!;
  const tree = related.find((e) => e.type === 'worktree.created')!;
  const started = related.find((e) => e.type === 'session.started')!;
  expect(tree.causedBy).toBe(created.seq);
  expect(started.causedBy).toBe(tree.seq);
  expect(related.find((e) => e.type === 'reasoning.summary')).toMatchObject({
    causedBy: f.routed.seq,
    planNodeId: nodes[0]!.id,
  });
  expect(f.scm.openPr).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'API',
      body: 'Implement API\n\nRationale: Unlock the client\n\nAcceptance criteria:\n- Tests pass\n- Errors are documented',
    }),
  );
  expect(f.git.push).toHaveBeenCalledTimes(2);
  expect(f.scm.merge).toHaveBeenCalledWith(
    expect.objectContaining({ expectedHeadSha: 'fixed-head', method: 'squash' }),
  );
  const merge = f.store.events.find((e) => e.type === 'pr.merged')!;
  expect(f.store.events.at(-1)).toMatchObject({ type: 'plan.node_updated', causedBy: merge.seq });
  expect(f.state(f.p.id).anomalies).toEqual([]);
});

test('same inputs produce byte-identical event logs', async () => {
  const first = await golden();
  const second = await golden();
  expect(JSON.stringify(first.store.events)).toBe(JSON.stringify(second.store.events));
});

test('retry sends the initial prompt even when a failed launch already captured a resume token', async () => {
  const f = fixture();
  const p = await f.add();
  f.harness.start.mockImplementationOnce((options) => {
    const h = new FakeHandle();
    h.resumeToken = `resume-${options.session.id}`;
    h.send.mockRejectedValueOnce(new Error('input rejected'));
    f.harness.handles.set(options.session.id, h);
    return Promise.resolve(h);
  });
  await expect(f.core.createSession(p.id, request, 'retry-prompt')).rejects.toMatchObject({
    code: 'HARNESS_UNAVAILABLE',
  });
  const s = await f.core.createSession(p.id, request, 'retry-prompt');
  expect(f.harness.handles.get(s.id)!.send).toHaveBeenCalledWith(request.prompt, 'queue');
  expect(f.store.events.filter((e) => e.type === 'session.created')).toHaveLength(1);
  expect(f.harness.start).toHaveBeenLastCalledWith(
    expect.objectContaining({ resumeToken: `resume-${s.id}` }),
  );
});

test('restart retains feedback and user message mode until approvals and blocking clear', async () => {
  const f = await openWorker();
  const approvalId = approvalIdSchema.parse('restart-permission');
  const oldHandle = f.harness.handles.get(f.s.id)!;
  oldHandle.emit(activity('blocked'));
  oldHandle.emit({
    type: 'approval.requested',
    payload: {
      approval: {
        id: approvalId,
        sessionId: f.s.id,
        kind: 'command',
        summary: 'Run tests?',
        detail: 'pnpm test',
        scope: 'once',
        requestedAt: timestamp,
      },
    },
  });
  await fail(f, 'head-1');
  await f.core.sendMessage(f.s.id, { text: 'Prioritize validation', mode: 'interrupt' });
  const restarted = createHelixCore(f.deps);
  await restarted.start();
  const handle = f.harness.handles.get(f.s.id)!;
  expect(handle.send).not.toHaveBeenCalled();
  await restarted.decideApproval(approvalId, { decision: 'approved' });
  expect(handle.send).not.toHaveBeenCalled();
  handle.emit(activity('idle'));
  for (let i = 0; i < 3; i++) await restarted.health();
  expect(handle.send).toHaveBeenCalledExactlyOnceWith('Prioritize validation', 'queue');
  handle.emit(activity('idle'));
  for (let i = 0; i < 3; i++) await restarted.health();
  expect(handle.send).toHaveBeenCalledTimes(2);
  expect(handle.send.mock.calls[1]?.[0]).toContain('Repair ci_failed');
  expect(f.store.events.filter((e) => e.type === 'feedback.routed')).toHaveLength(1);
});

test('feedback cannot overtake the cause of a user turn already queued at an idle boundary', async () => {
  const f = await openWorker();
  const handle = f.harness.handles.get(f.s.id)!;
  await f.core.sendMessage(f.s.id, { text: 'First turn', mode: 'queue' });
  handle.emit(activity('active'));
  await f.drain();
  await f.core.sendMessage(f.s.id, { text: 'Second turn', mode: 'queue' });
  const queued = f.store.events.at(-1)!;
  handle.emit(activity('idle'));
  await f.drain();
  await fail(f, 'head-1');
  const routed = f.store.events.find((e) => e.type === 'feedback.routed')!;
  handle.emit(activity('active'));
  handle.emit({
    type: 'reasoning.summary',
    payload: { text: 'Second user turn', source: 'agent' },
  });
  handle.emit(activity('idle'));
  await f.drain(); // Core must dispatch the queued repair before its emissions can arrive.
  expect(handle.send).toHaveBeenLastCalledWith(
    expect.stringContaining('Repair ci_failed'),
    'queue',
  );
  handle.emit(activity('active'));
  handle.emit({ type: 'reasoning.summary', payload: { text: 'CI repair turn', source: 'agent' } });
  await f.drain();
  expect(
    f.store.events.filter((e) => e.type === 'reasoning.summary').map((e) => e.causedBy),
  ).toEqual([queued.seq, routed.seq]);
});

test('a failed terminal attachment cleans up the process spawned by the failed command', async () => {
  const f = fixture();
  const p = await f.add();
  f.terminals.attach.mockRejectedValueOnce(new Error('attachment failed'));
  await expect(
    f.core.createSession(p.id, { ...request, interface: 'terminal' }, 'bad-terminal'),
  ).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE' });
  await f.drain();
  expect(f.terminals.kill).toHaveBeenCalledTimes(1);
  expect(f.terminals.list()).toEqual([]);
});

test('feedback held behind a block is discarded if the PR merges before delivery', async () => {
  const f = await openWorker();
  const handle = f.harness.handles.get(f.s.id)!;
  handle.emit(activity('blocked'));
  await fail(f, 'head-1');
  f.scm.emit(f.p.id, f.pr.number, {
    type: 'pr.merged',
    payload: { prNumber: f.pr.number, mergeSha: 'human-merge' },
  });
  await f.drain();
  handle.emit(activity('idle'));
  await f.drain();
  expect(handle.send).toHaveBeenCalledTimes(1);
});

describe('projects and idempotent commands', () => {
  test.each([
    'https://github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
  ])('detects GitHub remote %s', async (remote) => {
    const f = fixture();
    f.git.remote = remote;
    const p = await f.add();
    expect(p.github).toEqual({ owner: 'owner', repo: 'repo' });
    expect(
      await f.core.addProject({ repoPath: path.join(p.repoPath, '.'), name: 'ignored' }),
    ).toEqual(p);
    expect(types(f.store.events)).toEqual(['project.added']);
  });
  test('rejects non-repositories and ignores non-GitHub remotes', async () => {
    const f = fixture();
    f.git.isGitRepo.mockResolvedValueOnce(false);
    await expect(f.add()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    f.git.remote = 'https://github.com.evil.test/owner/repo.git';
    expect((await f.add()).github).toBeUndefined();
  });
  test('concurrent identical requests share identity and side effects; altered body conflicts', async () => {
    const f = fixture();
    const p = await f.add();
    const [a, b] = await Promise.all([
      f.core.createSession(p.id, request, 'same'),
      f.core.createSession(
        p.id,
        { interface: 'chat', agent: 'codex', prompt: request.prompt, title: request.title },
        'same',
      ),
    ]);
    expect(a).toEqual(b);
    expect(f.git.create).toHaveBeenCalledTimes(1);
    expect(f.harness.start).toHaveBeenCalledTimes(1);
    await expect(
      f.core.createSession(p.id, { ...request, prompt: 'Changed' }, 'same'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const restarted = createHelixCore(f.deps);
    expect(await restarted.createSession(p.id, request, 'same')).toEqual(a);
    expect(f.harness.start).toHaveBeenCalledTimes(1);
  });
  test('failed worktree creation retains reservation and retries without duplicating sessions', async () => {
    const f = fixture();
    const p = await f.add();
    f.git.create.mockRejectedValueOnce(new Error('git unavailable'));
    await expect(f.core.createSession(p.id, request, 'retry')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    const s = await f.core.createSession(p.id, request, 'retry');
    expect(f.store.events.filter((e) => e.type === 'session.created')).toHaveLength(1);
    expect(s.worktreePath).toBeDefined();
  });
  test('unknown agents and invalid bodies produce domain errors before side effects', async () => {
    const f = fixture();
    const p = await f.add();
    await expect(
      f.core.createSession(p.id, { ...request, agent: 'future' }, 'future'),
    ).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE' });
    await expect(
      f.core.createSession(p.id, { ...request, title: '' }, 'bad'),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f.store.events).toHaveLength(1);
  });
});

describe('feedback delivery', () => {
  test('dedupes identical CI failures by head and caps attempts per reason at three', async () => {
    const f = await openWorker();
    await fail(f, 'head-1');
    await fail(f, 'head-1');
    expect(f.store.events.filter((e) => e.type === 'feedback.routed')).toHaveLength(1);
    f.harness.handles.get(f.s.id)!.emit(activity('idle'));
    await f.drain();
    await fail(f, 'head-2');
    f.harness.handles.get(f.s.id)!.emit(activity('idle'));
    await f.drain();
    await fail(f, 'head-3');
    f.harness.handles.get(f.s.id)!.emit(activity('idle'));
    await f.drain();
    await fail(f, 'head-4');
    await fail(f, 'head-4');
    expect(f.store.events.filter((e) => e.type === 'feedback.routed')).toHaveLength(3);
    expect(f.store.events.filter((e) => e.type === 'explain.note')).toHaveLength(1);
    expect(deriveStatus(f.state(f.p.id).sessions[f.s.id]!)).toBe('needs_you');
    expect(f.harness.handles.get(f.s.id)!.send).toHaveBeenCalledTimes(4);
    f.scm.emit(f.p.id, f.pr.number, {
      type: 'review.updated',
      payload: {
        prNumber: f.pr.number,
        review: { decision: 'changes_requested', unresolvedThreads: 1 },
      },
    });
    await f.drain();
    expect(f.store.events.filter((e) => e.type === 'feedback.routed')).toHaveLength(4);
  });
  test('routes merge conflicts and review requests with exact causal parents', async () => {
    const f = await openWorker();
    f.scm.emit(f.p.id, f.pr.number, {
      type: 'pr.updated',
      payload: { pr: { ...f.pr, mergeable: 'conflicting' } },
    });
    f.scm.emit(f.p.id, f.pr.number, {
      type: 'review.updated',
      payload: {
        prNumber: f.pr.number,
        review: { decision: 'changes_requested', unresolvedThreads: 1 },
      },
    });
    await f.drain();
    const events = f.store.events.filter((e) => e.type === 'feedback.routed');
    expect(events.map((e) => e.payload.reason)).toEqual(['merge_conflict', 'changes_requested']);
    expect(
      events.map((e) => f.store.events.find((parent) => parent.seq === e.causedBy)?.type),
    ).toEqual(['pr.updated', 'review.updated']);
  });
  test('holds delivery until both approval and blocked activity clear', async () => {
    const f = await openWorker();
    const h = f.harness.handles.get(f.s.id)!;
    const id = approvalIdSchema.parse('permission');
    h.emit(activity('blocked'));
    h.emit({
      type: 'approval.requested',
      payload: {
        approval: {
          id,
          sessionId: f.s.id,
          kind: 'command',
          summary: 'Run tests?',
          detail: 'pnpm test',
          scope: 'once',
          requestedAt: timestamp,
        },
      },
    });
    await fail(f, 'head-1');
    expect(h.send).toHaveBeenCalledTimes(1);
    await f.core.sendMessage(f.s.id, { text: 'Also check the schema', mode: 'interrupt' });
    const approval = await f.core.decideApproval(id, { decision: 'approved' });
    expect(approval.decision).toBe('approved');
    expect(h.decide).toHaveBeenCalledWith(id, 'approved');
    expect(h.send).toHaveBeenCalledTimes(1);
    h.emit(activity('idle'));
    await f.drain();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1]).toEqual(['Also check the schema', 'queue']);
    h.emit(activity('idle'));
    await f.drain();
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(h.send.mock.calls[2]?.[0]).toContain('Repair ci_failed');
  });
  test('restores dedupe and attempt counts on restart', async () => {
    const f = await openWorker();
    await fail(f, 'head-1');
    await fail(f, 'head-2');
    await fail(f, 'head-3');
    await f.core.shutdown();
    // A detached/recoverable session would remain live; append a known idle observation.
    const last = f.store.events.at(-1)!;
    await f.store.append([
      {
        v: 1,
        ts: timestamp,
        projectId: f.p.id,
        sessionId: f.s.id,
        type: 'activity.changed',
        payload: { activity: 'idle' },
        causedBy: last.seq,
      },
    ]);
    const core = createHelixCore(f.deps);
    await core.start();
    const pr = f.state(f.p.id).sessions[f.s.id]!.pr!;
    f.scm.emit(f.p.id, pr.number, {
      type: 'pr.updated',
      payload: { pr: { ...pr, headSha: 'head-4' } },
    });
    f.scm.emit(f.p.id, pr.number, {
      type: 'ci.updated',
      payload: { prNumber: pr.number, checks: red },
    });
    await core.health();
    await core.health();
    expect(f.store.events.filter((e) => e.type === 'feedback.routed')).toHaveLength(3);
    expect(f.state(f.p.id).sessions[f.s.id]!.activity).toBe('waiting_input');
  });
  test('identical PR numbers in different repositories do not share dedupe state', async () => {
    const f = await openWorker();
    await fail(f, 'head-1');
    const p2 = await f.core.addProject({ repoPath: path.resolve('other-repo') });
    f.scm.nextNumber = 1;
    const s2 = await f.core.createSession(p2.id, request, 'worker');
    f.harness.handles.get(s2.id)!.emit(activity('idle'));
    await f.drain();
    f.scm.emit(p2.id, f.pr.number, {
      type: 'ci.updated',
      payload: { prNumber: f.pr.number, checks: red },
    });
    await f.drain();
    expect(f.store.events.filter((e) => e.type === 'feedback.routed')).toHaveLength(2);
  });
});

describe('lifecycle, diffs and transport', () => {
  test('emits changed diff statistics once per turn, skips unchanged summaries', async () => {
    const f = fixture();
    const p = await f.add();
    const s = await f.core.createSession(p.id, request, 'worker');
    const h = f.harness.handles.get(s.id)!;
    h.emit(activity('idle'));
    await f.drain();
    h.emit(activity('idle'));
    await f.drain();
    await f.core.sendMessage(s.id, { text: 'Second turn', mode: 'queue' });
    h.emit(activity('active'));
    h.emit(activity('idle'));
    await f.drain();
    expect(f.git.markTurn).toHaveBeenCalledTimes(2);
    expect(f.store.events.filter((e) => e.type === 'worktree.diff_updated')).toHaveLength(1);
    f.git.diffResult.files[0]!.insertions = 10;
    await f.core.sendMessage(s.id, { text: 'Third turn', mode: 'queue' });
    h.emit(activity('active'));
    h.emit(activity('idle'));
    await f.drain();
    expect(f.store.events.filter((e) => e.type === 'worktree.diff_updated')).toHaveLength(2);
    await f.core.diff(s.id, 'last_turn');
    expect(f.git.diff).toHaveBeenLastCalledWith(s.worktreePath, 'last_turn');
  });
  test.each([true, false])(
    'archive preserves dirty=%s worktrees and stops the worker',
    async (dirty) => {
      const f = fixture();
      const p = await f.add();
      const s = await f.core.createSession(p.id, request, 'worker');
      f.git.dirty = dirty;
      const archived = await f.core.archiveSession(s.id);
      expect(archived.archivedAt).toBe(timestamp);
      expect(f.harness.handles.get(s.id)!.stop).toHaveBeenCalledTimes(1);
      expect(f.git.remove).toHaveBeenCalledTimes(dirty ? 0 : 1);
      if (dirty) {
        const note = f.store.events.at(-1);
        if (note?.type !== 'explain.note') throw new Error('Expected cleanup explanation');
        expect(note.payload.text).toContain('Dirty worktree retained');
      } else expect(f.git.remove).toHaveBeenCalledWith(s.worktreePath, { force: false });
    },
  );
  test('retains a worktree that becomes dirty between status and remove', async () => {
    const f = fixture();
    const p = await f.add();
    const s = await f.core.createSession(p.id, request, 'worker');
    f.git.remove.mockRejectedValueOnce(new HelixError('DIRTY_WORKTREE', 'raced'));
    await f.core.archiveSession(s.id);
    const note = f.store.events.at(-1);
    if (note?.type !== 'explain.note') throw new Error('Expected cleanup explanation');
    expect(note.payload.text).toContain('became dirty');
  });
  test('terminal activity follows process lifecycle; output text never implies idle or approvals', async () => {
    const f = fixture();
    const p = await f.add();
    const s = await f.core.createSession(p.id, { ...request, interface: 'terminal' }, 'terminal');
    expect(f.harness.start).not.toHaveBeenCalled();
    expect(f.terminals.spawn).toHaveBeenCalledWith(s.id, {
      command: process.execPath,
      args: [],
      cwd: s.worktreePath,
    });
    f.terminals.output.get(s.id)!({ t: 'out', data: 'idle\nApproval required\n' });
    await f.drain();
    expect(f.state(p.id).sessions[s.id]!.activity).toBe('active');
    await expect(f.core.sendMessage(s.id, { text: 'hello', mode: 'queue' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    f.terminals.exit(s.id, 7);
    await f.drain();
    expect(f.store.events.at(-1)).toMatchObject({ type: 'session.exited', payload: { code: 7 } });
  });
  test('merge is gated by facts and uses the latest observed head', async () => {
    const f = await openWorker();
    await expect(f.core.merge(f.s.id)).rejects.toMatchObject({ code: 'MERGE_BLOCKED' });
    f.scm.emit(f.p.id, f.pr.number, {
      type: 'pr.updated',
      payload: { pr: { ...f.pr, headSha: 'new-head' } },
    });
    await ready(f);
    await f.core.merge(f.s.id);
    expect(f.scm.merge).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: 'new-head' }),
    );
    expect(f.scm.unsubscribe).toHaveBeenCalledTimes(1);
  });
  test('no GitHub or no commits means no automatic PR', async () => {
    const f = fixture();
    f.git.remote = undefined;
    const p = await f.add();
    const s = await f.core.createSession(p.id, request, 'worker');
    f.git.ahead = 1;
    f.harness.handles.get(s.id)!.emit(activity('idle'));
    await f.drain();
    expect(f.scm.openPr).not.toHaveBeenCalled();
  });
  test('events, health, harness discovery, explain and recordings obey contracts', async () => {
    const f = fixture();
    const p = await f.add();
    const s = await f.core.createSession(p.id, request, 'worker');
    expect(f.core.events).toBe(f.store);
    expect(f.core.terminals).toBe(f.terminals);
    expect(await f.core.health()).toEqual({ status: 'ok', version: '0.0.0' });
    expect(await f.core.harnesses()).toEqual([{ agent: 'codex', installed: true, signedIn: true }]);
    expect(await f.core.listProjects()).toEqual([p]);
    const note = await f.core.explain({
      sessionId: s.id,
      text: 'Use a small interface',
      causedBy: f.store.events[1]!.seq,
    });
    expect(note.type).toBe('explain.note');
    expect(await f.core.projectEvents(p.id, 1, 2)).toMatchObject({
      lastSeq: 3,
      events: [f.store.events[1], f.store.events[2]],
    });
    expect(await f.core.projectEvents(p.id, 999, 1)).toEqual({ events: [], lastSeq: 999 });
    const exported = await f.core.exportRecording(p.id);
    await f.core.importRecording(exported);
    expect(f.store.importRecording).toHaveBeenCalledWith(exported);
    await expect(f.core.projectEvents(p.id, -1, 100)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(f.core.diff(sessionIdSchema.parse('missing'), 'pr')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      f.core.projectEvents(projectIdSchema.parse('missing'), 0, 1),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('plan integrity and restart', () => {
  test.each([
    [nodes[0]!, { ...nodes[1]!, id: nodes[0]!.id }],
    [{ ...nodes[0]!, dependsOn: [planNodeIdSchema.parse('missing')] }],
    [
      { ...nodes[0]!, dependsOn: [nodes[1]!.id] },
      { ...nodes[1]!, dependsOn: [nodes[0]!.id] },
    ],
  ])(
    'rejects duplicate, missing or cyclic dependencies without side effects (%#)',
    async (...badNodes) => {
      const f = fixture();
      const p = await f.add();
      const o = await f.core.createSession(
        p.id,
        { ...request, planWithOrchestrator: true },
        'planner',
      );
      const count = f.store.events.length;
      await expect(
        f.core.submitPlan({
          projectId: p.id,
          orchestratorSessionId: o.id,
          goal: 'Invalid plan',
          nodes: badNodes,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(f.store.events).toHaveLength(count);
    },
  );
  test('waits for every dependency and never starts a node twice', async () => {
    const f = fixture();
    const p = await f.add();
    const o = await f.core.createSession(
      p.id,
      { ...request, planWithOrchestrator: true },
      'planner',
    );
    const plan = await f.core.submitPlan({
      projectId: p.id,
      orchestratorSessionId: o.id,
      goal: 'Join two branches',
      nodes: [nodes[0]!, nodes[1]!, { ...nodes[2]!, dependsOn: [nodes[0]!.id, nodes[1]!.id] }],
    });
    f.git.ahead = 1;
    for (const n of plan.nodes.slice(0, 2))
      f.harness.handles.get(n.sessionId!)!.emit(activity('idle'));
    await f.drain();
    const merge = async (id: SessionId) => {
      const pr = f.state(p.id).sessions[id]!.pr!;
      f.scm.emit(p.id, pr.number, {
        type: 'pr.merged',
        payload: { prNumber: pr.number, mergeSha: 'merge-sha' },
      });
      await f.drain();
    };
    await merge(plan.nodes[0]!.sessionId!);
    expect(f.harness.start).toHaveBeenCalledTimes(3);
    await merge(plan.nodes[1]!.sessionId!);
    expect(f.harness.start).toHaveBeenCalledTimes(4);
    await f.core.start();
    await f.core.start();
    expect(f.harness.start).toHaveBeenCalledTimes(4);
  });
  test('resume failure emits unknown, keeps open PR watch, and never claims death', async () => {
    const f = await openWorker();
    const failHarness = new FakeHarness();
    failHarness.failStart = true;
    const restarted = createHelixCore({ ...f.deps, harnesses: { codex: failHarness } });
    await restarted.start();
    expect(failHarness.start).toHaveBeenCalledWith(
      expect.objectContaining({ resumeToken: `resume-${f.s.id}` }),
    );
    expect(f.store.events.at(-1)).toMatchObject({
      type: 'activity.changed',
      payload: { activity: 'unknown' },
    });
    expect(types(f.store.events)).not.toContain('session.exited');
    expect(f.scm.watch).toHaveBeenCalledTimes(2);
  });
  test('shutdown stops ordinary agents, detaches terminals, unsubscribes pollers, and leaves explicitly reattachable agents', async () => {
    const f = await openWorker();
    const h = f.harness.handles.get(f.s.id)!;
    await f.core.shutdown();
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(f.scm.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.store.close).not.toHaveBeenCalled();
    const g = fixture({ canReattach: () => true });
    const p = await g.add();
    const s = await g.core.createSession(p.id, request, 'worker');
    const terminal = await g.core.createSession(
      p.id,
      { ...request, interface: 'terminal' },
      'terminal',
    );
    await g.core.shutdown();
    expect(g.harness.handles.get(s.id)!.stop).not.toHaveBeenCalled();
    expect(g.terminals.detach).toHaveBeenCalled();
    expect(g.terminals.kill).toHaveBeenCalledWith(terminal.id);
  });
  test('stopped and archived sessions are not restarted', async () => {
    const f = fixture();
    const p = await f.add();
    const s = await f.core.createSession(p.id, request, 'worker');
    await f.core.archiveSession(s.id);
    const harness = new FakeHarness();
    const core = createHelixCore({ ...f.deps, harnesses: { codex: harness } });
    await core.start();
    expect(harness.start).not.toHaveBeenCalled();
  });
});
