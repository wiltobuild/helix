import { expect, test } from 'vitest';

import { PACKAGE_NAME } from './index.js';

test('identifies @helix/git', () => {
  expect(PACKAGE_NAME).toBe('@helix/git');
});
