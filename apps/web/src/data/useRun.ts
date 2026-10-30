import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createProjector, type HelixEvent, type ProjectState } from '@helix/contracts';
import { indexIdentities, withIdentityIndex } from './identity';
import { replayDelays, replayPause } from './useDemoStream';

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
}

/** One playback clock. Live logs follow the tail; recordings expose their entire history. */
export function useRun(
  events: readonly HelixEvent[],
  {
    recorded = false,
    speed = 1,
    startAt = 0,
  }: { recorded?: boolean; speed?: number; startAt?: number } = {},
): RunView {
  const last = events.length - 1;
  const initial = {
    head: events[0],
    cursor: recorded ? Math.min(startAt, last) : null,
    playing: recorded && last > startAt,
  };
  const [stored, setControl] = useState(initial);
  // Switching recordings resets immediately; appending live events preserves the cursor.
  const control = stored.head === events[0] ? stored : initial;
  if (control !== stored) setControl(control);
  const index = control.cursor === null ? last : Math.max(0, Math.min(control.cursor, last));
  const current = events[index]!;
  const projector = useMemo(() => createProjector(events), [events]);
  const bySeq = useMemo(() => new Map(events.map((e) => [e.seq, e])), [events]);
  const identities = useMemo(() => indexIdentities(events), [events]);
  const state = useMemo(
    () => withIdentityIndex(projector.at(current.seq), identities),
    [projector, current.seq, identities],
  );
  const latestState = useMemo(
    () => withIdentityIndex(projector.at(events[last]!.seq), identities),
    [projector, events, last, identities],
  );
  const delays = useMemo(() => (recorded ? replayDelays(events) : []), [events, recorded]);
  const delay = (recorded ? (delays[index] ?? 650) : replayPause(current)) / speed;
  const lastRef = useRef(last);
  lastRef.current = last;

  const seek = useCallback(
    (i: number) => {
      const cursor = Math.max(0, Math.min(i, last));
      setControl((c) => (c.cursor === cursor && !c.playing ? c : { ...c, cursor, playing: false }));
    },
    [last],
  );
  const step = useCallback((delta: number) => seek(index + delta), [seek, index]);
  const goLive = useCallback(() => {
    setControl((c) => ({ ...c, cursor: null, playing: false }));
  }, []);

  useEffect(() => {
    if (!control.playing) return;
    const timer = window.setTimeout(() => {
      setControl((c) => {
        if (!c.playing || c.head !== control.head) return c;
        const next = Math.min(index + 1, lastRef.current);
        return { ...c, cursor: next, playing: next < lastRef.current };
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [control.playing, control.head, index, delay]);

  const togglePlay = useCallback(() => {
    setControl((c) =>
      c.playing
        ? { ...c, cursor: index, playing: false }
        : { ...c, cursor: index >= last ? 0 : index, playing: last > 0 },
    );
  }, [index, last]);

  return {
    events,
    state,
    latestState,
    current,
    index,
    isLive: control.cursor === null,
    seek,
    step,
    goLive,
    playing: control.playing,
    togglePlay,
    bySeq,
  };
}
