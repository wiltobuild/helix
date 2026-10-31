import { expect, test, vi } from 'vitest';
import { withReadyDeadline } from './test/readiness.js';

test('delayed readiness does not consume the operation deadline', async () => {
  vi.useFakeTimers();
  const ready = Promise.withResolvers<string>();
  const finished = Promise.withResolvers<void>();
  const operation = vi.fn(() => finished.promise);
  const expired = vi.fn();
  const pending = withReadyDeadline(ready.promise, operation, expired, 10000);
  try {
    await vi.advanceTimersByTimeAsync(20000);
    expect(operation).not.toHaveBeenCalled();
    expect(expired).not.toHaveBeenCalled();
    ready.resolve('handshake-complete');
    await vi.advanceTimersByTimeAsync(9999);
    expect(operation).toHaveBeenCalledWith('handshake-complete');
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expired).toHaveBeenCalledTimes(1);
    finished.resolve();
    await pending;
  } finally {
    ready.resolve('cleanup');
    finished.resolve();
    await pending;
    vi.useRealTimers();
  }
});
