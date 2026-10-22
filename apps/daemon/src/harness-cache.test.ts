import { afterEach, expect, test, vi } from 'vitest';
import type { AgentHarness, HarnessInfo } from '@helix/contracts';
import { cacheHarnessDetection } from './harness-cache.js';

afterEach(() => vi.useRealTimers());
test('coalesces first detection, caches for 60s, refreshes stale values in the background', async () => {
  vi.useFakeTimers();
  const first = Promise.withResolvers<HarnessInfo>();
  const next = Promise.withResolvers<HarnessInfo>();
  const detect = vi
    .fn<AgentHarness['detect']>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(next.promise);
  const read = cacheHarnessDetection({ codex: { kind: 'codex', detect, start: vi.fn() } }, vi.fn());
  const a = read();
  const b = read();
  expect(detect).toHaveBeenCalledOnce();
  first.resolve({ agent: 'codex', installed: true, signedIn: true });
  expect(await a).toEqual(await b);
  await vi.advanceTimersByTimeAsync(59_999);
  await read();
  expect(detect).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  const stale = await read();
  await read();
  expect(stale[0]?.signedIn).toBe(true);
  expect(detect).toHaveBeenCalledTimes(2);
  stale[0]!.signedIn = false;
  expect((await read())[0]?.signedIn).toBe(true);
  next.resolve({ agent: 'codex', installed: true, signedIn: false });
  await vi.advanceTimersByTimeAsync(0);
  expect((await read())[0]?.signedIn).toBe(false);
});
test('refresh failures are logged and preserve the prior result without a retry storm', async () => {
  vi.useFakeTimers();
  const log = vi.fn();
  const detect = vi
    .fn<AgentHarness['detect']>()
    .mockResolvedValueOnce({ agent: 'codex', installed: true, signedIn: true })
    .mockRejectedValue(new Error('probe failed'));
  const read = cacheHarnessDetection({ codex: { kind: 'codex', detect, start: vi.fn() } }, log);
  await read();
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await read())[0]?.signedIn).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  await read();
  expect(detect).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledOnce();
});
