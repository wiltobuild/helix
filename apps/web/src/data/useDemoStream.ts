import { useEffect, useMemo, useState } from 'react';
import { fixtures, type HelixEvent } from '@helix/contracts';
import { eventTone } from './describe';

/** Replay speeds offered in demo mode. */
export const REPLAY_SPEEDS = [1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/**
 * How long an event stays on screen at 1× before the next one appears. Moments that tell the
 * story (plan, PRs, CI, merges) linger; tool calls and status flips pass quickly, so a real run's
 * hundreds of events replay in a couple of minutes.
 */
export function replayPause(e: HelixEvent): number {
  if (e.type === 'chat.item') return e.payload.item.kind === 'message' ? 1200 : 250;
  switch (eventTone(e)) {
    case 'quiet':
      return 200;
    case 'needs':
    case 'work':
      return 600;
    default:
      return 1600;
  }
}

/**
 * Demo mode: streams a recorded run as if it were live, so the app works with nothing installed.
 * Starts a few events in and reveals the rest on a timer. Switching to another run (a loaded
 * recording) restarts the reveal from that run's own starting point.
 */
export function useDemoStream(
  run: readonly HelixEvent[] = fixtures.passwordResetRun,
  { startAt = 9, speed = 1 }: { startAt?: number; speed?: number } = {},
): readonly HelixEvent[] {
  const [state, setState] = useState({ run, count: Math.min(startAt, run.length) });
  // A new run resets the reveal during render, so no frame shows the old run's count.
  const current = state.run === run ? state : { run, count: Math.min(startAt, run.length) };
  if (current !== state) setState(current);

  useEffect(() => {
    if (current.count >= run.length) return;
    // The event just revealed sets how long it stays on screen.
    const shown = run[current.count - 1];
    const id = window.setTimeout(
      () => setState((s) => (s.run === run ? { run, count: s.count + 1 } : s)),
      (shown ? replayPause(shown) : 1600) / speed,
    );
    return () => window.clearTimeout(id);
  }, [current.count, run, speed]);

  return useMemo(() => run.slice(0, current.count), [run, current.count]);
}
