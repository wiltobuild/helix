import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  diffResponseSchema,
  projectIdSchema,
  sessionIdSchema,
  type Project,
} from '@helix/contracts';
import { DirtyWorktreeError, GitWorktreeManager } from './index.js';

const execute = promisify(execFile);
const projectId = projectIdSchema.parse('project');
const session = sessionIdSchema.parse('session');
const git = async (cwd: string, ...args: string[]) =>
  (
    await execute('git', args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
    })
  ).stdout.trim();

describe.skipIf(process.env.HELIX_E2E !== '1')('real Git', () => {
  let root: string;
  let repo: string;
  let manager: GitWorktreeManager;
  let project: Project;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'helix git spaces '));
    repo = join(root, 'source repo');
    await mkdir(repo);
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.name', 'Helix Test');
    await git(repo, 'config', 'user.email', 'test@localhost');
    await git(repo, 'config', 'core.autocrlf', 'false');
    await git(repo, 'config', 'commit.gpgSign', 'false');
    await writeFile(join(repo, '.gitignore'), 'ignored\n');
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\nthree\n');
    await writeFile(join(repo, 'rename me.txt'), 'a unique file that will be renamed\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'initial');
    project = {
      id: projectId,
      name: 'Test',
      repoPath: repo,
      defaultBranch: 'main',
      defaultAgent: 'codex',
      createdAt: '2026-01-01T00:00:00Z',
    };
    manager = new GitWorktreeManager({
      dataDir: join(root, 'data dir'),
      projects: { getProject: () => Promise.resolve(project) },
    });
  }, 90_000);
  afterEach(async () => {
    const target = resolve(root);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  test('creates unique branches across manager instances and paths with spaces', async () => {
    const second = new GitWorktreeManager({
      dataDir: join(root, 'data dir'),
      projects: { getProject: () => Promise.resolve(project) },
    });
    const trees = await Promise.all([
      manager.create(projectId, session, '', { slug: 'Fix My Task!' }),
      second.create(projectId, sessionIdSchema.parse('second'), '', { slug: 'Fix My Task!' }),
    ]);
    expect(new Set(trees.map((tree) => tree.branch)).size).toBe(2);
    expect(trees[0].path).toBe(join(root, 'data dir', 'worktrees', 'project', 'session'));
    for (const tree of trees) {
      expect(tree.branch).toMatch(/^helix\/fix-my-task(?:-[a-f0-9]{8})?$/);
      expect(tree.baseSha).toBe(await manager.headSha(repo));
      expect(await manager.status(tree.path)).toEqual({ dirty: false });
    }
  }, 90_000);
  test('workspace includes staged, unstaged, renames, binary, untracked; preserves the real index', async () => {
    const tree = await manager.create(projectId, session, 'main');
    await writeFile(join(tree.path, 'tracked.txt'), 'one\nstaged\nthree\n');
    await git(tree.path, 'add', 'tracked.txt');
    const indexPath = await git(
      tree.path,
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index',
    );
    const before = await readFile(indexPath);
    await writeFile(join(tree.path, 'tracked.txt'), 'one\nstaged\nthree\nunstaged\n');
    await rename(join(tree.path, 'rename me.txt'), join(tree.path, 'renamed file.txt'));
    await writeFile(join(tree.path, 'untracked.txt'), 'new\nfile\n');
    await writeFile(join(tree.path, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(tree.path, 'ignored'), 'ignore this');
    const diff = diffResponseSchema.parse(await manager.diff(tree.path, 'workspace'));
    expect(diff.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'tracked.txt',
          status: 'modified',
          insertions: 2,
          deletions: 1,
        }),
        expect.objectContaining({
          path: 'renamed file.txt',
          oldPath: 'rename me.txt',
          status: 'renamed',
        }),
        expect.objectContaining({ path: 'untracked.txt', status: 'added', insertions: 2 }),
        expect.objectContaining({ path: 'image.bin', status: 'added', binary: true }),
      ]),
    );
    expect(diff.files).toHaveLength(4);
    expect(diff.unifiedDiff).toContain('+unstaged');
    expect(await readFile(indexPath)).toEqual(before);
    expect(await manager.status(tree.path)).toEqual({ dirty: true });
    await expect(manager.remove(tree.path, { force: false })).rejects.toBeInstanceOf(
      DirtyWorktreeError,
    );
  }, 90_000);
  test('PR uses merge-base and only committed work; last turn snapshots uncommitted work across restarts', async () => {
    const tree = await manager.create(projectId, session, 'main');
    await writeFile(join(tree.path, 'committed'), 'commit\n');
    const commit = await manager.commitAll(tree.path, 'change');
    expect(commit).toBe(await manager.headSha(tree.path));
    expect(await manager.commitsAhead(tree.path, 'main')).toBe(1);
    await writeFile(join(repo, 'base-moved'), 'base\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'base advances');
    await writeFile(join(tree.path, 'pending'), 'before\n');
    await manager.markTurn(tree.path, session);
    expect(await manager.headSha(tree.path)).toBe(commit);
    expect((await manager.diff(tree.path, 'last_turn')).files).toEqual([]);
    await writeFile(join(tree.path, 'pending'), 'after\n');
    const restarted = new GitWorktreeManager({
      dataDir: root,
      projects: { getProject: () => Promise.resolve(project) },
    });
    const turn = await restarted.diff(tree.path, 'last_turn');
    expect(turn.files).toEqual([
      expect.objectContaining({ path: 'pending', status: 'modified', insertions: 1, deletions: 1 }),
    ]);
    expect(turn.unifiedDiff).toContain('-before');
    const pr = await manager.diff(tree.path, 'pr');
    expect(pr.files.map((file) => file.path)).toEqual(['committed']);
    const workspace = await manager.diff(tree.path, 'workspace');
    expect(workspace.files.map((file) => file.path)).toEqual(['committed', 'pending']);
  }, 90_000);
  test.each(['untracked', 'staged', 'tracked'])(
    'refuses %s dirt and keeps files intact',
    async (kind) => {
      const tree = await manager.create(projectId, session, 'main');
      const name = kind === 'untracked' ? 'new-file' : 'tracked.txt';
      await writeFile(join(tree.path, name), 'dirty\n');
      if (kind === 'staged') await git(tree.path, 'add', name);
      await expect(manager.remove(tree.path, { force: false })).rejects.toMatchObject({
        code: 'DIRTY_WORKTREE',
      });
      expect(await readFile(join(tree.path, name), 'utf8')).toBe('dirty\n');
    },
    90_000,
  );
  test('removes clean worktree, retains branch, and implements helpers with a local remote', async () => {
    expect(await manager.isGitRepo(repo)).toBe(true);
    expect(await manager.isGitRepo(root)).toBe(false);
    expect(await manager.defaultBranch(repo)).toBe('main');
    expect(await manager.remoteUrl(repo)).toBeUndefined();
    const tree = await manager.create(projectId, session, 'main');
    expect(await manager.commitAll(tree.path, 'nothing')).toBeUndefined();
    const remote = join(root, 'bare remote');
    await mkdir(remote);
    await git(remote, 'init', '--bare');
    await git(repo, 'remote', 'add', 'origin', remote);
    expect(await manager.remoteUrl(repo)).toBe(remote);
    await manager.push(tree.path, tree.branch);
    expect(await git(remote, 'rev-parse', tree.branch)).toBe(tree.baseSha);
    await manager.remove(tree.path, { force: false });
    await expect(readFile(join(tree.path, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(repo, 'rev-parse', tree.branch)).toBe(tree.baseSha);
  }, 90_000);
});
