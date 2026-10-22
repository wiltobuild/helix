import { expect, test, vi } from 'vitest';
import { GitWorktreeManager } from './index.js';
import type { GitResult, GitRunner } from './git.js';

function fakeGit(origin = true) {
  return vi.fn<GitRunner>((_cwd, args) => {
    let stdout = '';
    if (args[0] === '--version') stdout = 'git version 2.50.0\r\n';
    if (args.includes('--git-common-dir')) stdout = process.cwd();
    if (args[0] === 'config')
      return Promise.resolve({
        stdout: origin ? 'remote\r\n' : '',
        stderr: '',
        code: origin ? 0 : 1,
      });
    if (args.includes('--verify')) stdout = 'abcdef123\r\n';
    return Promise.resolve({ stdout, stderr: '', code: 0 });
  });
}
function manager(runGit: GitRunner, onBaseFallback = vi.fn()) {
  return new GitWorktreeManager({
    dataDir: '.',
    projects: { getProject: () => Promise.resolve(undefined) },
    runGit,
    onBaseFallback,
  });
}
test('fetches the explicit origin branch without prompts and returns its remote tracking SHA', async () => {
  const run = fakeGit();
  expect(await manager(run).fetchBase('repo', 'feature/base')).toBe('abcdef123');
  expect(run).toHaveBeenCalledWith(
    'repo',
    ['fetch', '--no-tags', 'origin', '+refs/heads/feature/base:refs/remotes/origin/feature/base'],
    expect.objectContaining({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }),
  );
  expect(run).toHaveBeenCalledWith(
    'repo',
    ['rev-parse', '--verify', 'refs/remotes/origin/feature/base^{commit}'],
    undefined,
  );
  expect(
    run.mock.calls.some(([, args]) => ['reset', 'checkout', 'switch'].includes(args[0]!)),
  ).toBe(false);
});
test('no-origin fallback reports its typed source, branch, repository, and SHA', async () => {
  const run = fakeGit(false);
  const onBaseFallback = vi.fn();
  expect(await manager(run, onBaseFallback).fetchBase('repo', 'main')).toBe('abcdef123');
  expect(onBaseFallback).toHaveBeenCalledExactlyOnceWith({
    source: 'local',
    repoPath: 'repo',
    branch: 'main',
    sha: 'abcdef123',
    reason: 'no-origin',
  });
  expect(run.mock.calls.some(([, args]) => args[0] === 'fetch')).toBe(false);
});
test('failed fetch surfaces context and stderr as HelixError without using a stale SHA', async () => {
  const base = fakeGit();
  const run = vi.fn<GitRunner>(async (...args) =>
    args[1][0] === 'fetch'
      ? { code: 128, stdout: '', stderr: 'remote unavailable\r\n' }
      : base(...args),
  );
  await expect(manager(run).fetchBase('repo', 'main')).rejects.toMatchObject({
    code: 'INTERNAL_ERROR',
    message: expect.stringContaining('Unable to fetch base branch "main"') as unknown,
    details: { git: { stderr: 'remote unavailable' } },
  });
  expect(run.mock.calls.some(([, args]) => args.includes('--verify'))).toBe(false);
});
test('fetch holds the shared repository lock across manager instances until SHA resolution', async () => {
  const base = fakeGit();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const fetching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const order: string[] = [];
  const run: GitRunner = async (...args): Promise<GitResult> => {
    if (args[1][0] === 'fetch') {
      order.push('fetch');
      entered();
      await gate;
    }
    if (args[1].includes('--verify')) order.push('sha');
    return base(...args);
  };
  const first = manager(run).fetchBase('repo', 'main');
  await fetching;
  const second = manager(run).fetchBase('repo', 'main');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(order).toEqual(['fetch']);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(['fetch', 'sha', 'fetch', 'sha']);
});
