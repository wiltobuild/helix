import { useEffect, useMemo, useState } from 'react';
import { fixtures, type HelixEvent } from '@helix/contracts';

/**
 * Demo mode: streams a recorded run as if it were live, so the app works with nothing installed.
 * Starts a few events in (plan already submitted) and reveals the rest on a timer.
 */
export function useDemoStream(
  run: readonly HelixEvent[] = fixtures.passwordResetRun,
  { startAt = 9, intervalMs = 1600 }: { startAt?: number; intervalMs?: number } = {},
): readonly HelixEvent[] {
  const [count, setCount] = useState(Math.min(startAt, run.length));

  useEffect(() => {
    if (count >= run.length) return;
    const id = window.setTimeout(() => setCount((c) => c + 1), intervalMs);
    return () => window.clearTimeout(id);
  }, [count, run.length, intervalMs]);

  return useMemo(() => run.slice(0, count), [run, count]);
}
