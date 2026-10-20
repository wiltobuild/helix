import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const packages = [
  'packages/contracts',
  'packages/testing',
  'packages/storage',
  'packages/core',
  'packages/harness',
  'packages/pty-host',
  'packages/git',
  'packages/scm',
  'packages/api-client',
  'apps/daemon',
  'apps/cli',
];

export default defineConfig({
  test: {
    projects: packages.map((path) => ({
      test: {
        name: `@helix/${path.split('/')[1]}`,
        root: resolve(import.meta.dirname, path),
        environment: 'node',
        include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
      },
    })),
  },
});
