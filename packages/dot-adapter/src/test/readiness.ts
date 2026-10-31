/** Test lifecycle budget: startup and the measured operation are separate phases. */
export async function withReadyDeadline<T>(
  ready: Promise<T>,
  operation: (value: T) => Promise<void>,
  expired: () => void,
  timeoutMs: number,
): Promise<void> {
  const value = await ready;
  const deadline = setTimeout(expired, timeoutMs);
  try {
    await operation(value);
  } finally {
    clearTimeout(deadline);
  }
}
