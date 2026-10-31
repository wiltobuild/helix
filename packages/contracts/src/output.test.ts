import { expect, test } from 'vitest';
import { eventSchemas, fixtures, projectBuilds, projectUpTo, outputLeaseSchema } from './index.js';

test('Output replay preserves evidence and rejects revision rollback or changed commit binding', () => {
  const events = fixtures.passwordResetRun;
  const state = projectUpTo(events, events.at(-1)!.seq);
  const worker = Object.values(state.sessions).find(
    (s) => s.session.role === 'worker' && s.worktree,
  )!;
  const build = projectBuilds(state).find((b) => b.sessionIds.includes(worker.session.id))!;
  const output = {
    workerSessionId: worker.session.id,
    buildSessionId: build.rootSessionId,
    revision: 1,
    branch: worker.worktree!.branch,
    headSha: 'a'.repeat(40),
    briefHash: 'b'.repeat(64),
    designHash: 'c'.repeat(64),
    status: 'starting' as const,
    message: 'Preparing',
    feedback: [],
  };
  const first = eventSchemas['output.updated'].parse({
    v: 1,
    ts: events.at(-1)!.ts,
    seq: state.lastSeq + 1,
    projectId: state.project.id,
    sessionId: worker.session.id,
    type: 'output.updated',
    payload: { output },
  });
  expect(projectUpTo([...events, first], first.seq).sessions[worker.session.id]!.output).toEqual(
    output,
  );
  for (const change of [
    { headSha: 'd'.repeat(40) },
    { revision: 3 },
    { buildSessionId: worker.session.id },
  ]) {
    const next = eventSchemas['output.updated'].parse({
      ...first,
      seq: first.seq + 1,
      payload: { output: { ...output, ...change } },
    });
    expect(() => projectUpTo([...events, first, next], next.seq, { strict: true })).toThrow();
  }
  const live = eventSchemas['output.updated'].parse({
    ...first,
    seq: first.seq + 1,
    payload: { output: { ...output, status: 'running', artifactHash: 'd'.repeat(64) } },
  });
  expect(
    projectUpTo([...events, first, live], live.seq).sessions[worker.session.id]!.output,
  ).toEqual(live.payload.output);
});

test('live lease never accepts arbitrary remote/internal destinations or credentials', () => {
  const base = { revision: 1, artifactHash: 'a'.repeat(64), stale: false, pendingChanges: false };
  for (const url of [
    'https://example.com/',
    'http://localhost:4322/',
    'http://127.0.0.1:4322/api/',
    'file:///C:/Users/Wil/',
    'http://user:pass@127.0.0.1:1234/' + 'a'.repeat(48) + '/',
  ])
    expect(outputLeaseSchema.safeParse({ ...base, url }).success).toBe(false);
});
