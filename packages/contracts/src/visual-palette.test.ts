import { expect, test } from 'vitest';
import {
  visualDesignSchema,
  visualDesignRequestSchema,
  visualPaletteSchema,
} from './visual-design.js';

const palette = {
  name: 'Teal',
  background: '#F6F4EF',
  foreground: '#183430',
  primary: '#0E7672',
  accent: '#B64D31',
};

test('palette tokens accept only concrete six-digit hex colors', () => {
  expect(visualPaletteSchema.parse(palette)).toEqual(palette);
  expect(
    visualPaletteSchema.safeParse({ ...palette, primary: 'url(https://example.test)' }).success,
  ).toBe(false);
  expect(
    visualDesignRequestSchema.parse({
      requestId: 'r',
      revision: 1,
      action: 'regenerate',
      palette: null,
    }).palette,
  ).toBeNull();
});

test('legacy designs still parse and palette snapshots survive serialization', () => {
  const legacy = {
    sessionId: 'palette-test',
    revision: 1,
    brief: 'A website',
    status: 'ready',
    rounds: [{ revision: 1, jobId: 'job', concepts: [] }],
    conversation: [],
    references: [],
    receipts: [],
  };
  expect(visualDesignSchema.parse(legacy)).toEqual(legacy);
  const withPalette = {
    ...legacy,
    rounds: [{ ...legacy.rounds[0], palette }],
    decision: { revision: 1, conceptIds: ['one'], rationale: 'Approved', palette },
  };
  expect(visualDesignSchema.parse(JSON.parse(JSON.stringify(withPalette)))).toEqual(withPalette);
});
