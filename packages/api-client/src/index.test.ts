import { expect, test } from 'vitest';

import { PACKAGE_NAME } from './index.js';

test('identifies @helix/api-client', () => {
  expect(PACKAGE_NAME).toBe('@helix/api-client');
});
