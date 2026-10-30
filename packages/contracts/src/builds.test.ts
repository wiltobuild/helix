import { expect, test } from 'vitest';
import {
  createProjector,
  fixtures,
  projectBuilds,
  projectUpTo,
  sessionIdSchema,
  visualDesignSchema,
} from './index.js';

const run = fixtures.passwordResetRun;
const ids = fixtures.passwordResetIds;

test('build preserves original request across design rounds and plan goal changes', () => {
  const state = projectUpTo(run, 6);
  const root = state.sessions[ids.orchestrator]!;
  root.session.prompt = 'Build the Daybreak storefront, including checkout and tests';
  state.plans[fixtures.passwordResetPlan.id]!.goal = 'Produce three concepts';
  const design = visualDesignSchema.parse({
    sessionId: ids.orchestrator,
    revision: 2,
    brief: 'Refined visual brief',
    status: 'ready',
    rounds: [],
    conversation: [],
    references: [],
    receipts: [],
  });
  root.design = design;
  const before = structuredClone(state);
  const build = projectBuilds(state)[0]!;
  expect(build.goal).toBe(root.session.prompt);
  expect(build.stages).toContainEqual({
    kind: 'planning',
    status: 'approved',
    planId: fixtures.passwordResetPlan.id,
  });
  expect(build.stages).toContainEqual({ kind: 'design', status: 'ready', revision: 2 });
  expect(state).toEqual(before);
  root.design = {
    ...design,
    status: 'approved',
    decision: { revision: 2, conceptIds: ['two'], rationale: 'Combine ideas' },
  };
  expect(projectBuilds(state)[0]!.stages).toContainEqual({
    kind: 'design',
    status: 'approved',
    revision: 2,
    approvedRevision: 2,
  });
  root.design = { ...root.design, revision: 3, status: 'ready' };
  expect(projectBuilds(state)[0]!.stages).toContainEqual({
    kind: 'design',
    status: 'ready',
    revision: 3,
  });
  expect(projectBuilds(state)[0]!.goal).toBe(build.goal);
});

test('stage facts follow recorded plan approval and replay at every event', () => {
  const projector = createProjector(run);
  expect(projectBuilds(projector.at(1))).toEqual([]);
  expect(projectBuilds(projector.at(2))[0]!.stages).toEqual([
    { kind: 'planning', status: 'preparing' },
  ]);
  expect(projectBuilds(projector.at(5))[0]!.stages[0]).toMatchObject({
    status: 'awaiting_approval',
  });
  expect(projectBuilds(projector.at(6))[0]!.stages[0]).toMatchObject({ status: 'approved' });
  for (const e of run)
    expect(projectBuilds(projector.at(e.seq))).toEqual(projectBuilds(projectUpTo(run, e.seq)));
});

test('builds exclude children/reviewers and retain distinct roots within a project', () => {
  const state = projectUpTo(run, run.at(-1)!.seq);
  const other = sessionIdSchema.parse('other-build');
  state.sessions[other] = structuredClone(state.sessions[ids.orchestrator]!);
  state.sessions[other].session = {
    ...state.sessions[other].session,
    id: other,
    title: 'Other build',
    prompt: 'Independent outcome',
  };
  const builds = projectBuilds(state);
  expect(builds).toHaveLength(2);
  expect(builds[0]!.sessionIds).toEqual(
    expect.arrayContaining([ids.orchestrator, ids.api, ids.ui]),
  );
  expect(builds[0]!.sessionIds).not.toContain(other);
  expect(builds[1]!.stages).toEqual([{ kind: 'planning', status: 'preparing' }]);
});

test('stale AI review never counts as current approval; exited workers are not merged', () => {
  const state = projectUpTo(run, run.at(-1)!.seq);
  const worker = state.sessions[ids.api]!;
  worker.pr!.state = 'open';
  worker.activity = 'exited';
  worker.agentReview = {
    reviewerSessionId: sessionIdSchema.parse('reviewer'),
    headSha: 'old-sha',
    status: 'approved',
  };
  const stage = projectBuilds(state)[0]!.stages.find((s) => s.kind === 'review');
  expect(stage).toMatchObject({ staleReviews: 1, currentApprovals: 0 });
  worker.agentReview.headSha = worker.pr!.headSha;
  expect(projectBuilds(state)[0]!.stages.find((s) => s.kind === 'review')).toMatchObject({
    staleReviews: 0,
    currentApprovals: 1,
  });
});
