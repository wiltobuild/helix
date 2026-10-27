import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
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

export async function writeHelixLauncher(dataDir: string): Promise<void> {
  const windows = process.platform === 'win32';
  await access(join(workspace, 'node_modules', '.bin', windows ? 'tsx.cmd' : 'tsx'));
  await access(join(workspace, 'apps', 'cli', 'src', 'main.ts'));
  const bin = join(resolve(dataDir), 'bin');
  await mkdir(bin, { recursive: true });
  const launcher = join(bin, windows ? 'helix.cmd' : 'helix');
  await writeFile(launcher, launcherContents(workspace), { mode: 0o755 });
  if (!windows) await chmod(launcher, 0o755);
}

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
    session.role === 'orchestrator'
      ? {
          HELIX_DATA_DIR: resolve(dataDir),
          HELIX_SESSION_ID: session.id,
          HELIX_PROJECT_ID: project.id,
          PATH: join(resolve(dataDir), 'bin') + (basePath ? delimiter + basePath : ''),
        }
      : undefined;
}
