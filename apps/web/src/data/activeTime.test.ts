import { expect, test } from 'vitest';
import { fixtures, helixEventSchema, type HelixEvent } from '@helix/contracts';
import {
  accountTime,
  canonicalEvents,
  formatDuration,
  timeMapping,
  unionIntervals,
} from './activeTime';

const origin = Date.parse('2026-10-01T00:00:00Z');
const ts = (seconds: number) => new Date(origin + seconds * 1000).toISOString();
function event(
  seq: number,
  seconds: number,
  type: string,
  payload: unknown,
  sessionId?: string,
): HelixEvent {
  return helixEventSchema.parse({
    seq,
    ts: ts(seconds),
    type,
    payload,
    v: 1,
    projectId: fixtures.passwordResetProject.id,
    ...(sessionId ? { sessionId } : {}),
  });
}
const activity = (seq: number, seconds: number, id: string, value = 'active') =>
  event(seq, seconds, 'activity.changed', { activity: value }, id);
const request = (seq: number, seconds: number, id: string, approval = id) =>
  event(
    seq,
    seconds,
    'approval.requested',
    {
      approval: {
        id: approval,
        sessionId: id,
        kind: 'command',
        summary: 'Human decision',
        detail: '',
        scope: 'once',
        requestedAt: ts(seconds),
      },
    },
    id,
  );
const decide = (seq: number, seconds: number, id: string, approval = id) =>
  event(seq, seconds, 'approval.decided', { approvalId: approval, decision: 'approved' }, id);

test('concurrent work is not summed; one waiting worker does not stop the whole run', () => {
  const log = [
    activity(1, 0, 'a'),
    activity(2, 0, 'b'),
    request(3, 2, 'a'),
    decide(4, 8, 'a'),
    activity(5, 10, 'b'),
  ];
  const result = accountTime(log);
  expect(result.elapsed).toBe(10000);
  expect(result.active).toBe(10000);
  expect(result.human).toBe(0);
  expect(result.perAgent.find((a) => a.sessionId === 'a')).toMatchObject({ approvalWait: 6000 });
  expect(result.perAgent.find((a) => a.sessionId === 'b')).toMatchObject({ work: 10000 });
});

test('global wait is the intersection of all human-blocked workers, unioned across evidence', () => {
  const log = [
    activity(1, 0, 'a'),
    activity(2, 0, 'b'),
    request(3, 2, 'a'),
    request(4, 4, 'b'),
    request(5, 5, 'a', 'second'),
    decide(6, 6, 'a'),
    decide(7, 8, 'b'),
    decide(8, 9, 'a', 'second'),
    activity(9, 10, 'a'),
  ];
  const result = accountTime(log);
  expect(result.humanWait).toEqual([{ start: origin + 4000, end: origin + 8000 }]);
  expect(result.active).toBe(6000);
  expect(result.perAgent.find((a) => a.sessionId === 'a')?.approvalWait).toBe(7000);
  expect(result.perAgent.find((a) => a.sessionId === 'b')?.approvalWait).toBe(4000);
});

test('a plan needs quiescent orchestrator evidence; another worker or reviewer prevents compression', () => {
  const owner = fixtures.passwordResetPlan.orchestratorSessionId;
  const log = [
    activity(1, 0, owner),
    event(2, 1, 'plan.submitted', { plan: fixtures.passwordResetPlan }, owner),
    activity(3, 3, owner, 'idle'),
    event(
      4,
      8,
      'plan.approved',
      { planId: fixtures.passwordResetPlan.id, approvedBy: 'human' },
      owner,
    ),
  ];
  expect(accountTime(log).human).toBe(5000);
  expect(accountTime([...log, activity(5, 9, owner)]).human).toBe(5000);
  const concurrent = [
    activity(10, 0, 'reviewer'),
    ...log.map((e) => helixEventSchema.parse({ ...e, seq: e.seq + 10 })),
  ];
  expect(accountTime(concurrent).human).toBe(0);
});

