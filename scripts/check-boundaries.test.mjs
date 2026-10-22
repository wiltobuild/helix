import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { checkBoundaries } from './check-boundaries.mjs';

const tsconfig = readFileSync(new URL('../tsconfig.base.json', import.meta.url), 'utf8');

async function fixture(source, additions = {}, sourcePath = 'packages/core/src/probe.ts') {
  const previous = process.cwd();
  const root = mkdtempSync(resolve(tmpdir(), 'helix-boundaries-'));
  const write = (path, text) => {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const alias = {};
  try {
    write('package.json', JSON.stringify({ private: true, type: 'module' }));
    write('tsconfig.base.json', tsconfig);
    for (const name of ['contracts', 'storage', 'testing', 'core', 'ui', 'daemon', 'web']) {
      const path = `${['daemon', 'web'].includes(name) ? 'apps' : 'packages'}/${name}`;
      const exports = { '.': './src/index.ts' };
      if (name === 'ui') exports['./styles.css'] = './src/styles.css';
      write(
        `${path}/package.json`,
        JSON.stringify({ name: `@helix/${name}`, type: 'module', exports }),
      );
      write(`${path}/src/index.ts`, 'export const value = 1;\n');
      for (const [entry, target] of Object.entries(exports)) {
        const specifier = `@helix/${name}${entry === '.' ? '' : entry.slice(1)}`;
        // Resolve exactly the declared entry, never a deep import. Avoid platform-specific links.
        alias[`${specifier}$`] = resolve(root, path, target);
      }
    }
    write('packages/ui/src/styles.css', ':root { color: red; }\n');
    write(sourcePath, source);
    for (const [path, text] of Object.entries(additions)) write(path, text);
    process.chdir(root);
    return await checkBoundaries({ alias });
  } finally {
    process.chdir(previous);
    // Only delete the unique fixture directory created by this invocation.
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('helix-boundaries-'));
    rmSync(root, { recursive: true, force: true });
  }
}

const rejects = async (code, rule, additions, path) => {
  const { violations } = await fixture(code, additions, path);
  assert.ok(
    violations.some((violation) => violation.startsWith(`${rule}:`)),
    violations.join('\n'),
  );
};

test('allowed package entry import', async () => {
  assert.deepEqual((await fixture("import '@helix/storage';\n")).violations, []);
});
test('deep import is rejected', async () => {
  await rejects("import '@helix/storage/src/index';\n", 'workspace-entry-points-only');
});
test('resolved forbidden edge is rejected', async () => {
  await rejects(
    "import '@helix/storage';\n",
    'contracts-production-dependencies',
    {},
    'packages/contracts/src/probe.ts',
  );
});
test('relative root bridge is rejected', async () => {
  await rejects(
    "export * from '../../../bridge.js';\n",
    'workspace-relative-import-escape',
    {
      'bridge.ts': "export * from '@helix/storage';\n",
    },
    'packages/contracts/src/probe.ts',
  );
});
test('wrong-case workspace root is rejected on every platform', async () => {
  await rejects(
    "import '../../../Packages/storage/src/index.js';\n",
    'non-canonical-workspace-path',
    {},
    'packages/contracts/src/probe.ts',
  );
});
test('wrong-case package directory is rejected on every platform', async () => {
  await rejects("import '../../Storage/src/index.js';\n", 'non-canonical-workspace-path');
});
test('computed dynamic import is rejected', async () => {
  await rejects(
    "const path = '../../storage/src/index.js';\nexport const loaded = import(path);\n",
    'computed-dynamic-import',
  );
});
test('interpolated dynamic import is rejected', async () => {
  await rejects(
    'const name = "storage";\nexport const loaded = import(`@helix/${name}`);\n',
    'computed-dynamic-import',
  );
});
test('literal dynamic import is inspected and allowed', async () => {
  assert.deepEqual(
    (await fixture("export const loaded = import('@helix/storage');\n")).violations,
    [],
  );
});
test('dynamic import exception requires a reason on the immediately preceding statement line', async () => {
  const code =
    "const name = 'external-plugin';\n// helix-boundaries-allow-dynamic-import: user-selected external plugin loader\nexport const loaded = import(name);\n";
  assert.deepEqual((await fixture(code)).violations, []);
  await rejects(
    code.replace(': user-selected external plugin loader', ':'),
    'computed-dynamic-import',
  );
  await rejects(code.replace('\nexport const', '\n\nexport const'), 'computed-dynamic-import');
});
test('exception does not authorize another statement', async () => {
  await rejects(
    "const name = 'external-plugin';\n// helix-boundaries-allow-dynamic-import: external plugin\nexport const first = import(name);\nexport const second = import(name);\n",
    'computed-dynamic-import',
  );
});
test('declared CSS entry point remains allowed', async () => {
  assert.deepEqual(
    (await fixture("import '@helix/ui/styles.css';\n", {}, 'apps/web/src/probe.ts')).violations,
    [],
  );
});
test('undeclared CSS entry point is rejected', async () => {
  await rejects(
    "import '@helix/ui/private.css';\n",
    'workspace-entry-points-only',
    {},
    'apps/web/src/probe.ts',
  );
});
test('CSS entry point still obeys dependency direction', async () => {
  await rejects(
    "import '@helix/ui/styles.css';\n",
    'contracts-production-dependencies',
    {},
    'packages/contracts/src/probe.ts',
  );
});
test('test file outside src is rejected', async () => {
  await rejects('', 'tests-must-be-under-src', { 'packages/core/probe.spec.ts': '' });
});
test('test directories outside src are rejected even without a test-named file', async () => {
  for (const directory of ['test', 'tests', '__tests__']) {
    await rejects('', 'tests-must-be-under-src', { [`packages/core/${directory}/fixture.ts`]: '' });
  }
});
test('tests under src can import testing', async () => {
  assert.deepEqual(
    (await fixture("import '@helix/testing';\n", {}, 'packages/core/src/tests/probe.test.ts'))
      .violations,
    [],
  );
});
test('daemon production cannot import testing', async () => {
  await rejects(
    "import '@helix/testing';\n",
    'daemon-production-dependencies',
    {},
    'apps/daemon/src/probe.ts',
  );
});
test('daemon tests can import testing', async () => {
  assert.deepEqual(
    (await fixture("import '@helix/testing';\n", {}, 'apps/daemon/src/probe.test.ts')).violations,
    [],
  );
});
