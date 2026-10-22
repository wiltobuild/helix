import { expect, test, vi } from 'vitest';
import { HelixError, projectIdSchema, sessionIdSchema } from '@helix/contracts';
import { DirtyWorktreeError, GitWorktreeManager } from './index.js';
import { parseDiffFiles } from './diff.js';
import { requireGitVersion, serialize } from './git.js';

test.each(['git version 2.40.0', 'git version 2.55.0.windows.3\r\n', 'git version 3.0.0'])(
  'accepts %s',
  (version) => {
    expect(() => requireGitVersion(version)).not.toThrow();
  },
);
test.each(['git version 2.39.9', 'git version 1.99.0', '', 'unknown'])(
  'rejects unsupported version %s',
  (version) => {
    expect(() => requireGitVersion(version)).toThrow(HelixError);
  },
);
test('dirty-worktree errors implement the frozen error contract', () => {
  expect(new DirtyWorktreeError('path with spaces')).toMatchObject({
    code: 'DIRTY_WORKTREE',
    details: { path: 'path with spaces' },
  });
  expect(new DirtyWorktreeError('x')).toBeInstanceOf(HelixError);
});
test('parses renames, binary and unusual filenames without line splitting', () => {
  const raw =
    ':100644 100644 abc def R100\0old\tfile\0new\nfile\0:000000 100644 000 def A\0image.bin\0:100644 000000 abc 000 D\0gone\0';
  expect(
    parseDiffFiles(raw, '0\t0\t\0old\tfile\0new\nfile\0-\t-\timage.bin\0' + '2\t4\tgone\0'),
  ).toEqual([
    {
      path: 'new\nfile',
      oldPath: 'old\tfile',
      status: 'renamed',
      insertions: 0,
      deletions: 0,
      binary: false,
    },
    { path: 'image.bin', status: 'added', insertions: 0, deletions: 0, binary: true },
    { path: 'gone', status: 'deleted', insertions: 2, deletions: 4, binary: false },
  ]);
});
test('serializes the same repository, allows different repositories, and releases after failure', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = serialize('repo', async () => {
    order.push('start');
    await gate;
    order.push('end');
    throw new Error('failure');
  });
  const rejected = expect(first).rejects.toThrow('failure');
  const second = serialize('repo', () => {
    order.push('second');
    return Promise.resolve();
  });
  await serialize('other', () => {
    order.push('other');
    return Promise.resolve();
  });
  expect(order).toEqual(['start', 'other']);
  release();
  await rejected;
  await second;
  expect(order).toEqual(['start', 'other', 'end', 'second']);
});
test('rejects unsafe paths and unknown projects before Git mutation', async () => {
  const runGit = vi.fn();
  const manager = new GitWorktreeManager({
    dataDir: '.',
    projects: { getProject: () => Promise.resolve(undefined) },
    runGit,
  });
  await expect(
    manager.create(projectIdSchema.parse('../escape'), sessionIdSchema.parse('session'), 'main'),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(
    manager.create(projectIdSchema.parse('project'), sessionIdSchema.parse('session'), 'main'),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(runGit).not.toHaveBeenCalled();
});
