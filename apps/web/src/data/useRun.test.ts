import { expect, test } from 'vitest';
import { fixtures } from '@helix/contracts';
import { cursorIndex, eventCursor } from './useRun';
import { accountTime, canonicalEvents, timeMapping } from './activeTime';

const events = fixtures.passwordResetRun;

test('reconnect backfill preserves selection by sequence, including a selected tail', () => {
  const partial = events.filter((_, i) => i % 2 === 0);
  const selected = eventCursor(partial, 4);
  const reconnected = canonicalEvents([...partial, ...events].reverse());
  expect(reconnected[cursorIndex(reconnected, selected)]?.seq).toBe(partial[4]?.seq);
  const tail = eventCursor(partial, partial.length - 1);
  expect(tail).not.toBeNull();
  expect(reconnected[cursorIndex(reconnected, tail)]?.seq).toBe(partial.at(-1)?.seq);
  expect(cursorIndex(reconnected, null)).toBe(reconnected.length - 1);
});

test('toggle and Why/milestone seeks retain exact identity; keyboard stepping reaches every event', () => {
  const timing = accountTime(events);
  let cursor = eventCursor(events, 0);
  for (let index = 0; index < events.length; index++) {
    expect(cursorIndex(events, cursor)).toBe(index);
    for (const mode of ['active', 'elapsed'] as const) {
      const mapping = timeMapping(timing, mode);
      expect(Number.isFinite(mapping.forward(timing.times[index]!))).toBe(true);
      expect(events[cursorIndex(events, cursor)]).toBe(events[index]);
    }
    cursor = eventCursor(events, cursorIndex(events, cursor) + 1);
  }
  for (let index = events.length - 1; index >= 0; index--) {
    expect(cursorIndex(events, cursor)).toBe(index);
    cursor = eventCursor(events, cursorIndex(events, cursor) - 1);
  }
  const cause = events.find((event) => event.causedBy !== undefined)!;
  cursor = eventCursor(
    events,
    events.findIndex((event) => event.seq === cause.causedBy),
  );
  expect(events[cursorIndex(events, cursor)]?.seq).toBe(cause.causedBy);
});

test('zero-length, invalid and boundary selections are safe', () => {
  expect(eventCursor([], 0)).toBeNull();
  expect(eventCursor(events, NaN)).toBeNull();
  expect(eventCursor(events, -5)).toBe(events[0]?.seq);
  expect(eventCursor(events, events.length + 5)).toBe(events.at(-1)?.seq);
});
