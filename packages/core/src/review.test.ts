import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  crossReviewerFor,
  deriveStatus,
  type AgentReview,
  type HelixEvent,
  type SessionId,
} from '@helix/contracts';
import { createHelixCore, type CoreDeps } from './index.js';
import { FakeHarness, fixture, green, pending } from './test-support.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const approve: AgentReview = { verdict: 'approve', summary: 'Meets the task.', findings: [] };
const changes: AgentReview = {
  verdict: 'request_changes',
  summary: 'Fix the missing case.',
  findings: [
    {
      severity: 'major',
      title: 'Missing case',
      file: 'src/api.ts',
      line: 12,
      detail: '  Invalid inputs are accepted.  ',
    },
  ],
};
async function setup(agent = 'codex', overrides: Partial<CoreDeps> = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'helix-review-core-'));
  roots.push(dataDir);
  const codex = new FakeHarness();
  const claude = new FakeHarness();
  claude.detect.mockResolvedValue({ agent: 'claude-code', installed: true, signedIn: true });
  const f = fixture({
    crossReview: true,
    dataDir,
    harnesses: { codex, 'claude-code': claude },
    ...overrides,
  });
  const p = await f.add();
  const s = await f.core.createSession(
    p.id,
    { agent, title: 'Worker', prompt: 'Reject invalid input', interface: 'chat' },
    'worker',
  );
  const harness = f.deps.harnesses[agent] as FakeHarness;
  f.git.ahead = 1;
  harness.handles.get(s.id)!.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await f.drain();
  const pr = f.state(p.id).sessions[s.id]!.pr!;
  f.scm.emit(p.id, pr.number, {
    type: 'review.updated',
    payload: { prNumber: pr.number, review: { decision: 'none', unresolvedThreads: 0 } },
  });
  await f.drain();
  const reviewerHarness = agent === 'claude-code' ? codex : claude;
  const requests = () =>
    f.store.events.filter(
      (e): e is HelixEvent<'agent_review.requested'> => e.type === 'agent_review.requested',
    );
  const reviewer = () => f.state(p.id).sessions[requests().at(-1)!.sessionId!]!.session;
  const pass = async () => {
    f.scm.emit(p.id, pr.number, {
      type: 'ci.updated',
      payload: { prNumber: pr.number, checks: green },
    });
    await f.drain();
  };
  const idle = async (id: SessionId = reviewer().id) => {
    (id === s.id ? harness : reviewerHarness).handles
      .get(id)!
      .emit({ type: 'activity.changed', payload: { activity: 'idle' } });
    await f.drain();
  };
  const head = async (sha: string) => {
    f.scm.emit(p.id, pr.number, {
      type: 'pr.updated',
      payload: { pr: { ...f.state(p.id).sessions[s.id]!.pr!, headSha: sha, checks: pending } },
    });
    await f.drain();
  };
  const submit = (review = approve, headSha = f.state(p.id).sessions[s.id]!.pr!.headSha) =>
    f.core.submitReview({ reviewerSessionId: reviewer().id, headSha, review });
  return {
    ...f,
    p,
    s,
    pr,
    dataDir,
    harness,
    reviewerHarness,
    requests,
    reviewer,
    pass,
    idle,
    head,
    submit,
  };
}

test.each(['codex', 'claude-code'])(
  'green %s work starts the other agent in scratch, approves and projects strictly',
  async (agent) => {
    const prompt = vi.fn(() => 'Review instructions');
    const f = await setup(agent, { reviewerPrompt: prompt, limits: { maxParallelWorkers: 1 } });
    await f.pass();
    const reviewer = f.reviewer();
    expect(reviewer).toMatchObject({
      role: 'reviewer',
      agent: crossReviewerFor(agent),
      parentSessionId: f.s.id,
      title: 'Review: Worker',
      interface: 'chat',
    });
    expect(reviewer.planNodeId).toBeUndefined();
    expect(f.git.create).toHaveBeenCalledTimes(1);
    expect(f.reviewerHarness.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cwd: path.join(f.dataDir, 'reviews', reviewer.id),
        review: { worktreePath: f.s.worktreePath },
      }),
    );
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ worker: f.s, reviewer }));
    expect(f.requests()[0]!.causedBy).toBe(
      f.store.events.findLast((e) => e.type === 'ci.updated')!.seq,
    );
    await f.pass();
    expect(f.requests()).toHaveLength(1);
    expect(deriveStatus(f.state(f.p.id).sessions[f.s.id]!)).toBe('in_review');
    await expect(f.core.merge(f.s.id)).rejects.toMatchObject({ code: 'MERGE_BLOCKED' });
    const verdict = await f.submit();
    expect(verdict.causedBy).toBe(f.requests()[0]!.seq);
    await f.idle();
    expect(deriveStatus(f.state(f.p.id).sessions[f.s.id]!)).toBe('ready_to_merge');
    expect(f.store.events.filter((e) => e.type === 'feedback.routed')).toHaveLength(0);
    expect(f.state(f.p.id).anomalies).toEqual([]);
    await f.core.shutdown();
  },
);

