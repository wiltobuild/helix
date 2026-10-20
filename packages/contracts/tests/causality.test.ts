import { expect, it } from 'vitest';
import { eventSeqSchema, fixtures, planNodeIdSchema, projectUpTo, rationaleFor, whyChain, type HelixEvent } from '../src/index.js';

const run = fixtures.passwordResetRun;
it('follows the repair through routed feedback, CI, PR and original plan', () => {
  const chain = whyChain(run, 24);
  expect(chain.map((e) => Number(e.seq))).toEqual([24, 23, 22, 20, 19, 16, 14, 12, 10, 7, 6, 5, 4, 3, 2, 1]);
  expect(chain.slice(0, 4).map((e) => e.type)).toEqual(['activity.changed', 'feedback.routed', 'ci.updated', 'pr.opened']);
  expect(chain.some((e) => e.type === 'plan.submitted')).toBe(true);
});
it('stops at missing causes and absent target', () => {
  expect(whyChain([], 1)).toEqual([]);
  expect(whyChain(run.slice(20), 24).map((e) => Number(e.seq))).toEqual([24, 23, 22]);
});
it('is cycle-safe including self-loops', () => {
  const events: HelixEvent[] = [{ ...run[0]!, causedBy: eventSeqSchema.parse(2) }, { ...run[1]!, causedBy: eventSeqSchema.parse(1) }];
  expect(whyChain(events, 2).map((e) => Number(e.seq))).toEqual([2, 1]);
  expect(whyChain([{ ...run[0]!, causedBy: eventSeqSchema.parse(1) }], 1)).toHaveLength(1);
});
it('caps chains at 50 events', () => {
  const events: HelixEvent[] = Array.from({ length: 60 }, (_, i) => ({ ...run[0]!, seq: eventSeqSchema.parse(i + 1), ...(i ? { causedBy: eventSeqSchema.parse(i) } : {}) }));
  const chain = whyChain(events, 60);
  expect(chain).toHaveLength(50);
  expect(chain.at(-1)!.seq).toBe(11);
});
it('finds plan rationale without inventing missing reasoning', () => {
  const s = projectUpTo(run, 44);
  expect(rationaleFor(s, fixtures.passwordResetIds.e2eNode)).toBe(fixtures.passwordResetPlan.nodes[2]!.rationale);
  expect(rationaleFor(s, planNodeIdSchema.parse('missing'))).toBeUndefined();
});
