import { defineConfig } from 'vitest/config';
import { discoverTestProjects, nodeTestDefaults } from './vitest.shared.js';

export default defineConfig({
  test: {
    ...nodeTestDefaults,
    projects: discoverTestProjects(import.meta.dirname),
  },
});
