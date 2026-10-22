import { expect, test } from 'vitest';

import { HELIX_CONTRACTS_VERSION } from './index.js';

test('identifies contracts v1', () => {
  expect(HELIX_CONTRACTS_VERSION).toBe(1);
});
