import { execFile } from 'node:child_process';
import { HelixError } from '@helix/contracts';

export type GitResult = { stdout: string; stderr: string; code: number };
export type GitRunner = (
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<GitResult>;

export const runGit: GitRunner = (cwd, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'Never',
          GIT_OPTIONAL_LOCKS: '0',
          ...env,
        },
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(
            new HelixError('INTERNAL_ERROR', 'Unable to run Git; install Git 2.40 or newer.', {
              reason: error.message,
            }),
          );
        } else resolve({ stdout, stderr, code: typeof error?.code === 'number' ? error.code : 0 });
      },
    );
  });

export function requireGitVersion(output: string): void {
  const match = /git version (\d+)\.(\d+)/.exec(output);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 40)) {
    throw new HelixError(
      'INTERNAL_ERROR',
      `Git 2.40 or newer is required; found ${output.trim() || 'unknown version'}.`,
    );
  }
}

const locks = new Map<string, Promise<void>>();
/** Shared by all manager instances, not just by one project's adapter. */
export async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}
