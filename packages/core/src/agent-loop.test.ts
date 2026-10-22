import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  planNodeIdSchema,
  projectUpTo,
  type KnownAgentKind,
  type ProjectId,
} from '@helix/contracts';
import { createHarness } from '@helix/harness';
import { openStore } from '@helix/storage';
import { createGitHubScm, buildFeedbackMessage } from '@helix/scm';
import { createFakeGitHub } from '@helix/testing';
import { fixture } from './test-support.js';
import { createHelixCore } from './index.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

type Wire = {
  id?: number;
  method?: string;
  type?: string;
  request_id?: string;
  request?: { subtype: string };
  params?: { input?: { text: string }[] };
  message?: { content: string };
};

/** Only the byte transport is replaced; real adapter handshakes/turn logic run unchanged. */
class MemoryCli extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode = null;
  turns: string[] = [];
  stdin = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      this.receive(JSON.parse(chunk.toString()) as Wire);
      done();
    },
  });
  constructor(readonly kind: KnownAgentKind) {
    super();
    queueMicrotask(() => this.emit('spawn'));
  }
  output(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\r\n`);
  }
  receive(wire: Wire) {
    if (wire.type === 'control_request') {
      if (wire.request?.subtype === 'interrupt') this.finish(`cancelled ${this.turns.at(-1)}`);
      this.output({
        type: 'control_response',
        response: { request_id: wire.request_id, response: {} },
      });
    } else if (wire.type === 'user') {
      this.turns.push(wire.message!.content);
    } else if (wire.method === 'initialize') {
      this.output({ id: wire.id, result: {} });
    } else if (wire.method === 'thread/start' || wire.method === 'thread/resume') {
      this.output({ id: wire.id, result: { thread: { id: 'memory-thread' } } });
    } else if (wire.method === 'turn/start') {
      this.turns.push(wire.params!.input![0]!.text);
      const turn = { id: `turn-${this.turns.length}` };
      this.output({ id: wire.id, result: { turn } });
      this.output({ method: 'turn/started', params: { turn } });
    } else if (wire.method === 'turn/interrupt') {
      this.finish(`cancelled ${this.turns.at(-1)}`);
      this.output({ id: wire.id, result: {} });
    }
  }
  finish(text = `finished ${this.turns.at(-1)}`) {
    if (this.kind === 'claude-code') {
      this.output({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
      this.output({ type: 'result', subtype: 'success' });
    } else {
      this.output({ method: 'item/completed', params: { item: { type: 'agentMessage', text } } });
      this.output({
        method: 'turn/completed',
        params: { turn: { id: `turn-${this.turns.length}`, status: 'completed' } },
      });
    }
  }
  close() {
    this.exitCode = 0;
    this.emit('exit', 0);
    this.stdout.end();
    this.emit('close', 0);
  }
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.useRealTimers();
});

function setup(kind: KnownAgentKind = 'codex', github = false) {
  const transports: MemoryCli[] = [];
  vi.mocked(spawn).mockImplementation(() => {
    const transport = new MemoryCli(kind);
    transports.push(transport);
    return transport as unknown as ChildProcessWithoutNullStreams;
  });
  const store = openStore({ memory: true });
  const remote = createFakeGitHub({ repo: 'helix' });
  const harness = createHarness(kind, { bin: process.execPath });
  vi.spyOn(harness, 'detect').mockResolvedValue({ agent: kind, installed: true, signedIn: true });
  const f = fixture({
    store,
    harnesses: { [kind]: harness },
    ...(github
      ? {
          scm: createGitHubScm({ token: 'test', fetch: remote.fetch, pollMs: 100 }),
          buildFeedbackMessage,
        }
      : {}),
  });
  cleanup.push(async () => {
    for (const transport of transports) transport.close();
    await f.core.shutdown();
    await store.close();
  });
  const events = (id: ProjectId) => store.read(id, 0, 1000);
  const state = async (id: ProjectId) =>
    projectUpTo(await events(id), Number.MAX_SAFE_INTEGER, { strict: true });
  return { ...f, store, transports, remote, events, state, kind };
}

const request = { title: 'Worker', prompt: 'A', agent: 'codex', interface: 'chat' } as const;

test('real Codex adapter answers a question through core.sendMessage during an open turn', async () => {
  const f = setup('codex');
  const p = await f.add();
  const s = await f.core.createSession(p.id, request, 'question');
  await f.drain();
  const cli = f.transports[0]!;
  const received = vi.spyOn(cli, 'receive');
  cli.output({
    id: 'question',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'memory-thread',
      turnId: 'turn-1',
      itemId: 'question-item',
      isBlocking: true,
      questions: [
        {
          id: 'choice',
          header: 'Choice',
          question: 'Which option?',
          options: [{ label: 'A', description: 'First option' }],
        },
      ],
    },
  });
  await f.drain();
  expect((await f.state(p.id)).sessions[s.id]!.activity).toBe('waiting_input');
  await f.core.sendMessage(s.id, { text: 'A', mode: 'queue' });
  await f.drain();
  expect(received).toHaveBeenCalledWith({
    id: 'question',
    result: { answers: { choice: { answers: ['A'] } } },
  });
  expect(cli.turns).toEqual(['A']);
  expect((await f.state(p.id)).sessions[s.id]!.activity).toBe('active');
});

describe.each(['claude-code', 'codex'] as const)('%s composed agent loop', (kind) => {
  test('core + real adapter + SQLite deliver the initial prompt exactly once', async () => {
    const f = setup(kind);
    const p = await f.add();
    const s = await f.core.createSession(p.id, { ...request, agent: kind }, 'one');
    await f.drain();
    expect(f.transports[0]!.turns).toEqual(['A']);
    expect(f.git.markTurn).not.toHaveBeenCalled(); // Handshake is not a completed turn.
    expect(
      (await f.events(p.id)).some(
        (e) => e.type === 'activity.changed' && e.payload.activity === 'idle',
      ),
    ).toBe(false);
    f.transports[0]!.finish();
    await f.drain();
    expect(f.transports[0]!.turns).toEqual(['A']);
    const events = await f.events(p.id);
    const started = events.find((e) => e.type === 'session.started' && e.sessionId === s.id)!;
    const response = events.find((e) => e.type === 'chat.item')!;
    expect(response.causedBy).toBe(started.seq);
    expect(f.git.markTurn).toHaveBeenCalledOnce();
  });

  test('A running, B queued, C interrupts: terminal A keeps A cause; C then B', async () => {
    const f = setup(kind);
    const p = await f.add();
    const s = await f.core.createSession(p.id, { ...request, agent: kind }, 'interrupt');
    await f.core.sendMessage(s.id, { text: 'B', mode: 'queue' });
    expect(f.transports[0]!.turns).toEqual(['A']);
    await f.core.sendMessage(s.id, { text: 'C', mode: 'interrupt' });
    await f.drain();
    expect(f.transports[0]!.turns).toEqual(['A', 'C']);
    f.transports[0]!.finish();
    await f.drain();
    expect(f.transports[0]!.turns).toEqual(['A', 'C', 'B']);
    f.transports[0]!.finish();
    await f.drain();
    const events = await f.events(p.id);
    const initial = events.find((e) => e.type === 'session.started')!;
    const user = events.filter(
      (e) =>
        e.type === 'chat.item' &&
        e.payload.item.kind === 'message' &&
        e.payload.item.role === 'user',
    );
    const replies = events.filter(
      (e) =>
        e.type === 'chat.item' &&
        e.payload.item.kind === 'message' &&
        e.payload.item.role === 'assistant',
    );
    const causes = [initial.seq, user[1]!.seq, user[0]!.seq];
    expect(replies.map((e) => e.causedBy)).toEqual(causes);
    expect(
      events
        .filter((e) => e.type === 'activity.changed' && e.payload.activity === 'idle')
        .map((e) => e.causedBy),
    ).toEqual(causes);
    expect(
      events
        .filter((e) => e.type === 'activity.changed' && e.payload.activity === 'active')
        .map((e) => e.causedBy),
    ).toEqual(causes);
  });

  test('resume with a delivered initial prompt stays idle without executing it again', async () => {
    const f = setup(kind);
    const p = await f.add();
    const s = await f.core.createSession(p.id, { ...request, agent: kind }, 'resume');
    f.transports[0]!.finish();
    await f.drain();
    const restarted = createHelixCore(f.deps);
    cleanup.push(async () => {
      for (const transport of f.transports) transport.close();
      await restarted.shutdown();
    });
    await restarted.start();
    await restarted.health();
    expect(f.transports[1]!.turns).toEqual([]);
    expect((await f.state(p.id)).sessions[s.id]!.activity).toBe('idle');
    expect(f.git.markTurn).toHaveBeenCalledOnce();
    f.git.dirty = true;
    await restarted.sendMessage(s.id, { text: 'Second turn', mode: 'queue' });
    f.transports[1]!.finish('Resumed edit');
    for (let i = 0; i < 3; i++) await restarted.health();
    expect(f.git.commitAll).toHaveBeenLastCalledWith(
      s.worktreePath,
      `Worker\n\nTurn 2 by ${kind} via Helix\n\nResumed edit`,
    );
  });

  test('next turn waits for commit, markTurn, diff, push and PR creation', async () => {
    const f = setup(kind);
    const p = await f.add();
    const s = await f.core.createSession(p.id, { ...request, agent: kind }, 'boundary');
    const mark = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<string>();
    const diff = Promise.withResolvers<typeof f.git.diffResult>();
    const push = Promise.withResolvers<void>();
    const open = Promise.withResolvers<Awaited<ReturnType<typeof f.scm.openPr>>>();
    const pr = await f.scm.openPr({
      project: p,
      sessionId: s.id,
      head: 'head',
      base: 'main',
      title: 'Worker',
      body: '',
      draft: false,
    });
    f.scm.openPr.mockClear();
    f.git.dirty = true;
    f.git.commitAll.mockImplementationOnce(async () => {
      const sha = await commit.promise;
      f.git.dirty = false;
      f.git.ahead = 1;
      return sha;
    });
    f.git.markTurn.mockReturnValueOnce(mark.promise);
    f.git.diff.mockReturnValueOnce(diff.promise);
    f.git.push.mockReturnValueOnce(push.promise);
    f.scm.openPr.mockReturnValueOnce(open.promise);
    await f.core.sendMessage(s.id, { text: 'B', mode: 'queue' });
    f.transports[0]!.finish();
    await vi.waitFor(() => expect(f.git.commitAll).toHaveBeenCalledOnce());
    expect(f.git.markTurn).not.toHaveBeenCalled();
    expect(f.transports[0]!.turns).toEqual(['A']);
    commit.resolve('abcdef1234567890');
    await vi.waitFor(() => expect(f.git.markTurn).toHaveBeenCalledOnce());
    expect(f.transports[0]!.turns).toEqual(['A']);
    mark.resolve();
    await vi.waitFor(() => expect(f.git.diff).toHaveBeenCalledOnce());
    expect(f.transports[0]!.turns).toEqual(['A']);
    diff.resolve(f.git.diffResult);
    await vi.waitFor(() => expect(f.git.push).toHaveBeenCalledOnce());
    expect(f.transports[0]!.turns).toEqual(['A']);
    push.resolve();
    await vi.waitFor(() => expect(f.scm.openPr).toHaveBeenCalledOnce());
    expect(f.transports[0]!.turns).toEqual(['A']);
    open.resolve(pr);
    await f.drain();
    expect(f.transports[0]!.turns).toEqual(['A', 'B']);
    expect((await f.events(p.id)).some((e) => e.type === 'pr.opened')).toBe(true);
  });
});

test.each([false, true])(
  'external merge persists once and fetches dependent base (fetch fails=%s)',
  async (fetchFails) => {
    vi.useFakeTimers();
    const f = setup('codex', true);
    const p = await f.add();
    const planner = await f.core.createSession(
      p.id,
      { ...request, planWithOrchestrator: true },
      'planner',
    );
    const node = (id: string, dependsOn: string[]) => ({
      id: planNodeIdSchema.parse(id),
      title: id,
      description: id,
      acceptance: ['Tests pass'],
      dependsOn: dependsOn.map((value) => planNodeIdSchema.parse(value)),
      agent: 'codex',
      rationale: id,
    });
    const plan = await f.core.submitPlan({
      projectId: p.id,
      orchestratorSessionId: planner.id,
      goal: 'Ship',
      nodes: [node('api', []), node('client', ['api'])],
    });
    const worker = plan.nodes[0]!.sessionId!;
    f.git.ahead = 1;
    f.transports[1]!.finish();
    await f.drain();
    await vi.advanceTimersByTimeAsync(0);
    const pr = (await f.state(p.id)).sessions[worker]!.pr!;
    if (fetchFails) f.git.fetchBase.mockRejectedValueOnce(new Error('remote unavailable'));
    else f.git.fetchBase.mockResolvedValue('fetched-merge-base');
    f.remote.setPr(pr.number, {
      state: 'closed',
      merged: true,
      merged_at: '2026-10-20T12:00:00Z',
      merge_commit_sha: 'merged-api-sha',
    });
    await vi.advanceTimersByTimeAsync(100);
    await f.drain();
    await vi.advanceTimersByTimeAsync(500);
    await f.drain();
    const events = await f.events(p.id);
    const merges = events.filter((e) => e.type === 'pr.merged');
    expect(merges).toHaveLength(1);
    expect(merges[0]!.payload.mergeSha).toBe('merged-api-sha');
    const dependent = Object.values((await f.state(p.id)).sessions).find(
      (s) => s.session.planNodeId === 'client',
    )!;
    expect(f.git.fetchBase).toHaveBeenCalledExactlyOnceWith(p.repoPath, p.defaultBranch);
    const note = events.find(
      (e) => e.type === 'explain.note' && e.sessionId === dependent.session.id,
    )!;
    if (note.type !== 'explain.note') throw new Error('Missing base explanation');
    expect(note.causedBy).toBe(merges[0]!.seq);
    if (fetchFails) {
      expect(note.payload.text).toContain('remote unavailable');
      expect(dependent.activity).toBe('waiting_input');
      expect(dependent.worktree).toBeUndefined();
      expect(f.transports).toHaveLength(2);
      expect(f.git.create).toHaveBeenCalledTimes(2);
    } else {
      expect(note.payload.text).toContain('fetched-merge-base');
      expect(note.payload.text).toContain('api (PR #');
      expect(f.git.create).toHaveBeenLastCalledWith(
        p.id,
        dependent.session.id,
        'fetched-merge-base',
        expect.any(Object),
      );
      expect(
        events.find((e) => e.type === 'session.started' && e.sessionId === dependent.session.id)
          ?.causedBy,
      ).toBe(merges[0]!.seq);
      expect(f.transports).toHaveLength(3);
    }
  },
);

test('unchanged requested changes on new heads route repairs, dedupe per head, and cap at three', async () => {
  vi.useFakeTimers();
  const f = setup('codex', true);
  const p = await f.add();
  const s = await f.core.createSession(p.id, request, 'review');
  f.git.ahead = 1;
  f.transports[0]!.finish();
  await f.drain();
  await vi.advanceTimersByTimeAsync(0);
  const pr = (await f.state(p.id)).sessions[s.id]!.pr!;
  f.remote.setReviews(
    pr.number,
    [{ id: 1, user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' }],
    'CHANGES_REQUESTED',
  );
  for (let head = 1; head <= 4; head++) {
    f.remote.setPr(pr.number, { head: { sha: `H${head}`, ref: 'worker' } });
    await vi.advanceTimersByTimeAsync(100);
    await f.drain();
    await vi.advanceTimersByTimeAsync(100);
    await f.drain();
    const routed = (await f.events(p.id)).filter((e) => e.type === 'feedback.routed');
    expect(routed).toHaveLength(Math.min(head, 3));
    if (head <= 3) {
      expect(f.transports[0]!.turns).toHaveLength(head + 1);
      expect(routed.at(-1)?.causedBy).toBe(
        (await f.events(p.id)).filter((e) => e.type === 'review.updated').at(-1)?.seq,
      );
      f.transports[0]!.finish();
      await f.drain();
    }
  }
  expect((await f.state(p.id)).sessions[s.id]!.activity).toBe('waiting_input');
});
