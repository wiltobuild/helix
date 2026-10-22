import { expect, test } from 'vitest';

import { PACKAGE_NAME } from './index.js';

test('identifies @helix/storage', () => {
  expect(PACKAGE_NAME).toBe('@helix/storage');
});
