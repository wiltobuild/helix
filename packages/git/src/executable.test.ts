import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { expect, test } from 'vitest';
import { trustedGit } from './executable.js';
import { runGit } from './git.js';

test('Git runner ignores executable shadows and relative PATH entries in a checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helix-git-shadow-'));
  try {
    for (const name of ['git', 'git.exe', 'git.com'])
      await writeFile(join(dir, name), 'Not an executable');
    const key = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
    const env = { ...process.env, [key]: ['', '.', dir, process.env[key]].join(delimiter) };
    const binary = await trustedGit(dir, env);
    expect(isAbsolute(binary)).toBe(true);
    expect(binary.startsWith(dir)).toBe(false);
    expect((await runGit(dir, ['--version'])).stdout).toMatch(/^git version /);
    await expect(trustedGit(dir, { PATH: ['', '.', dir].join(delimiter) })).rejects.toThrow(
      'Native Git',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