test.each(['waiting_input', 'blocked', 'idle', 'unknown', 'starting'])(
  '%s alone is not human evidence',
  (value) => {
    expect(accountTime([activity(1, 0, 'a', value), activity(2, 10, 'a', value)]).human).toBe(0);
  },
);

test('CI/reviewer/queue/merge gaps do not imply human waits', () => {
  const sample = fixtures.passwordResetRun.filter(
    (e) => !['approval.requested', 'plan.submitted'].includes(e.type),
  );
  expect(accountTime(sample).human).toBe(0);
});

test('pending CI prevents whole-run compression even if all agents await human decisions', () => {
  const checks = (pending: number) => ({
    total: 1,
    passed: 1 - pending,
    failed: 0,
    pending,
    failingNames: [],
  });
  const log = [
    activity(1, 0, 'a'),
    event(2, 1, 'ci.updated', { prNumber: 1, checks: checks(1) }, 'a'),
    request(3, 2, 'a'),
    event(4, 6, 'ci.updated', { prNumber: 1, checks: checks(0) }, 'a'),
    decide(5, 8, 'a'),
  ];
  expect(accountTime(log)).toMatchObject({ human: 2000, active: 6000 });
  expect(accountTime(log).perAgent[0]?.approvalWait).toBe(6000);
});

test('orphan and reversed decision endpoints never create inferred historical waits', () => {
  expect(accountTime([decide(1, 0, 'a'), request(2, 2, 'a')], origin + 10000).human).toBe(0);
  expect(accountTime([decide(1, 0, 'a'), activity(2, 10, 'a')]).warnings.join(' ')).toContain(
    'lacks a matching request',
  );
});

test('missing decision is censored at recording tail; connected live wait extends to supplied now', () => {
  const log = [activity(1, 0, 'a'), request(2, 2, 'a'), activity(3, 4, 'a', 'waiting_input')];
  expect(accountTime(log)).toMatchObject({ human: 2000, active: 2000, open: true });
  expect(accountTime(log, origin + 10000)).toMatchObject({ human: 8000, active: 2000 });
  expect(accountTime(log).warnings.join(' ')).toContain('actual end is unknown');
  expect(accountTime(log, origin - 10000).elapsed).toBe(4000);
});

test('resumed activity and exit stop an unresolved wait without inventing a decision', () => {
  const log = [
    activity(1, 0, 'a'),
    request(2, 2, 'a'),
    activity(3, 4, 'a'),
    activity(4, 8, 'a', 'waiting_input'),
  ];
  expect(accountTime(log, origin + 10000).human).toBe(4000);
  expect(accountTime(log).unresolvedApprovals).toEqual([{ sessionId: 'a', approvalId: 'a' }]);
  const exited = [...log.slice(0, 2), event(3, 4, 'session.exited', { code: 0 }, 'a')];
  expect(accountTime(exited, origin + 10000).human).toBe(2000);
  expect(accountTime(exited).warnings.join(' ')).toContain('without a recorded decision');
});

test('useful output interrupts tool and plan waits without relying on prose', () => {
  const log = [
    activity(1, 0, 'a'),
    request(2, 2, 'a'),
    event(3, 4, 'reasoning.summary', { text: 'Working', source: 'agent' }, 'a'),
  ];
  expect(accountTime(log, origin + 10000).human).toBe(2000);
});

test('reconnect, duplicate and out-of-order delivery are deterministic and preserve original objects', () => {
  const log = [activity(1, 0, 'a'), request(2, 2, 'a'), decide(3, 8, 'a')];
  const before = JSON.stringify(log);
  expect(accountTime([log[2]!, log[0]!, log[1]!, log[1]!])).toEqual(accountTime(log));
  expect(canonicalEvents(log)[1]).toBe(log[1]);
  expect(JSON.stringify(log)).toBe(before);
  const prefix = accountTime(log.slice(0, 2), origin + 5000);
  expect(prefix.human).toBe(3000);
  expect(accountTime(log).human).toBe(6000);
});

