import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { readRecording, replayStart } from './recordings';
import { replayDelays, replayPause } from './useDemoStream';

const replaySeconds = (name: string) => {
  const url = new URL(`../../public/recordings/${name}.helixlog`, import.meta.url);
  const { events } = readRecording(name, readFileSync(url, 'utf8'));
  const shown = events.slice(replayStart(events) - 1, -1);
  return shown.reduce((ms, e) => ms + replayPause(e), 0) / 1000;
};

test('bundled recordings replay at 1× within a demo slot', () => {
  for (const name of ['discount-codes', 'github-ci-repair'])
    expect(replaySeconds(name), name).toBeLessThan(150);
});

test('story events linger longer than tool chatter', () => {
  const url = new URL('../../public/recordings/discount-codes.helixlog', import.meta.url);
  const { events } = readRecording('discount-codes', readFileSync(url, 'utf8'));
  const pause = (type: string) => replayPause(events.find((e) => e.type === type)!);
  expect(pause('pr.merged')).toBeGreaterThan(pause('activity.changed'));
  expect(pause('plan.submitted')).toBeGreaterThan(pause('worktree.diff_updated'));
});

test('recorded planning reaches submission within six seconds without changing events', () => {
  const url = new URL('../../public/recordings/discount-codes.helixlog', import.meta.url);
  const { events } = readRecording('discount-codes', readFileSync(url, 'utf8'));
  const plan = events.findIndex((event) => event.type === 'plan.submitted');
  expect(plan).toBeGreaterThan(0);
  const delays = replayDelays(events);
  expect(delays).toHaveLength(events.length);
  expect(
    delays.slice(replayStart(events) - 1, plan).reduce((sum, delay) => sum + delay, 0),
  ).toBeLessThanOrEqual(6000);
  expect(delays[plan]).toBe(replayPause(events[plan]!));
});
