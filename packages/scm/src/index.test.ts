import { expect, test } from 'vitest';

import { PACKAGE_NAME } from './index.js';

test('identifies @helix/scm', () => {
  expect(PACKAGE_NAME).toBe('@helix/scm');
});
