import { expect, test } from 'vitest';

import { PACKAGE_NAME } from './index.js';

test('identifies @helix/cli', () => {
  expect(PACKAGE_NAME).toBe('@helix/cli');
});