test.each(['missing', 'uninstalled', 'unsigned', 'unknown'])(
  'unavailable cross reviewer (%s) emits one note and never self-reviews',
  async (why) => {
    const f = await setup(
      why === 'unknown' ? 'future-agent' : 'codex',
      why === 'unknown'
        ? { harnesses: { 'future-agent': new FakeHarness(), codex: new FakeHarness() } }
        : {},
    );
    if (why === 'missing') delete f.deps.harnesses['claude-code'];
    if (why === 'uninstalled')
      f.reviewerHarness.detect.mockResolvedValue({
        agent: 'claude-code',
        installed: false,
        signedIn: true,
      });
    if (why === 'unsigned')
      f.reviewerHarness.detect.mockResolvedValue({
        agent: 'claude-code',
        installed: true,
        signedIn: false,
      });
    await f.pass();
    await f.pass();
    expect(f.requests()).toHaveLength(0);
    expect(
      f.store.events.filter(
        (e) =>
          e.type === 'explain.note' &&
          e.payload.text.includes('never lets an agent review its own work'),
      ),
    ).toHaveLength(1);
    await f.core.shutdown();
  },
);

test('change requests route bounded core-formatted feedback and the same reviewer approves the new head', async () => {
  const f = await setup();
  await f.pass();
  const id = f.reviewer().id;
  await f.submit(changes);
  const feedback = f.store.events.find((e) => e.type === 'feedback.routed')!;
  expect(feedback.payload).toMatchObject({
    reason: 'review_findings',
    summary:
      'Claude Code reviewed PR #1 and requested changes:\n[major] Missing case (src/api.ts:12): Invalid inputs are accepted.',
  });
  expect(f.deps.buildFeedbackMessage).not.toHaveBeenCalled();
  expect(f.harness.handles.get(f.s.id)!.send).toHaveBeenLastCalledWith(
    expect.stringContaining('[major]'),
    'queue',
  );
  await expect(f.submit(changes)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await f.idle();
  await f.idle(f.s.id);
  await f.head('fix-head');
  await f.pass();
  expect(f.reviewer().id).toBe(id);
  expect(f.reviewerHarness.start).toHaveBeenCalledTimes(1);
  expect(f.reviewerHarness.handles.get(id)!.send).toHaveBeenLastCalledWith(
    expect.stringContaining('head-1...fix-head'),
    'queue',
  );
  await f.submit();
  await f.idle();
  expect(deriveStatus(f.state(f.p.id).sessions[f.s.id]!)).toBe('ready_to_merge');
  expect(f.state(f.p.id).anomalies).toEqual([]);
  await f.core.shutdown();
});

test('rejects stale heads, non-reviewers and malformed verdicts', async () => {
  const f = await setup();
  await f.pass();
  await f.head('new-head');
  await expect(f.submit(approve, 'head-1')).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
    message: 'The PR moved on; review the new head',
  });
  await expect(f.submit(approve, 'new-head')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(
    f.core.submitReview({ reviewerSessionId: f.s.id, headSha: 'new-head', review: approve }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(f.submit({ ...approve, summary: ' ' })).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  });
  await f.core.shutdown();
});

test('review findings retain the three-attempt cap and 2500-character bound', async () => {
  const f = await setup();
  for (let i = 0; i < 4; i++) {
    if (i) await f.head(`fix-${i}`);
    await f.pass();
    await f.submit({
      ...changes,
      findings: [{ ...changes.findings[0]!, detail: 'x'.repeat(4000) }],
    });
    await f.idle();
    if (i < 3) await f.idle(f.s.id);
  }
  const routed = f.store.events.filter((e) => e.type === 'feedback.routed');
  expect(routed).toHaveLength(3);
  for (const e of routed) expect(e.payload.summary.length).toBeLessThanOrEqual(2500);
  expect(f.state(f.p.id).sessions[f.s.id]!.activity).toBe('waiting_input');
  expect(
    f.store.events.filter(
      (e) => e.type === 'explain.note' && e.payload.text.includes('after 3 attempts'),
    ),
  ).toHaveLength(1);
  await f.core.shutdown();
});

