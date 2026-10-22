import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createProjector, type HelixEvent, type ProjectState } from '@helix/contracts';

export interface RunView {
  /** All events received so far (live tail grows over time). */
  events: readonly HelixEvent[];
  /** Projected state at the cursor. */
  state: ProjectState;
  /** The event the cursor sits on. */
  current: HelixEvent;
  /** Index into `events` of the cursor. */
  index: number;
  /** True when following the newest event. */
  isLive: boolean;
  seek: (index: number) => void;
  step: (delta: number) => void;
  goLive: () => void;
  playing: boolean;
  togglePlay: () => void;
  bySeq: ReadonlyMap<number, HelixEvent>;
}

/**
 * Holds a run's event log and a cursor into it. `cursor === null` means live (follow the tail).
 * The projector is rebuilt when new events arrive; scrubbing uses its checkpoints, so dragging
 * the timeline never refolds the whole history.
 */
export function useRun(events: readonly HelixEvent[]): RunView {
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  const projector = useMemo(() => createProjector(events), [events]);
  const bySeq = useMemo(() => new Map(events.map((e) => [e.seq, e])), [events]);

  const last = events.length - 1;
  const index = cursor === null ? last : Math.min(cursor, last);
  const current = events[index]!;
  const state = useMemo(() => projector.at(current.seq), [projector, current.seq]);

  const seek = useCallback(
    (i: number) => {
      const clamped = Math.max(0, Math.min(i, last));
      setCursor(clamped >= last ? null : clamped);
    },
    [last],
  );
  const step = useCallback((delta: number) => seek(index + delta), [seek, index]);
  const goLive = useCallback(() => {
    setPlaying(false);
    setCursor(null);
  }, []);

  // Replay: advance one event at a time from the cursor; stops at the tail.
  const indexRef = useRef(index);
  indexRef.current = index;
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const next = indexRef.current + 1;
      if (next >= last) {
        setCursor(null);
        setPlaying(false);
      } else setCursor(next);
    }, 650);
    return () => window.clearInterval(id);
  }, [playing, last]);

  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      if (!p && cursor === null) setCursor(0);
      return !p;
    });
  }, [cursor]);

  return {
    events,
    state,
    current,
    index,
    isLive: cursor === null,
    seek,
    step,
    goLive,
    playing,
    togglePlay,
    bySeq,
  };
}
