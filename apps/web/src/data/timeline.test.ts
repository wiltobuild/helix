import { expect, test } from 'vitest';
import { fixtures } from '@helix/contracts';
import { eventIndexAtTime, timelineMilestones } from './timeline';

const run = fixtures.passwordResetRun;
test('time scrubbing respects uneven event spacing, ties, and boundaries', () => {
  const times = [0, 100, 100, 9000];
  const events = run.slice(0, 4).map((e, i) => ({ ...e, ts: new Date(times[i]!).toISOString() }));
  expect(eventIndexAtTime(events, -100)).toBe(0);
  expect(eventIndexAtTime(events, 99)).toBe(0);
  expect(eventIndexAtTime(events, 100)).toBe(2);
  expect(eventIndexAtTime(events, 4500)).toBe(2);
  expect(eventIndexAtTime(events, 9000)).toBe(3);
  expect(eventIndexAtTime(events, 10000)).toBe(3);
});

test('milestones include the beginning, plan, and end without duplicate indices', () => {
  const milestones = timelineMilestones(run);
  expect(milestones[0]).toBe(0);
  expect(milestones.at(-1)).toBe(run.length - 1);
  expect(milestones).toContain(run.findIndex((e) => e.type === 'plan.submitted'));
  expect(new Set(milestones).size).toBe(milestones.length);
});
