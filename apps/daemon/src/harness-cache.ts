import type { AgentHarness, HarnessInfo } from '@helix/contracts';

/** Single-flight, stale-while-revalidate detection. Failures preserve the last good snapshot. */
export function cacheHarnessDetection(
  harnesses: Record<string, AgentHarness>,
  log: (message: string, error?: unknown) => void,
  ttlMs = 60_000,
): () => Promise<HarnessInfo[]> {
  let snapshot: HarnessInfo[] | undefined;
  let expires = 0;
  let pending: Promise<HarnessInfo[]> | undefined;
  function refresh(): Promise<HarnessInfo[]> {
    pending ??= Promise.all(Object.values(harnesses).map((h) => h.detect()))
      .then((result) => {
        snapshot = structuredClone(result);
        expires = Date.now() + ttlMs;
        return result;
      })
      .catch((error: unknown) => {
        expires = Date.now() + ttlMs;
        log('Harness detection refresh failed', error);
        throw error;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  return async () => {
    if (!snapshot) return structuredClone(await refresh());
    if (Date.now() >= expires) void refresh().catch(() => undefined);
    return structuredClone(snapshot);
  };
}
