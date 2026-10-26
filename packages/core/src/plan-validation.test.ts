import { expect, test } from 'vitest';
import { globsMayOverlap } from './index.js';

test.each([
  ['src/shared/**', 'src/shared/types.ts', true],
  ['src/**', 'src', true],
  ['**', 'src/a/b.ts', true],
  ['src/**/types.ts', 'src/types.ts', true],
  ['src/**/types.ts', 'src/a/b/types.ts', true],
  ['src/**/types.ts', 'src/a/b/other.ts', false],
  ['src/**/a', 'src/**/b', false],
  ['src/**/a', 'src/b/**', true],
  ['**/**/a', 'a', true],
  ['src/**/a/**', 'src/b/**/c', true],
  ['src/api/**', 'src/ui/**', false],
  ['SRC/Shared/Types.ts', 'src/shared/types.TS', true],
  ['src/a.ts', 'src/a.ts/child', false],
  ['src/*', 'src/a/b', false],
  ['src/*', 'src/a', true],
  ['src/*.ts', 'src/plain.txt', true],
  ['src/?.ts', 'src/long-name.js', true],
  ['src/[ab].ts', 'src/c.ts', true],
  ['src/{a,b}.ts', 'src/c.ts', true],
  ['src/*/a', 'src/literal/b', false],
  ['a/b', 'x/b', false],
  ['**/a', 'b/**', true],
  ['a/**', 'a/b/**/c', true],
  ['a/**/b', 'a/*/c', false],
] as const)('glob intersection: %s and %s → %s', (a, b, expected) => {
  expect(globsMayOverlap(a, b)).toBe(expected);
  expect(globsMayOverlap(b, a)).toBe(expected);
});