test('one reminder then abandonment falls back to CI and never re-requests that head', async () => {
  const f = await setup();
  await f.pass();
  await f.idle();
  expect(f.reviewerHarness.handles.get(f.reviewer().id)!.send).toHaveBeenLastCalledWith(
    expect.stringContaining('Submit your verdict'),
    'queue',
  );
  await f.idle();
  await f.pass();
  expect(f.store.events.filter((e) => e.type === 'agent_review.abandoned')).toHaveLength(1);
  expect(f.requests()).toHaveLength(1);
  expect(deriveStatus(f.state(f.p.id).sessions[f.s.id]!)).toBe('ready_to_merge');
  await f.core.shutdown();
});

test.each(['exited', 'unknown'] as const)(
  'reviewer %s abandons with a worker note',
  async (activity) => {
    const f = await setup();
    await f.pass();
    f.reviewerHarness.handles
      .get(f.reviewer().id)!
      .emit({ type: 'activity.changed', payload: { activity } });
    await f.drain();
    expect(f.state(f.p.id).sessions[f.s.id]!.agentReview).toBeUndefined();
    expect(
      f.store.events.some(
        (e) =>
          e.type === 'explain.note' &&
          e.sessionId === f.s.id &&
          e.payload.text.includes('without a verdict'),
      ),
    ).toBe(true);
    if (activity === 'exited') {
      const previous = f.reviewer().id;
      await f.head('next');
      await f.pass();
      expect(f.reviewer().id).not.toBe(previous);
    }
    await f.core.shutdown();
  },
);

test.each(['stopAll', 'archive', 'closed', 'merged'] as const)(
  '%s stops reviewers and abandons pending review',
  async (action) => {
    const f = await setup();
    await f.pass();
    const id = f.reviewer().id;
    if (action === 'stopAll') expect((await f.core.stopAll(f.p.id)).stopped).toContain(id);
    else if (action === 'archive') await f.core.archiveSession(f.s.id);
    else {
      f.scm.emit(f.p.id, f.pr.number, {
        type: 'pr.updated',
        payload: { pr: { ...f.pr, state: action } },
      });
      await f.drain();
    }
    expect(f.reviewerHarness.handles.get(id)!.stop).toHaveBeenCalledOnce();
    expect(f.state(f.p.id).sessions[f.s.id]!.agentReview).toBeUndefined();
    expect(f.state(f.p.id).anomalies).toEqual([]);
    await f.pass();
    expect(f.requests()).toHaveLength(1);
    await f.core.shutdown();
  },
);

test.each([false, true])(
  'restart resumes pending review without double request (reminded=%s)',
  async (reminded) => {
    const f = await setup();
    await f.pass();
    if (reminded) await f.idle();
    const id = f.reviewer().id;
    const restarted = createHelixCore(f.deps);
    await restarted.start();
    await f.pass();
    await restarted.health();
    expect(f.requests()).toHaveLength(1);
    expect(f.reviewerHarness.start.mock.calls.at(-1)![0]).toMatchObject({
      resumeToken: `resume-${id}`,
      review: { worktreePath: f.s.worktreePath },
    });
    expect(f.reviewerHarness.handles.get(id)!.send).toHaveBeenCalledOnce();
    if (reminded) {
      f.reviewerHarness.handles
        .get(id)!
        .emit({ type: 'activity.changed', payload: { activity: 'idle' } });
      await restarted.health();
      expect(f.state(f.p.id).sessions[f.s.id]!.agentReview).toBeUndefined();
    } else
      await restarted.submitReview({
        reviewerSessionId: id,
        headSha: f.pr.headSha,
        review: approve,
      });
    expect(f.state(f.p.id).anomalies).toEqual([]);
    await restarted.shutdown();
    await f.core.shutdown();
  },
);

test('cross review off and non-green checks do not create reviewers', async () => {
  const f = await setup('codex', { crossReview: false });
  await f.pass();
  expect(f.requests()).toHaveLength(0);
  await f.core.shutdown();
  const g = await setup();
  for (const checks of [
    pending,
    { total: 0, passed: 0, pending: 0, failed: 0, failingNames: [] },
  ]) {
    g.scm.emit(g.p.id, g.pr.number, {
      type: 'ci.updated',
      payload: { prNumber: g.pr.number, checks },
    });
    await g.drain();
  }
  expect(g.requests()).toHaveLength(0);
  await g.core.shutdown();
});
