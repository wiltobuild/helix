import { expect, test, vi } from 'vitest';
import { fixtures, sessionIdSchema, type HelixEvent } from '@helix/contracts';
import { reload } from './reload.js';

test('reload skips malformed payloads and references, counts beyond the retained anomaly window', () => {
  const genesis = fixtures.passwordResetRun[0]!;
  const log = { error: vi.fn() };
  const bad = Array.from({ length: 105 }, (_, i) => ({
    ...genesis,
    seq: i + 2,
    type: 'feedback.routed',
    payload: {
      prNumber: 1,
      reason: 'ci_failed',
      summary: 'secret prompt',
      toSessionId: sessionIdSchema.parse('missing'),
    },
  })) as HelixEvent[];
  bad.push({ ...genesis, seq: 107, type: 'chat.item', payload: {} } as HelixEvent);
  const recovered = reload([genesis, ...bad], log);
  expect(recovered.events).toEqual([genesis]);
  expect(recovered.state?.lastSeq).toBe(107);
  expect(log.error).toHaveBeenCalledOnce();
  expect(log.error.mock.calls[0]?.[0]).toContain('106 anomalous events');
  expect(log.error.mock.calls[0]?.[0]).not.toContain('secret prompt');
});
