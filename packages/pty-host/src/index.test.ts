import { expect, test } from 'vitest';

import { PACKAGE_NAME } from './index.js';

test('identifies @helix/pty-host', () => {
  expect(PACKAGE_NAME).toBe('@helix/pty-host');
});
