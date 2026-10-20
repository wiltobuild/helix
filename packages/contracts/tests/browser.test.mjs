import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as contracts from '../src/index.js';

it('loads the public entry and imports only browser-safe local modules or Zod', () => {
  expect(contracts.fixtures.passwordResetRun).toHaveLength(44);
  const root = new URL('../src/', import.meta.url);
  for (const path of readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.ts'))) {
    const source = readFileSync(new URL(path.replaceAll('\\', '/'), root), 'utf8');
    expect(source, path).not.toMatch(/\b(?:require\s*\(|process\.|Buffer\b|Date\.now\(|Math\.random\()/);
    expect(source, path).not.toMatch(/\bany\b/);
    const imports = [...source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)].map((m) => m[2]);
    for (const specifier of imports) expect(specifier === 'zod' || /^\.\.?\/.+\.js$/.test(specifier), `${path}: ${specifier}`).toBe(true);
    expect(source, path).not.toMatch(/['"]node:/);
  }
});
