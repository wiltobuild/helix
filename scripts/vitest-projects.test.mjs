import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { createVitest } from 'vitest/node';
import { discoverTestProjects, nodeTestDefaults } from '../vitest.shared.ts';

test('workspace Vitest config overrides shared defaults without root edits', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-vitest-'));
  let context;
  try {
    for (const name of ['fallback', 'custom']) {
      const directory = resolve(root, 'packages', name);
      mkdirSync(resolve(directory, 'src'), { recursive: true });
      writeFileSync(
        resolve(directory, 'package.json'),
        JSON.stringify({ name: `@helix/${name}`, type: 'module' }),
      );
    }
    writeFileSync(
      resolve(root, 'packages/custom/vitest.config.ts'),
      `export default {
      test: {
        environment: 'jsdom',
        setupFiles: ['./src/setup.ts'],
        testTimeout: 4321,
        maxWorkers: 1,
      },
    };\n`,
    );
    writeFileSync(resolve(root, 'packages/custom/src/setup.ts'), 'export {};\n');
    context = await createVitest('test', {
      root,
      config: false,
      watch: false,
      ...nodeTestDefaults,
      projects: discoverTestProjects(root),
    });
    const fallback = context.projects.find((project) => project.name === '@helix/fallback');
    const custom = context.projects.find((project) => project.name === '@helix/custom');
    assert.ok(fallback);
    assert.ok(custom);
    assert.equal(fallback.config.environment, 'node');
    assert.deepEqual(fallback.config.include, nodeTestDefaults.include);
    assert.equal(custom.config.environment, 'jsdom');
    assert.equal(custom.config.testTimeout, 4321);
    assert.equal(custom.config.maxWorkers, 1);
    assert.equal(
      custom.config.setupFiles[0].replaceAll('\\', '/'),
      // Vitest reports the real long path; tmpdir() can be an 8.3 short name (RUNNER~1) on Windows.
      realpathSync.native(resolve(root, 'packages/custom/src/setup.ts')).replaceAll('\\', '/'),
    );
  } finally {
    await context?.close();
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('helix-vitest-'));
    rmSync(root, { recursive: true, force: true });
  }
});
