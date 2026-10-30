import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react';
import type { HelixEvent, ProjectState } from '@helix/contracts';
import { accountTime, timeMapping, type TimeAccounting, type TimeMode } from './activeTime';
import { createSafeProjector } from './safeProjection';
import {
  cursorIndex,
  initialTimeline,
  timelineDelay,
  timelineKeyAction,
  timelineTimers,
  transitionTimeline,
  type PlaybackOptions,
  type TimelineAction,
} from './timelineState';
export { cursorIndex, eventCursor } from './timelineState';

export interface RunView {
  events: readonly HelixEvent[];
  state: ProjectState;
  latestState: ProjectState;
  current: HelixEvent;
  index: number;
  isLive: boolean;
  seek: (index: number) => void;
  step: (delta: number) => void;
  goLive: () => void;
  playing: boolean;
  togglePlay: () => void;
  bySeq: ReadonlyMap<number, HelixEvent>;
  timeMode: TimeMode;
  setTimeMode: (mode: TimeMode) => void;
  timing: TimeAccounting;
  mapping: ReturnType<typeof timeMapping>;
  seekTime: (position: number) => void;
  eventTime: (index: number) => number;
  position: number;
  key: (key: string, slider?: boolean) => boolean;
}

/** One story-paced playback clock; the chart always gets the full latest projection.
 * A source ID changes only on deliberate selection, never because earlier backfill arrives. */
export function useRun(
  input: readonly HelixEvent[],
  {
    recorded = false,
    speed = 1,
    startAt = 0,
    connected = false,
    sourceId = 'history',
  }: PlaybackOptions & { connected?: boolean; sourceId?: string } = {},
): RunView | { error: string } {
  const observed = useMemo(() => accountTime(input), [input]);
  const events = observed.events;
  const [stored, setControl] = useState(() =>
    initialTimeline(sourceId, events, { recorded, startAt }),
  );
  const control =
    stored.sourceId === sourceId
      ? stored
      : initialTimeline(sourceId, events, { recorded, startAt });
  if (control !== stored) setControl(control);
  const liveClock = connected && !recorded;
  const timing = useMemo(
    () => (liveClock && control.now !== undefined ? accountTime(input, control.now) : observed),
    [input, observed, liveClock, control.now],
  );
  const mapping = useMemo(() => timeMapping(timing, control.timeMode), [timing, control.timeMode]);
  const projector = useMemo(() => createSafeProjector(observed), [observed]);
  const index = cursorIndex(events, control.cursor);
  const current = events[index];
  const last = events.at(-1);
  const projection = useMemo(() => projector.at(current?.seq ?? 0), [projector, current?.seq]);
  const latest = useMemo(() => projector.at(last?.seq ?? 0), [projector, last?.seq]);
  const valid = projection.ok && latest.ok;
  const bySeq = useMemo(() => new Map(events.map((event) => [event.seq, event])), [events]);
  const dispatch = useCallback(
    (action: TimelineAction) => {
      if (!valid) return;
      setControl((state) =>
        state.sourceId === sourceId ? transitionTimeline(state, action, timing) : state,
      );
    },
    [timing, sourceId, valid],
  );
  const policy = timelineTimers(control, liveClock, observed);
  const clockEnabled = valid && policy.clock;
  const replayEnabled = valid && policy.replay;
  const delay = useMemo(
    () => timelineDelay(events, index, { recorded, speed }),
    [events, index, recorded, speed],
  );
  const tickClock = useEffectEvent(() =>
    dispatch({ type: 'clockTick', now: Date.now(), connected: liveClock }),
  );
  const tickReplay = useEffectEvent(() => dispatch({ type: 'replayTick' }));
  useEffect(() => {
    if (!clockEnabled) return;
    const timer = window.setInterval(() => tickClock(), 1000);
    return () => window.clearInterval(timer);
  }, [clockEnabled]);
  useEffect(() => {
    if (!replayEnabled) return;
    const timer = window.setTimeout(() => tickReplay(), delay);
    return () => window.clearTimeout(timer);
  }, [replayEnabled, sourceId, current?.seq, delay]);
  if (!projection.ok) return { error: projection.error };
  if (!latest.ok) return { error: latest.error };
  if (!current) return { error: 'No event is available at the selected position.' };
  return {
    events,
    current,
    index,
    state: projection.state,
    latestState: latest.state,
    bySeq,
    timing,
    mapping,
    isLive: control.cursor === null,
    playing: control.playing,
    timeMode: control.timeMode,
    position: mapping.forward(control.cursor === null ? timing.end : timing.times[index]!),
    eventTime: (i) => mapping.forward(timing.times[i] ?? timing.start),
    seek: (i) => dispatch({ type: 'seek', index: i }),
    step: (delta) => dispatch({ type: 'step', delta }),
    goLive: () => dispatch({ type: 'live' }),
    togglePlay: () => dispatch({ type: 'togglePlay' }),
    setTimeMode: (mode) => dispatch({ type: 'mode', mode }),
    seekTime: (position) => dispatch({ type: 'seekTime', position }),
    key: (key, slider = false) => {
      const action = timelineKeyAction(key, events.length, slider);
      if (!action) return false;
      dispatch(action);
      return true;
    },
  };
}
