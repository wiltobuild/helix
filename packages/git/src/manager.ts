import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HelixError,
  isHelixError,
  type DiffResponse,
  type DiffScope,
  type GitService,
  type ProjectId,
  type ProjectIndex,
  type SessionId,
  type Worktree,
  type WorktreeCreateOptions,
} from '@helix/contracts';
import { parseDiffFiles } from './diff.js';
import { requireGitVersion, runGit, serialize, type GitRunner } from './git.js';

export interface GitWorktreeManagerOptions {
  dataDir: string;
  projects: Pick<ProjectIndex, 'getProject'>;
  /** Test seam; production always uses execFile without a shell. */
  runGit?: GitRunner;
  /** Reports a local-only base when no origin is configured. Defaults to console.info. */
  onBaseFallback?: (result: LocalBaseFallback) => void;
}
export interface LocalBaseFallback {
  source: 'local';
  repoPath: string;
  branch: string;
  sha: string;
  reason: 'no-origin';
}
type Metadata = { base: string; baseSha: string; sessionId: SessionId };

export class DirtyWorktreeError extends HelixError {
  constructor(path: string) {
    super('DIRTY_WORKTREE', `Refusing to remove dirty worktree: ${path}`, { path });
  }
}

function segment(value: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) {
    throw new HelixError('INVALID_REQUEST', 'ID is not a safe filesystem component.');
  }
}
function ref(value: string): void {
  if (!value || value.startsWith('-') || /[\0\r\n]/.test(value))
    throw new HelixError('INVALID_REQUEST', 'Invalid Git reference.');
}

export class GitWorktreeManager implements GitService {
  private readonly run: GitRunner;
  private version: Promise<void> | undefined;
  constructor(private readonly options: GitWorktreeManagerOptions) {
    this.run = options.runGit ?? runGit;
  }