test('invalid, negative and conflicting timestamps keep uncertain time active', () => {
  const log = [activity(1, 0, 'a'), request(2, 8, 'a'), decide(3, 2, 'a')];
  expect(accountTime(log)).toMatchObject({ active: 8000, human: 0 });
  const invalid = [{ ...log[0]!, ts: 'invalid' }, ...log.slice(1)];
  expect(accountTime(invalid).active).toBe(0);
  expect(accountTime(invalid).durationKnown).toBe(false);
  const conflict = [...log, { ...log[1]!, ts: ts(1) }];
  expect(accountTime(conflict)).toEqual(accountTime([...conflict].reverse()));
  expect(accountTime(conflict).human).toBe(0);
  expect(accountTime([])).toMatchObject({ active: 0, elapsed: 0 });
  expect(accountTime([request(1, 0, 'a'), decide(2, 0, 'a')]).human).toBe(0);
});

test('interval unions reject zero/negative endpoints and never double-count overlap', () => {
  expect(
    unionIntervals([
      { start: 1, end: 5 },
      { start: 3, end: 8 },
      { start: 8, end: 10 },
      { start: 20, end: 19 },
      { start: 5, end: 5 },
    ]),
  ).toEqual([{ start: 1, end: 10 }]);
});

test('chart, seek and inverse share compression with explicit right-edge ties and intact identities', () => {
  const log = [
    activity(1, 0, 'a'),
    request(2, 2, 'a'),
    activity(3, 4, 'a', 'waiting_input'),
    decide(4, 8, 'a'),
    activity(5, 10, 'a'),
  ];
  const accounting = accountTime(log);
  const active = timeMapping(accounting, 'active');
  const elapsed = timeMapping(accounting, 'elapsed');
  expect(active.total).toBe(4000);
  expect(elapsed.total).toBe(10000);
  expect(active.forward(origin + 4000)).toBe(2000);
  expect(active.inverse(2000)).toBe(origin + 8000);
  expect(active.seek(2000)).toBe(3);
  expect(elapsed.seek(4000)).toBe(2);
  for (const ms of [0, 1000, 2000, 3000, 4000]) expect(active.forward(active.inverse(ms))).toBe(ms);
  expect(active.seek(-10)).toBe(0);
  expect(active.seek(Infinity)).toBe(0);
  expect(formatDuration(-10)).toBe('00:00');
  expect(formatDuration(NaN)).toBe('00:00');
});

test('completed sessions stop at the recorded endpoint, even on a connected live source', () => {
  const log = [activity(1, 0, 'a'), event(2, 10, 'session.exited', { code: 0 }, 'a')];
  expect(accountTime(log, origin + 3600000)).toMatchObject({
    elapsed: 10000,
    active: 10000,
    completed: true,
    canTick: false,
  });
  const laterTask = [
    ...log,
    activity(3, 86400, 'b'),
    event(4, 86410, 'session.exited', { code: 0 }, 'b'),
  ];
  // Project history intentionally includes the gap, and never claims this is one task's runtime.
  expect(accountTime(laterTask, origin + 90000000)).toMatchObject({
    elapsed: 86410000,
    completed: true,
  });
});

test('invalid first/all timestamps do not fabricate an epoch-to-present duration or live extrapolation', () => {
  const log = [
    { ...activity(1, 0, 'a'), ts: 'invalid' },
    activity(2, 5, 'a'),
    activity(3, 10, 'a'),
  ];
  expect(accountTime(log, origin + 3600000)).toMatchObject({
    elapsed: 5000,
    active: 5000,
    durationKnown: false,
    canTick: false,
  });
  expect(
    accountTime(
      log.map((e) => ({ ...e, ts: 'invalid' })),
      origin + 3600000,
    ),
  ).toMatchObject({ elapsed: 0, active: 0, durationKnown: false, canTick: false });
  expect(accountTime([], origin + 3600000).elapsed).toBe(0);
});

