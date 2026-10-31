import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, Session } from '@helix/contracts';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));

/** Quote literal paths separately from the caller's forwarded arguments. */
export function launcherContents(root: string, platform = process.platform): string {
  const windows = platform === 'win32';
  const tsx = join(root, 'node_modules', '.bin', windows ? 'tsx.cmd' : 'tsx');
  const cli = join(root, 'apps', 'cli', 'src', 'main.ts');
  if (windows) {
    // Delayed expansion is disabled; doubled percent signs survive batch expansion.
    const quote = (value: string) => {
      if (/["\r\n\0]/.test(value)) throw new Error('Invalid launcher path');
      return '"' + value.replaceAll('%', '%%') + '"';
    };
    return (
      '@echo off\r\nsetlocal DisableDelayedExpansion\r\n' +
      quote(tsx) +
      ' ' +
      quote(cli) +
      ' %*\r\n'
    );
  }
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  return '#!/bin/sh\nexec ' + quote(tsx) + ' ' + quote(cli) + ' "$@"\n';
}

/** Extensionless launcher for POSIX shells on Windows (Git Bash, MSYS); forwards to helix.cmd. */
export const GIT_BASH_SHIM = '#!/bin/sh\nexec "$(dirname "$0")/helix.cmd" "$@"\n';

export function sessionEnvironment(dataDir: string, base: NodeJS.ProcessEnv) {
  const readPath = (env: NodeJS.ProcessEnv) =>
    Object.entries(env)
      .reverse()
      .find(
        ([key, value]) =>
          value !== undefined &&
          (process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH'),
      )?.[1];
  const basePath = readPath(base) ?? readPath(process.env);
  return ({
    session,
    project,
  }: {
    session: Session;
    project: Project;
  }): Record<string, string> | undefined =>
    session.role === 'orchestrator' || session.role === 'reviewer'
      ? {
          HELIX_DATA_DIR: resolve(dataDir),
          HELIX_SESSION_ID: session.id,
          HELIX_PROJECT_ID: project.id,
          PATH: join(resolve(dataDir), 'bin') + (basePath ? delimiter + basePath : ''),
          ...(session.role === 'orchestrator'
            ? { HELIX_SCRATCH_DIR: orchestratorScratch(dataDir, session) }
            : {}),
        }
      : undefined;
}

/**
 * The folder an orchestrator writes its plan artifact to, created on demand.
 * Keep it under the native OS temporary directory, which is already writable by
 * workspace-write agents, while isolating each Helix data directory and session.
 * On Windows, Claude Code's Write tool and Git Bash disagree about `/tmp`, so
 * the prompt uses this native absolute path instead.
 */
export function orchestratorScratch(dataDir: string, session: Pick<Session, 'id'>): string {
  const namespace = createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16);
  const sessionKey = createHash('sha256').update(session.id).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), 'helix-plan-scratch', namespace, sessionKey);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function writeHelixLauncher(dataDir: string): Promise<void> {
  const windows = process.platform === 'win32';
  await access(join(workspace, 'node_modules', '.bin', windows ? 'tsx.cmd' : 'tsx'));
  await access(join(workspace, 'apps', 'cli', 'src', 'main.ts'));
  const bin = join(resolve(dataDir), 'bin');
  await mkdir(bin, { recursive: true });
  const launcher = join(bin, windows ? 'helix.cmd' : 'helix');
  await writeFile(launcher, launcherContents(workspace), { mode: 0o755 });
  if (!windows) await chmod(launcher, 0o755);
  // Claude Code runs commands in Git Bash on Windows, which does not resolve `helix` to helix.cmd.
  if (windows) await writeFile(join(bin, 'helix'), GIT_BASH_SHIM, { mode: 0o755 });
}
