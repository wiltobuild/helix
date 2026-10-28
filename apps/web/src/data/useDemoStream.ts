import { useEffect, useMemo, useState } from 'react';
import { fixtures, type HelixEvent } from '@helix/contracts';

/**
 * Demo mode: streams a recorded run as if it were live, so the app works with nothing installed.
 * Starts a few events in and reveals the rest on a timer. Switching to another run (a loaded
 * recording) restarts the reveal from that run's own starting point.
 */
export function useDemoStream(
  run: readonly HelixEvent[] = fixtures.passwordResetRun,
  { startAt = 9, intervalMs = 1600 }: { startAt?: number; intervalMs?: number } = {},
): readonly HelixEvent[] {
  const [state, setState] = useState({ run, count: Math.min(startAt, run.length) });
  // A new run resets the reveal during render, so no frame shows the old run's count.
  const current = state.run === run ? state : { run, count: Math.min(startAt, run.length) };
  if (current !== state) setState(current);

  useEffect(() => {
    if (current.count >= run.length) return;
    const id = window.setTimeout(
      () => setState((s) => (s.run === run ? { run, count: s.count + 1 } : s)),
      intervalMs,
    );
    return () => window.clearTimeout(id);
  }, [current.count, run, intervalMs]);

  return useMemo(() => run.slice(0, current.count), [run, current.count]);
}