const reviewPayload = { workerSessionId: 'a', prNumber: 1, headSha: 'head-1' };
test('review lifecycle survives process exit and only its matching verdict/abandonment resolves it', () => {
  const log = [
    activity(1, 0, 'a'),
    activity(2, 0, 'reviewer'),
    event(3, 1, 'agent_review.requested', reviewPayload, 'reviewer'),
    request(4, 2, 'a'),
    event(5, 3, 'session.exited', { code: 1 }, 'reviewer'),
  ];
  expect(accountTime(log, origin + 10000)).toMatchObject({ human: 0, completed: false });
  const wrongHead = event(
    6,
    6,
    'agent_review.abandoned',
    { ...reviewPayload, headSha: 'other', reason: 'Stopped' },
    'reviewer',
  );
  expect(accountTime([...log, wrongHead], origin + 10000).human).toBe(0);
  const abandoned = event(
    6,
    6,
    'agent_review.abandoned',
    { ...reviewPayload, reason: 'Stopped' },
    'reviewer',
  );
  expect(accountTime([...log, abandoned], origin + 10000).human).toBe(4000);
  const verdict = event(
    6,
    6,
    'agent_review.submitted',
    { ...reviewPayload, review: { verdict: 'approve', summary: 'Done', findings: [] } },
    'reviewer',
  );
  expect(accountTime([...log, verdict], origin + 10000).human).toBe(4000);
  const allExited = [...log, event(6, 4, 'session.exited', { code: 0 }, 'a')];
  expect(accountTime(allExited, origin + 10000)).toMatchObject({
    human: 0,
    completed: false,
    elapsed: 10000,
  });
});

test('user messages and contradictory work never delete pending approval identities', () => {
  const log = [
    activity(1, 0, 'a'),
    request(2, 1, 'a', 'A'),
    request(3, 2, 'a', 'B'),
    event(4, 3, 'chat.item', { item: { kind: 'message', role: 'user', text: 'Question' } }, 'a'),
    activity(5, 4, 'a'),
    activity(6, 6, 'a', 'waiting_input'),
    decide(7, 8, 'a', 'A'),
  ];
  const result = accountTime(log, origin + 10000);
  expect(result.human).toBe(7000); // [1,4] + [6,10], B is still unresolved.
  expect(result.unresolvedApprovals).toEqual([{ sessionId: 'a', approvalId: 'B' }]);
  expect(result.open).toBe(true);
  expect(accountTime(log.slice(0, 5)).open).toBe(false);
  expect(accountTime(log.slice(0, 5)).unresolvedApprovals).toHaveLength(2);
});

const planFor = (id: string) => ({
  ...fixtures.passwordResetPlan,
  id,
  orchestratorSessionId: 'a',
  nodes: [{ ...fixtures.passwordResetPlan.nodes[0]!, sessionId: 'a', dependsOn: [] }],
});
test('a replacement plan supersedes blocking evidence without inventing a decision for the old plan', () => {
  const log = [
    activity(1, 0, 'a', 'idle'),
    event(2, 1, 'plan.submitted', { plan: planFor('P1') }, 'a'),
    event(3, 3, 'plan.submitted', { plan: planFor('P2') }, 'a'),
    event(4, 5, 'plan.approved', { planId: 'P2', approvedBy: 'human' }, 'a'),
    activity(5, 10, 'a', 'idle'),
  ];
  expect(accountTime(log)).toMatchObject({ human: 4000, open: false, unresolvedPlans: ['P1'] });
});

test('an explicit worker-slot queue blocks compression until assignment, independent of other human waits', () => {
  const log = [
    activity(1, 0, 'a'),
    event(2, 1, 'plan.node_updated', { nodeId: 'node', waiting: 'worker_slot' }, 'a'),
    request(3, 2, 'a'),
    event(4, 8, 'plan.node_updated', { nodeId: 'node', sessionId: 'a' }, 'a'),
  ];
  expect(accountTime(log, origin + 10000).human).toBe(2000);
});

