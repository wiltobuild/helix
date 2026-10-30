import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { fixtures, helixEventSchema, projectUpTo } from '@helix/contracts';
import { agentRoster } from '../data/agentRoster';
import { planTree } from '../data/observatory';
import { AgentRoster } from './AgentRoster';

const { crossReviewRun: run, crossReviewIds: ids, crossReviewMilestones: at } = fixtures;
const requested = run.find((e) => e.type === 'agent_review.requested')!;
const noop = () => {};
const rosterAt = (seq: number) =>
  agentRoster(
    projectUpTo(run, seq),
    undefined,
    run,
    run.findIndex((e) => e.seq === seq),
  );

test('individual worker and reviewer cards preserve identities and relationships', () => {
  const state = projectUpTo(run, at.approved);
  const roster = rosterAt(at.approved);
  expect(roster).toHaveLength(2);
  expect(roster.find((a) => a.id === ids.worker)).toMatchObject({
    name: 'Discount Codes Engineer',
    role: 'Worker',
    agent: 'codex',
    relationships: [{ id: ids.reviewer, label: 'Reviewer' }],
  });
  expect(roster.find((a) => a.id === ids.reviewer)).toMatchObject({
    name: 'Discount Codes Reviewer',
    role: 'Reviewer',
    status: 'Completed',
    review: 'approved',
    relationships: [{ id: ids.worker, label: 'Reviews' }],
  });
  const html = renderToStaticMarkup(
    <AgentRoster
      state={state}
      events={run}
      index={run.findIndex((e) => e.seq === at.approved)}
      tree={undefined}
      onOpen={noop}
    />,
  );
  expect(html.match(/<article /g)).toHaveLength(2);
  expect(html).toContain(ids.worker);
  expect(html).toContain(ids.reviewer);
  expect(html).toContain('Open Discount Codes Reviewer session');
});

test('replay never leaks a future reviewer or verdict', () => {
  const created = run.find(
    (e) => e.type === 'session.created' && e.payload.session.role === 'reviewer',
  )!;
  expect(rosterAt(created.seq - 1).some((a) => a.role === 'Reviewer')).toBe(false);
  expect(rosterAt(requested.seq).find((a) => a.role === 'Reviewer')?.review).toBe(
    'Verdict pending',
  );
  expect(rosterAt(at.changesRequested).find((a) => a.role === 'Reviewer')?.review).toBe(
    'changes requested',
  );
  const pushed = run.find((e) => e.type === 'pr.updated')!;
  expect(rosterAt(pushed.seq).find((a) => a.role === 'Reviewer')?.review).toContain(
    'Historical verdict',
  );
});

test('an abandoned review is stopped without approval', () => {
  if (requested.type !== 'agent_review.requested') throw new Error('fixture');
  const abandoned = helixEventSchema.parse({
    ...requested,
    seq: requested.seq + 1,
    type: 'agent_review.abandoned',
    payload: { ...requested.payload, reason: 'Runtime unavailable' },
  });
  const events = [...run.filter((e) => e.seq <= requested.seq), abandoned];
  const roster = agentRoster(
    projectUpTo(events, abandoned.seq),
    undefined,
    events,
    events.length - 1,
  );
  expect(roster.find((a) => a.role === 'Reviewer')).toMatchObject({
    status: 'Stopped',
    active: false,
    review: 'No verdict: Runtime unavailable',
  });
});

test('planned cards attach once and the selected plan excludes unrelated workers', () => {
  const events = fixtures.passwordResetRun;
  const submitted = events.find((e) => e.type === 'plan.submitted')!;
  const before = projectUpTo(events, submitted.seq);
  const tree = planTree(before, events, submitted.seq - 1, submitted.ts)!;
  const planned = agentRoster(before, tree, events, submitted.seq - 1);
  expect(planned).toHaveLength(tree.tasks.length);
  expect(planned.every((a) => a.status === 'Planned' && !a.sessionId)).toBe(true);
  const state = projectUpTo(events, events.at(-1)!.seq);
  const unrelated = projectUpTo(run, at.approved);
  const mixed = { ...state, sessions: { ...state.sessions, ...unrelated.sessions } };
  const current = planTree(mixed, events, events.length - 1, events.at(-1)!.ts)!;
  const roster = agentRoster(mixed, current, events, events.length - 1);
  expect(roster.some((a) => a.id === ids.worker || a.id === ids.reviewer)).toBe(false);
  expect(roster.filter((a) => a.role === 'Worker')).toHaveLength(current.tasks.length);
});

test('abandoning a stale completed review retains its historical verdict', () => {
  const pushed = run.find((e) => e.type === 'pr.updated')!;
  const approved = run.find((e) => e.seq === at.approved)!;
  if (pushed.type !== 'pr.updated' || approved.type !== 'agent_review.submitted')
    throw new Error('fixture');
  const moved = helixEventSchema.parse({
    ...pushed,
    seq: run.at(-1)!.seq + 1,
    payload: { pr: { ...pushed.payload.pr, headSha: 'new-revision' } },
  });
  const abandoned = helixEventSchema.parse({
    ...approved,
    seq: moved.seq + 1,
    type: 'agent_review.abandoned',
    payload: {
      workerSessionId: ids.worker,
      prNumber: approved.payload.prNumber,
      headSha: approved.payload.headSha,
      reason: 'Reviewer unavailable',
    },
  });
  const events = [...run, moved, abandoned];
  const state = projectUpTo(events, abandoned.seq, { strict: true });
  expect(
    agentRoster(state, undefined, events, events.length - 1).find((a) => a.role === 'Reviewer'),
  ).toMatchObject({
    status: 'Stopped',
    review:
      'Historical verdict recorded; no verdict for the current revision: Reviewer unavailable',
  });
});