  private async git(path: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    this.version ??= this.run(process.cwd(), ['--version']).then((r) =>
      requireGitVersion(r.stdout),
    );
    await this.version;
    const result = await this.run(path, args, env);
    if (result.code !== 0)
      throw new HelixError('INTERNAL_ERROR', `Git ${args[0]} failed.`, {
        code: result.code,
        stderr: result.stderr.replace(/\r\n/g, '\n').trim(),
      });
    return result.stdout;
  }
  private async locked<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const common = (
      await this.git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim();
    const canonical = await realpath(common);
    return serialize(process.platform === 'win32' ? canonical.toLowerCase() : canonical, operation);
  }
  private async metadataPath(path: string): Promise<string> {
    return join(
      (await this.git(path, ['rev-parse', '--absolute-git-dir'])).trim(),
      'helix-worktree.json',
    );
  }
  private async metadata(path: string): Promise<Metadata> {
    try {
      const data: unknown = JSON.parse(await readFile(await this.metadataPath(path), 'utf8'));
      if (
        !data ||
        typeof data !== 'object' ||
        !('base' in data) ||
        typeof data.base !== 'string' ||
        !('baseSha' in data) ||
        typeof data.baseSha !== 'string' ||
        !('sessionId' in data) ||
        typeof data.sessionId !== 'string'
      )
        throw new Error('Invalid metadata');
      segment(data.sessionId);
      return data as Metadata;
    } catch (error) {
      if (isHelixError(error)) throw error;
      throw new HelixError('NOT_FOUND', 'Worktree is not managed by Helix.');
    }
  }
  async create(
    projectId: ProjectId,
    sessionId: SessionId,
    base = '',
    options: WorktreeCreateOptions = {},
  ): Promise<Worktree> {
    segment(projectId);
    segment(sessionId);
    const project = await this.options.projects.getProject(projectId);
    if (!project) throw new HelixError('NOT_FOUND', `Unknown project: ${projectId}`);
    const source = base || project.defaultBranch || (await this.defaultBranch(project.repoPath));
    ref(source);
    return this.locked(project.repoPath, async () => {
      const baseSha = (
        await this.git(project.repoPath, [
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${source}^{commit}`,
        ])
      ).trim();
      const path = resolve(this.options.dataDir, 'worktrees', projectId, sessionId);
      try {
        await lstat(path);
        throw new HelixError('CONFLICT', 'Worktree destination already exists.', { path });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const slug =
        (options.slug ?? sessionId)
          .normalize('NFKD')
          .replace(/[^a-zA-Z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .toLowerCase()
          .slice(0, 64) || 'session';
      let branch = `helix/${slug}`;
      while (
        (
          await this.run(project.repoPath, [
            'show-ref',
            '--verify',
            '--quiet',
            `refs/heads/${branch}`,
          ])
        ).code === 0
      )
        branch = `helix/${slug}-${randomUUID().slice(0, 8)}`;
      await mkdir(dirname(path), { recursive: true });
      await this.git(project.repoPath, ['worktree', 'add', '-b', branch, '--', path, baseSha]);
      try {
        await writeFile(
          await this.metadataPath(path),
          JSON.stringify({ base: source, baseSha, sessionId }),
        );
        await this.git(path, ['update-ref', `refs/helix/${sessionId}/last-turn`, baseSha]);
      } catch (error) {
        // Git itself refuses cleanup if a hook or external process made this dirty.
        await this.git(project.repoPath, ['worktree', 'remove', '--', path]).catch(() => undefined);
        throw error;
      }
      return { branch, path, baseSha };
    });
  }
  async status(path: string): Promise<{ dirty: boolean }> {
    return {
      dirty:
        (
          await this.git(path, [
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
            '--ignore-submodules=none',
          ])
        ).length > 0,
    };
  }
  /** A private index keeps both the real index and user files untouched. */
  private async snapshot(path: string): Promise<string> {
    if (await this.git(path, ['ls-files', '--unmerged', '-z']))
      throw new HelixError(
        'CONFLICT',
        'Resolve merge conflicts before taking a worktree snapshot.',
      );
    const temporary = await mkdtemp(join(tmpdir(), 'helix-index-'));
    const index = join(temporary, 'index');
    const env = { GIT_INDEX_FILE: index };
    try {
      const original = (
        await this.git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
      ).trim();
      try {
        await copyFile(original, index);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await this.git(path, ['read-tree', 'HEAD'], env);
      }
      await this.git(path, ['add', '-A', '--', '.'], env);
      return (await this.git(path, ['write-tree'], env)).trim();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async diff(path: string, scope: DiffScope): Promise<DiffResponse> {
    if (!['workspace', 'pr', 'last_turn'].includes(scope))
      throw new HelixError('INVALID_REQUEST', 'Unknown diff scope.');
    return this.locked(path, async () => {
      const metadata = await this.metadata(path);
      const start =
        scope === 'workspace'
          ? metadata.baseSha
          : scope === 'pr'
            ? (await this.git(path, ['merge-base', metadata.base, 'HEAD'])).trim()
            : `refs/helix/${metadata.sessionId}/last-turn`;
      const end = scope === 'pr' ? 'HEAD' : await this.snapshot(path);
      const args = [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--find-renames',
        '--ignore-submodules=none',
      ];
      const [raw, numstat, unifiedDiff] = await Promise.all([
        this.git(path, [...args, '--raw', '-z', start, end, '--']),
        this.git(path, [...args, '--numstat', '-z', start, end, '--']),
        this.git(path, [...args, '--patch', start, end, '--']),
      ]);
      return { unifiedDiff, files: parseDiffFiles(raw, numstat) };
    });
  }
  async remove(path: string, options: { force: false }): Promise<void> {
    if (options.force !== false)
      throw new HelixError('INVALID_REQUEST', 'Forced worktree removal is forbidden.');
    await this.locked(path, async () => {
      await this.metadata(path);
      if ((await this.status(path)).dirty) throw new DirtyWorktreeError(path);
      const common = (
        await this.git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      ).trim();
      await this.git(common, ['worktree', 'remove', '--', resolve(path)]);
      await this.git(common, ['worktree', 'prune']);
    });
  }
  async isGitRepo(path: string): Promise<boolean> {
    try {
      if (!(await stat(path)).isDirectory()) return false;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw new HelixError('INTERNAL_ERROR', 'Unable to inspect repository path.');
    }
    try {
      return (await this.git(path, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
    } catch (error) {
      if (isHelixError(error) && error.message === 'Git rev-parse failed.') return false;
      throw error;
    }
  }
  async defaultBranch(repoPath: string): Promise<string> {
    await this.git(repoPath, ['rev-parse', '--git-dir']);
    const remote = await this.run(repoPath, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ]);
    if (remote.code === 0) return remote.stdout.trim().replace(/^origin\//, '');
    for (const name of ['main', 'master'])
      if (
        (await this.run(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]))
          .code === 0
      )
        return name;
    const current = await this.run(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (current.code === 0) return current.stdout.trim();
    throw new HelixError(
      'NOT_FOUND',
      'Cannot determine default branch; configure origin/HEAD or a local default branch.',
    );
  }
  async remoteUrl(repoPath: string, remote = 'origin'): Promise<string | undefined> {
    if (!/^[a-zA-Z0-9_-]+$/.test(remote))
      throw new HelixError('INVALID_REQUEST', 'Invalid remote name.');
    await this.git(repoPath, ['rev-parse', '--git-dir']);
    const result = await this.run(repoPath, ['config', '--get', `remote.${remote}.url`]);
    if (result.code === 1) return undefined;
    if (result.code !== 0) throw new HelixError('INTERNAL_ERROR', 'Cannot read Git remote.');
    return result.stdout.trim();
  }
  async headSha(path: string): Promise<string> {
    return (await this.git(path, ['rev-parse', '--verify', 'HEAD'])).trim();
  }
  async commitsAhead(path: string, base: string): Promise<number> {
    ref(base);
    const sha = (
      await this.git(path, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])
    ).trim();
    return Number((await this.git(path, ['rev-list', '--count', `${sha}..HEAD`])).trim());
  }
  async markTurn(path: string, sessionId: SessionId): Promise<void> {
    segment(sessionId);
    await this.locked(path, async () => {
      const metadata = await this.metadata(path);
      if (metadata.sessionId !== sessionId)
        throw new HelixError('INVALID_REQUEST', 'Session does not own this worktree.');
      const tree = await this.snapshot(path);
      const commit = (
        await this.git(
          path,
          [
            '-c',
            'user.name=Helix',
            '-c',
            'user.email=helix@localhost',
            'commit-tree',
            tree,
            '-p',
            await this.headSha(path),
            '-m',
            'Helix turn snapshot',
          ],
          {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'commit.gpgSign',
            GIT_CONFIG_VALUE_0: 'false',
          },
        )
      ).trim();
      await this.git(path, ['update-ref', `refs/helix/${sessionId}/last-turn`, commit]);
    });
  }
  async commitAll(path: string, message: string): Promise<string | undefined> {
    if (!message.trim()) throw new HelixError('INVALID_REQUEST', 'Commit message is required.');
    return this.locked(path, async () => {
      await this.git(path, ['add', '-A', '--', '.']);
      const staged = await this.git(path, ['diff', '--cached', '--name-only', '-z']);
      if (!staged) return undefined;
      await this.git(path, ['commit', '-m', message]);
      return this.headSha(path);
    });
  }
  /** Fetches origin/<branch> and returns its SHA; never touches the local branch or working tree. */
  async fetchBase(repoPath: string, branch: string): Promise<string> {
    ref(branch);
    try {
      return await this.locked(repoPath, async () => {
        await this.git(repoPath, ['check-ref-format', `refs/heads/${branch}`]);
        if ((await this.remoteUrl(repoPath)) === undefined) {
          const sha = (
            await this.git(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
          ).trim();
          const result: LocalBaseFallback = {
            source: 'local',
            repoPath,
            branch,
            sha,
            reason: 'no-origin',
          };
          try {
            if (this.options.onBaseFallback) this.options.onBaseFallback(result);
            else console.info('Helix: no origin remote; using the local base branch.', result);
          } catch {
            // Diagnostic observers cannot turn a successful base resolution into a failure.
          }
          return sha;
        }
        await this.git(
          repoPath,
          ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
          {
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'Never',
            GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
          },
        );
        return (
          await this.git(repoPath, [
            'rev-parse',
            '--verify',
            `refs/remotes/origin/${branch}^{commit}`,
          ])
        ).trim();
      });
    } catch (error) {
      throw new HelixError(
        'INTERNAL_ERROR',
        `Unable to fetch base branch "${branch}" from origin (or resolve its local fallback).`,
        {
          reason: error instanceof Error ? error.message : String(error),
          ...(isHelixError(error) ? { git: error.details } : {}),
        },
      );
    }
  }
  async push(path: string, branch: string): Promise<void> {
    ref(branch);
    await this.locked(path, async () => {
      await this.git(path, ['check-ref-format', '--branch', branch]);
      await this.git(
        path,
        ['push', '--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`],
        {
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'Never',
          GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
        },
      );
    });
  }
}
