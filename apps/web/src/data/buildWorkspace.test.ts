import { expect, test } from 'vitest';
import { fixtures, projectUpTo, sessionIdSchema } from '@helix/contracts';
import { buildWorkspace } from './buildWorkspace';
import { planTree } from './observatory';

const events = fixtures.passwordResetRun;
function twoBuilds() {
  const state = projectUpTo(events, events.at(-1)!.seq);
  const id = sessionIdSchema.parse('daybreak-direct');
  const root = structuredClone(state.sessions[fixtures.passwordResetIds.orchestrator]!);
  root.session = {
    ...root.session,
    id,
    role: 'worker',
    title: 'Daybreak',
    prompt: 'Build a complete storefront',
  };
  state.sessions[id] = root;
  return { state, id };
}

test('opening either build switches goal, plan, worker scope together', () => {
  const { state, id } = twoBuilds();
  const direct = buildWorkspace(state, id);
  expect(direct.build?.goal).toBe('Build a complete storefront');
  expect(Object.keys(direct.state.sessions)).toEqual([id]);
  expect(planTree(direct.state, events, events.length - 1, events.at(-1)!.ts)).toBeUndefined();
  const planned = buildWorkspace(state, fixtures.passwordResetIds.orchestrator);
  expect(planned.build?.rootSessionId).toBe(fixtures.passwordResetIds.orchestrator);
  expect(planTree(planned.state, events, events.length - 1, events.at(-1)!.ts)?.plan.id).toBe(
    fixtures.passwordResetPlan.id,
  );
  expect(planned.state.sessions[id]).toBeUndefined();
  expect(buildWorkspace(state, fixtures.passwordResetIds.api).build).toEqual(planned.build);
  expect(buildWorkspace(state).build).toEqual(direct.build);
  expect(Object.keys(state.sessions)).toContain(id);
});

test('replaying before a selected build existed reveals no future build facts', () => {
  const old = buildWorkspace(projectUpTo(events, 6), 'daybreak-direct');
  expect(old.build?.rootSessionId).toBe(fixtures.passwordResetIds.orchestrator);
  expect(old.build?.stages).not.toContainEqual(expect.objectContaining({ kind: 'design' }));
  expect(Object.keys(old.state.sessions)).toEqual([fixtures.passwordResetIds.orchestrator]);
});