function design(revision: number, status: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: 'a',
    brief: 'A website',
    revision,
    status,
    rounds: [
      {
        revision: 1,
        jobId: 'job',
        concepts: [1, 2, 3].map((n) => ({
          id: `c${n}`,
          title: `Concept ${n}`,
          imageUrl: `https://example.com/${n}.png`,
          mimeType: 'image/png',
          prompt: 'Draw',
          rationale: 'Clear',
          tradeoffs: [],
          recommended: n === 1,
        })),
      },
    ],
    conversation: [],
    references: [],
    receipts: [],
    ...extra,
  };
}
const designEvent = (seq: number, seconds: number, revision: number, status: string, extra = {}) =>
  event(seq, seconds, 'design.updated', { design: design(revision, status, extra) }, 'a');

test('design generation, ready decision, approval and regeneration are distinct evidenced phases', () => {
  const log = [
    activity(1, 0, 'a', 'idle'),
    designEvent(2, 1, 1, 'pending'),
    designEvent(3, 3, 1, 'ready'),
    designEvent(4, 6, 2, 'approved', {
      decision: { revision: 2, conceptIds: ['c1'], rationale: 'Chosen' },
    }),
    designEvent(5, 8, 3, 'pending'),
  ];
  expect(accountTime(log, origin + 10000).human).toBe(3000);
  // Another useful agent prevents global waiting, even while concepts await a human decision.
  const concurrent = [
    activity(1, 0, 'b'),
    ...log.map((e) => helixEventSchema.parse({ ...e, seq: e.seq + 1 })),
  ];
  expect(accountTime(concurrent, origin + 10000).human).toBe(0);
});

test('design transitions invalidate stale plan blocking evidence; failures are not human waits', () => {
  const log = [
    activity(1, 0, 'a', 'idle'),
    event(2, 1, 'plan.submitted', { plan: planFor('P1') }, 'a'),
    designEvent(3, 2, 1, 'pending'),
    designEvent(4, 4, 1, 'failed', { blocker: 'Provider failed' }),
  ];
  expect(accountTime(log, origin + 10000)).toMatchObject({
    human: 1000,
    open: false,
    unresolvedPlans: ['P1'],
  });
});

test('checkpoint approval waits require a matching recorded worker head and quiescent workers', () => {
  const pr = fixtures.passwordResetRun.find((e) => e.type === 'pr.opened')!;
  if (pr.type !== 'pr.opened') throw new Error('Fixture missing PR');
  const checkpoint = {
    workerSessionId: 'b',
    headSha: 'head',
    previewUrl: 'https://example.com/preview',
    recommendation: 'Review',
    reducedMotion: true,
  };
  const log = [
    activity(1, 0, 'a', 'idle'),
    activity(2, 0, 'b', 'idle'),
    event(
      3,
      1,
      'pr.opened',
      {
        pr: {
          ...pr.payload.pr,
          headSha: 'head',
          review: { decision: 'approved', unresolvedThreads: 0 },
          checks: { total: 0, passed: 0, failed: 0, pending: 0, failingNames: [] },
        },
      },
      'b',
    ),
    designEvent(4, 2, 2, 'ready', { checkpoint }),
  ];
  expect(accountTime(log, origin + 10000).human).toBe(8000);
  expect(accountTime([...log, activity(5, 5, 'b')], origin + 10000).human).toBe(3000);
  const missingHead = log.filter((e) => e.type !== 'pr.opened');
  expect(accountTime(missingHead, origin + 10000).human).toBe(0);
  expect(accountTime([...log, designEvent(5, 4, 1, 'ready')], origin + 10000).human).toBe(2000);
});

test('external review requirements stay active until explicit resolution, even when agents await approvals', () => {
  const log = [
    activity(1, 0, 'a'),
    event(
      2,
      1,
      'review.updated',
      { prNumber: 1, review: { decision: 'review_required', unresolvedThreads: 0 } },
      'a',
    ),
    request(3, 2, 'a'),
    event(
      4,
      6,
      'review.updated',
      { prNumber: 1, review: { decision: 'approved', unresolvedThreads: 0 } },
      'a',
    ),
  ];
  expect(accountTime(log, origin + 10000).human).toBe(4000);
});
