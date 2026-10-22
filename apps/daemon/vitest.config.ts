import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Cold filesystem/plugin initialization on Windows can exceed Vitest's 5s default.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
