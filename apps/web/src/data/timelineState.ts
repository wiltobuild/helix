import type { HelixEvent } from '@helix/contracts';
import { timeMapping, type TimeAccounting, type TimeMode } from './activeTime';
import { replayDelays, replayPause } from './useDemoStream';

export interface TimelineState {
  sourceId: string;
  cursor: number | null;
  timeMode: TimeMode;
  playing: boolean;
  now: number | undefined;
}
export interface PlaybackOptions {
  recorded?: boolean;
  speed?: number;
  startAt?: number;
}
export const initialTimeline = (
  sourceId: string,
  events: readonly HelixEvent[] = [],
  options: PlaybackOptions = {},
): TimelineState => ({
  sourceId,
  cursor: options.recorded ? eventCursor(events, options.startAt ?? 0) : null,
  timeMode: 'elapsed',
  playing: !!options.recorded && events.length - 1 > Math.max(0, options.startAt ?? 0),
  now: undefined,
});
export function cursorIndex(events: readonly HelixEvent[], seq: number | null): number {
  if (seq === null) return events.length - 1;
  const index = events.findIndex((event) => event.seq === seq);
  return index === -1 ? events.length - 1 : index;
}
export function eventCursor(events: readonly HelixEvent[], index: number): number | null {
  if (!Number.isFinite(index)) return null;
  return events[Math.max(0, Math.min(Math.trunc(index), events.length - 1))]?.seq ?? null;
}
export type TimelineAction =
  | ({ type: 'source'; sourceId: string } & PlaybackOptions)
  | { type: 'mode'; mode: TimeMode }
  | { type: 'seek'; index: number }
  | { type: 'seekTime'; position: number }
  | { type: 'step'; delta: number }
  | { type: 'live' | 'togglePlay' | 'replayTick' }
  | { type: 'clockTick'; now: number; connected: boolean };

export function timelineTimers(state: TimelineState, connected: boolean, timing: TimeAccounting) {
  return { clock: connected && timing.canTick, replay: state.playing && timing.events.length > 1 };
}

/** The hook and tests use the same transitions, including clock/replay callbacks. */
export function transitionTimeline(
  state: TimelineState,
  action: TimelineAction,
  timing: TimeAccounting,
): TimelineState {
  const events = timing.events;
  const index = cursorIndex(events, state.cursor);
  switch (action.type) {
    case 'source':
      return action.sourceId === state.sourceId
        ? state
        : initialTimeline(action.sourceId, events, action);
    case 'mode':
      return { ...state, timeMode: action.mode };
    case 'seek':
      return Number.isFinite(action.index)
        ? { ...state, cursor: eventCursor(events, action.index), playing: false }
        : state;
    case 'seekTime':
      return Number.isFinite(action.position)
        ? {
            ...state,
            cursor: eventCursor(events, timeMapping(timing, state.timeMode).seek(action.position)),
            playing: false,
          }
        : state;
    case 'step':
      return Number.isFinite(action.delta)
        ? { ...state, cursor: eventCursor(events, index + action.delta), playing: false }
        : state;
    case 'live':
      return { ...state, cursor: null, playing: false };
    case 'togglePlay':
      if (state.playing) return { ...state, playing: false };
      if (events.length < 2) return state;
      return {
        ...state,
        playing: true,
        cursor:
          state.cursor === null || index === events.length - 1
            ? eventCursor(events, 0)
            : state.cursor,
      };
    case 'replayTick':
      if (!state.playing) return state;
      return index + 1 >= events.length - 1
        ? { ...state, cursor: eventCursor(events, events.length - 1), playing: false }
        : { ...state, cursor: eventCursor(events, index + 1) };
    case 'clockTick':
      return timelineTimers(state, action.connected, timing).clock && Number.isFinite(action.now)
        ? { ...state, now: Math.max(state.now ?? timing.end, action.now) }
        : state;
  }
}

/** Preserve current Dock's story-paced playback, including the bounded recorded introduction. */
export function timelineDelay(
  events: readonly HelixEvent[],
  index: number,
  options: PlaybackOptions,
): number {
  const event = events[index];
  const base = options.recorded
    ? (replayDelays(events)[index] ?? 650)
    : event
      ? replayPause(event)
      : 650;
  const speed =
    options.speed !== undefined && Number.isFinite(options.speed) && options.speed > 0
      ? options.speed
      : 1;
  return base / speed;
}

/** Event-based keys intentionally reach identities that share a collapsed coordinate. */
export function timelineKeyAction(
  key: string,
  length: number,
  slider = false,
): TimelineAction | undefined {
  if (key === '[' || (slider && ['ArrowLeft', 'ArrowDown'].includes(key)))
    return { type: 'step', delta: -1 };
  if (key === ']' || (slider && ['ArrowRight', 'ArrowUp'].includes(key)))
    return { type: 'step', delta: 1 };
  if (key.toLowerCase() === 'l') return { type: 'live' };
  if (slider && ['Home', 'End'].includes(key))
    return { type: 'seek', index: key === 'Home' ? 0 : length - 1 };
  return undefined;
}
