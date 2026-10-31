import { expect, test } from 'vitest';
import { sessionIdSchema } from '@helix/contracts';
import {
  newVisualDesign,
  changeVisualDesign,
  completeVisualRound,
  approvedVisualContext,
  visualPrompts,
} from './visual-design.js';

const palette = {
  name: 'Teal & rust',
  background: '#F6F4EF',
  foreground: '#183430',
  primary: '#0E7672',
  accent: '#B64D31',
};
const concepts = [1, 2, 3].map((n) => ({
  id: `concept-${n}`,
  title: `Concept ${n}`,
  imageUrl: `https://example.test/${n}.png`,
  mimeType: 'image/png' as const,
  prompt: 'test',
  rationale: 'test',
  tradeoffs: [],
  recommended: n === 1,
}));
const initial = () =>
  completeVisualRound(
    newVisualDesign(sessionIdSchema.parse('palette-test'), 'A website', true),
    concepts,
  );

test('palette regeneration invalidates approval, preserves previous snapshots and binds downstream context', () => {
  const approved = changeVisualDesign(
    initial(),
    {
      requestId: 'approve-old',
      revision: 1,
      action: 'approve',
      text: 'Keep this',
      conceptIds: ['concept-1'],
    },
    true,
  );
  const request = { requestId: 'palette', revision: 2, action: 'regenerate' as const, palette };
  const pending = changeVisualDesign(approved, request, true);
  expect(pending.decision).toBeUndefined();
  expect(approved.decision).toBeDefined();
  expect(pending.rounds[0]?.palette).toBeUndefined();
  expect(pending.rounds[1]?.palette).toEqual(palette);
  expect(changeVisualDesign(pending, request, true)).toBe(pending);
  expect(approvedVisualContext(pending)).toBe('');
  expect(visualPrompts(pending).every((prompt) => prompt.includes(palette.primary))).toBe(true);
  expect(() =>
    changeVisualDesign(
      pending,
      {
        requestId: 'stale',
        revision: 2,
        action: 'approve',
        text: 'Old',
        conceptIds: ['concept-1'],
      },
      true,
    ),
  ).toThrow(/revision/);
  const ready = completeVisualRound(pending, concepts);
  const next = changeVisualDesign(
    ready,
    {
      requestId: 'approve-new',
      revision: 3,
      action: 'approve',
      text: 'Approve rendered palette',
      conceptIds: ['concept-1'],
    },
    true,
  );
  expect(next.decision?.palette).toEqual(palette);
  expect(approvedVisualContext(next)).toContain(palette.primary);
  const reset = changeVisualDesign(
    next,
    { requestId: 'reset', revision: 4, action: 'regenerate', palette: null },
    true,
  );
  expect(reset.rounds.at(-1)?.palette).toBeUndefined();
  expect(reset.rounds[1]?.palette).toEqual(palette);
  expect(next.decision?.palette).toEqual(palette);
});

test('cancel, retry and unavailable generation preserve requested palette without approving', () => {
  const pending = changeVisualDesign(
    initial(),
    { requestId: 'palette', revision: 1, action: 'regenerate', palette },
    true,
  );
  const cancelled = changeVisualDesign(
    pending,
    { requestId: 'cancel', revision: 2, action: 'cancel' },
    true,
  );
  const retried = changeVisualDesign(
    cancelled,
    { requestId: 'retry', revision: 3, action: 'retry' },
    false,
  );
  expect(retried.status).toBe('unavailable');
  expect(retried.rounds.at(-1)?.palette).toEqual(palette);
  expect(approvedVisualContext(retried)).toBe('');
});

test('palette cannot be silently attached to approval or feedback', () => {
  for (const action of ['approve', 'comment'] as const) {
    expect(() =>
      changeVisualDesign(
        initial(),
        {
          requestId: action,
          revision: 1,
          action,
          palette,
          text: 'Change palette',
          conceptIds: ['concept-1'],
        },
        true,
      ),
    ).toThrow(/new render/);
  }
});
