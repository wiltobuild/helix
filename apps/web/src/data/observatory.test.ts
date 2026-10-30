import { expect, test } from 'vitest';
import { createProjector, fixtures, projectUpTo } from '@helix/contracts';
import {
  activityFeed,
  commits,
  formatDuration,
  ganttLanes,
  narratedEvent,
  planBlockers,
  planSummary,
  planTree,
  taskLabel,
} from './observatory';

const run = fixtures.passwordResetRun;
const at = (seq: number) => {
  const index = run.findIndex((e) => e.seq === seq);
  return { state: projectUpTo(run, seq), index, ts: run[index]!.ts };
};

test('planTree groups tasks under their agent and numbers them in plan order', () => {
  const { state, index, ts } = at(15);
  const tree = planTree(state, run, index, ts)!;
  expect(tree.tasks.map((t) => t.number)).toEqual([1, 2, 3]);
  expect(tree.agents.map((a) => a.agent).sort()).toEqual(['claude-code', 'codex']);
  expect(tree.agents.flatMap((a) => a.tasks).length).toBe(tree.tasks.length);
  expect(tree.orchestrator.total).toBe(3);
});

test('a waiting plan blocks with the approval reason and nothing started', () => {
  const planSeq = run.find((e) => e.type === 'plan.submitted')!.seq;
  const { state, index, ts } = at(planSeq);
  const tree = planTree(state, run, index, ts)!;
  expect(tree.orchestrator.statusLabel).toBe('Needs review');
  expect(tree.tasks.every((t) => t.status === 'pending')).toBe(true);
  const blockers = planBlockers(tree, state)!;
  expect(blockers[0]).toMatch(/needs your approval/);
  expect(planSummary(tree).tasks).toBe(3);
});

test('task labels follow the render: Todo, In progress, Blocked, Done', () => {
  expect(taskLabel('pending', false).label).toBe('Todo');
  expect(taskLabel('pending', true).label).toBe('Waiting');
  expect(taskLabel('working', false).label).toBe('In progress');
  expect(taskLabel('ci_failed', false).tone).toBe('blocked');
  expect(taskLabel('merged', false).label).toBe('Done');
});

test('the Why strip narrates meaningful events, not agent chatter', () => {
  for (let i = 0; i < run.length; i++) {
    const e = narratedEvent(run, i);
    expect(e.seq).toBeLessThanOrEqual(run[i]!.seq);
    if (e.type === 'chat.item') expect(e.payload.item.kind).toBe('message');
  }
});

test('gantt lanes: orchestrator, one per agent, one per task, cursor inside the axis', () => {
  const last = run.length - 1;
  const state = createProjector(run).at(run[last]!.seq);
  const tree = planTree(state, run, last, run[last]!.ts)!;
  const { lanes, cursorAt } = ganttLanes(run, last, state, tree);
  expect(lanes[0]!.kind).toBe('orchestrator');
  expect(lanes.filter((l) => l.kind === 'agent').length).toBe(tree.agents.length);
  expect(lanes.filter((l) => l.kind === 'task').length).toBe(tree.tasks.length);
  expect(cursorAt).toBeGreaterThanOrEqual(0);
  expect(cursorAt).toBeLessThanOrEqual(1);
  for (const l of lanes)
    for (const b of l.bars) {
      expect(b.from).toBeGreaterThanOrEqual(0);
      expect(b.to).toBeLessThanOrEqual(1);
    }
});

test('activity feed is newest first and stops at the cursor', () => {
  const { state, index } = at(15);
  const feed = activityFeed(run, index, state);
  expect(feed[0]!.seq).toBeLessThanOrEqual(15);
  for (let i = 1; i < feed.length; i++) expect(feed[i]!.seq).toBeLessThan(feed[i - 1]!.seq);
});

test('commits parse Helix commit messages; durations read naturally', () => {
  const state = createProjector(run).at(run.at(-1)!.seq);
  for (const c of commits(state)) expect(c.sha).toMatch(/^[0-9a-f]{7,40}$/);
  expect(formatDuration(45_000)).toBe('45s');
  expect(formatDuration(28 * 60_000)).toBe('28m');
  expect(formatDuration(134 * 60_000)).toBe('2h 14m');
});
