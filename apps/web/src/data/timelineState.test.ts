import { expect, test } from 'vitest';
import { fixtures, helixEventSchema } from '@helix/contracts';
import { accountTime, timeMapping } from './activeTime';
import {
  cursorIndex,
  initialTimeline,
  timelineKeyAction,
  timelineTimers,
  timelineDelay,
  transitionTimeline,
} from './timelineState';

const events = fixtures.passwordResetRun;
const timing = accountTime(events);

test('production toggle/seek/Why/keyboard transitions preserve event identity inside collapsed waits', () => {
  let state = initialTimeline('source');
  for (let index = 0; index < events.length; index++) {
    state = transitionTimeline(state, { type: 'seek', index }, timing);
    const selected = state.cursor;
    for (const mode of ['active', 'elapsed'] as const) {
      state = transitionTimeline(state, { type: 'mode', mode }, timing);
      expect(state.cursor).toBe(selected);
      expect(cursorIndex(events, state.cursor)).toBe(index);
    }
    const key = timelineKeyAction('ArrowLeft', events.length, true)!;
    state = transitionTimeline(state, key, timing);
    expect(cursorIndex(events, state.cursor)).toBe(Math.max(0, index - 1));
  }
  const causalEvent = events.find((event) => event.causedBy !== undefined)!;
  state = transitionTimeline(
    state,
    { type: 'seek', index: events.findIndex((event) => event.seq === causalEvent.causedBy) },
    timing,
  );
  expect(state.cursor).toBe(causalEvent.causedBy);
  state = transitionTimeline(state, timelineKeyAction('L', events.length)!, timing);
  expect(state.cursor).toBeNull();
});

test('all-collapsed and zero-duration timelines support pointer inverse, every keyboard event, and replay', () => {
  const request = fixtures.passwordResetRun.find((event) => event.type === 'approval.requested')!;
  const decision = fixtures.passwordResetRun.find((event) => event.type === 'approval.decided')!;
  const log = [
    helixEventSchema.parse({ ...request, seq: 1, ts: '2026-10-01T00:00:00Z' }),
    helixEventSchema.parse({ ...decision, seq: 2, ts: '2026-10-01T00:00:10Z' }),
  ];
  const collapsed = accountTime(log);
  let state = transitionTimeline(
    initialTimeline('source'),
    { type: 'mode', mode: 'active' },
    collapsed,
  );
  expect(timeMapping(collapsed, state.timeMode).total).toBe(0);
  state = transitionTimeline(state, { type: 'seekTime', position: 0 }, collapsed);
  expect(state.cursor).toBe(log[1]!.seq);
  state = transitionTimeline(state, timelineKeyAction('Home', 2, true)!, collapsed);
  expect(state.cursor).toBe(log[0]!.seq);
  state = transitionTimeline(state, timelineKeyAction(']', 2)!, collapsed);
  expect(state.cursor).toBe(log[1]!.seq);
  state = transitionTimeline(state, { type: 'togglePlay' }, collapsed);
  expect(state).toMatchObject({ cursor: log[0]!.seq, playing: true, timeMode: 'active' });
  state = transitionTimeline(state, { type: 'replayTick' }, collapsed);
  expect(state).toMatchObject({ cursor: log[1]!.seq, playing: false, timeMode: 'active' });
  const zero = accountTime(log.map((event) => ({ ...event, ts: log[0]!.ts })));
  expect(timeMapping(zero, 'active').total).toBe(0);
  expect(transitionTimeline(state, { type: 'seekTime', position: 0 }, zero).cursor).toBe(
    log[1]!.seq,
  );
  expect(transitionTimeline(state, { type: 'seekTime', position: NaN }, zero)).toBe(state);
});

test('recorded playback preserves startAt, speed, story pacing and stops at an explicit final event', () => {
  let state = initialTimeline('recording', events, { recorded: true, startAt: 2 });
  expect(state).toMatchObject({ cursor: events[2]!.seq, playing: true });
  expect(timelineDelay(events, 2, { recorded: true, speed: 4 })).toBe(
    timelineDelay(events, 2, { recorded: true, speed: 1 }) / 4,
  );
  const plan = events.findIndex((event) => event.type === 'plan.submitted');
  expect(
    events
      .slice(0, plan)
      .reduce((sum, _, i) => sum + timelineDelay(events, i, { recorded: true }), 0),
  ).toBeLessThanOrEqual(6000);
  state = transitionTimeline(state, { type: 'mode', mode: 'active' }, timing);
  expect(state).toMatchObject({ cursor: events[2]!.seq, playing: true, timeMode: 'active' });
  while (state.playing) state = transitionTimeline(state, { type: 'replayTick' }, timing);
  expect(state.cursor).toBe(events.at(-1)!.seq);
  state = transitionTimeline(state, { type: 'togglePlay' }, timing);
  expect(state).toMatchObject({ cursor: events[0]!.seq, playing: true });
  const reset = transitionTimeline(
    state,
    { type: 'source', sourceId: 'new-recording', recorded: true, startAt: 3 },
    timing,
  );
  expect(reset).toMatchObject({ cursor: events[3]!.seq, playing: true, timeMode: 'elapsed' });
});

test('timer policy stops completed clocks, ignores disconnected ticks and resets stale source timestamps', () => {
  const running = events.slice(0, 3);
  const active = accountTime(running);
  const now = active.end + 10000;
  let state = initialTimeline('first');
  expect(timelineTimers(state, true, active)).toEqual({ clock: true, replay: false });
  expect(transitionTimeline(state, { type: 'clockTick', now, connected: false }, active)).toBe(
    state,
  );
  state = transitionTimeline(state, { type: 'clockTick', now, connected: true }, active);
  expect(state.now).toBe(now);
  const exit = helixEventSchema.parse({
    ...running[2],
    type: 'session.exited',
    payload: { code: 0 },
    seq: 4,
  });
  const ended = accountTime([...running, exit]);
  expect(timelineTimers(state, true, ended).clock).toBe(false);
  expect(
    transitionTimeline(state, { type: 'clockTick', now: now + 10000, connected: true }, ended),
  ).toBe(state);
  expect(accountTime([...running, exit], state.now).end).toBe(ended.end);
  state = transitionTimeline(state, { type: 'source', sourceId: 'second' }, ended);
  expect(state.now).toBeUndefined();
  expect(state.cursor).toBeNull();
});

test('manual seek cancels replay and replay ticks cannot move a paused selection', () => {
  let state = transitionTimeline(initialTimeline('source'), { type: 'togglePlay' }, timing);
  expect(timelineTimers(state, false, timing).replay).toBe(true);
  state = transitionTimeline(state, { type: 'seek', index: 3 }, timing);
  expect(state.playing).toBe(false);
  expect(transitionTimeline(state, { type: 'replayTick' }, timing)).toBe(state);
  expect(state.cursor).toBe(events[3]!.seq);
});
