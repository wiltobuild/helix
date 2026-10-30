import { expect, test } from 'vitest';
import { sessionIdSchema, type VisualConcept } from '@helix/contracts';
import {
  needsVisualDesign,
  newVisualDesign,
  changeVisualDesign,
  completeVisualRound,
} from './visual-design.js';
const concepts = (round = 1): VisualConcept[] =>
  [1, 2, 3].map((n) => ({
    id: `r${round}-${n}`,
    title: `Direction ${n}`,
    imageUrl: `https://example.test/render-${round}-${n}.png`,
    mimeType: 'image/png',
    prompt: 'A raster concept',
    rationale: 'Fits the brief',
    tradeoffs: ['More visual density'],
    recommended: n === 1,
  }));
const id = sessionIdSchema.parse('session-visual');
test('UI requests automatically trigger exploration, backend-only requests do not', () => {
  expect(needsVisualDesign('Build a storefront for a coffee shop')).toBe(true);
  expect(needsVisualDesign('Build a landing page')).toBe(true);
  expect(needsVisualDesign('Repair database migrations')).toBe(false);
});
test('reject all generates a fresh round, retains history and rejects stale choices', () => {
  const old = completeVisualRound(newVisualDesign(id, 'A storefront', true), concepts());
  const request = {
    requestId: 'reject-1',
    revision: 1,
    action: 'regenerate' as const,
    text: 'More editorial; reject all three',
    references: [{ url: 'https://example.test/reference.png' }],
  };
  const next = changeVisualDesign(old, request, true);
  expect(next.status).toBe('pending');
  expect(next.rounds).toHaveLength(2);
  expect(next.rounds[0]!.concepts).toHaveLength(3);
  expect(next.rounds[1]!.concepts).toHaveLength(0);
  expect(changeVisualDesign(next, request, true)).toBe(next);
  expect(() =>
    changeVisualDesign(
      next,
      {
        requestId: 'stale',
        revision: 1,
        action: 'approve',
        conceptIds: ['r1-1'],
        text: 'Choose it',
      },
      true,
    ),
  ).toThrow(/revision/);
  expect(() => changeVisualDesign(next, { ...request, text: 'different' }, true)).toThrow(/reused/);
});
test('combine with rationale, converse again, cancel and explicit retry', () => {
  const ready = completeVisualRound(newVisualDesign(id, 'A storefront', true), concepts());
  const approved = changeVisualDesign(
    ready,
    {
      requestId: 'choose',
      revision: 1,
      action: 'approve',
      conceptIds: ['r1-1', 'r1-3'],
      text: 'Combine first layout and third palette',
    },
    true,
  );
  expect(approved.decision?.conceptIds).toHaveLength(2);
  const commented = changeVisualDesign(
    approved,
    { requestId: 'comment', revision: 2, action: 'comment', text: 'Less saturated please' },
    true,
  );
  expect(commented.status).toBe('ready');
  expect(commented.decision).toBeUndefined();
  const cancelled = changeVisualDesign(
    commented,
    { requestId: 'cancel', revision: 3, action: 'cancel' },
    true,
  );
  expect(cancelled.status).toBe('cancelled');
  expect(
    changeVisualDesign(cancelled, { requestId: 'retry', revision: 4, action: 'retry' }, false)
      .status,
  ).toBe('unavailable');
});
test('provider output must have three distinct raster references', () => {
  const d = newVisualDesign(id, 'A storefront', true);
  expect(() => completeVisualRound(d, concepts().slice(0, 2))).toThrow();
  expect(() => completeVisualRound(d, [concepts()[0]!, concepts()[0]!, concepts()[0]!])).toThrow();
  expect(() =>
    completeVisualRound(
      d,
      concepts().map((c) => ({ ...c, imageUrl: 'javascript:alert(1)' })),
    ),
  ).toThrow();
});
