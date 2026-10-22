import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TestProjectConfiguration } from 'vitest/config';

export const nodeTestDefaults = {
  environment: 'node' as const,
  include: ['src/**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'],
};

export function discoverTestProjects(repository: string): TestProjectConfiguration[] {
  return ['packages', 'apps'].flatMap((base) => {
    const directory = resolve(repository, base);
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(resolve(directory, entry.name, 'package.json')),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const root = resolve(directory, entry.name);
        const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
          name: string;
        };
        const localConfig = resolve(root, 'vitest.config.ts');
        return {
          // Loading the file through Vitest preserves config factories, plugins, and setup files.
          root,
          ...(existsSync(localConfig) ? { extends: localConfig } : {}),
          test: {
            ...(existsSync(localConfig) ? {} : nodeTestDefaults),
            name: manifest.name,
            root,
          },
        };
      });
  });
}
