import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createHelixCore, type CoreLog } from '@helix/core';
import { isHelixError, type HelixCore } from '@helix/contracts';
import { openStore } from '@helix/storage';
import { GitWorktreeManager } from '@helix/git';
import { NodePtyHost } from '@helix/pty-host';
import { createHarness } from '@helix/harness';
import { createGitHubScm, buildFeedbackMessage } from '@helix/scm';

/** Only caller-authored messages and error codes reach logs, never adapter error bodies. */
export const consoleLog: CoreLog = {
  error(message, error) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        message,
        ...(isHelixError(error) ? { code: error.code } : {}),
      }),
    );
  },
};

// CONTRACT-REQUEST: export token discovery from @helix/scm so composition can
// decide whether SCM is available without duplicating its credential lookup.
export function resolveGitHubToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (token) return Promise.resolve(token);
  return new Promise((resolve) => {
    const child = spawn('gh', ['auth', 'token'], {
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const kill = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          shell: false,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      kill();
      finish();
    }, 10_000);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 16_384) {
        kill();
        finish();
      }
    });
    child.on('error', () => finish());
    child.on('close', (code) => finish(code === 0 ? output.trim() || undefined : undefined));
  });
}

export async function createRealCore(options: {
  dataDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<HelixCore> {
  const { dataDir, env } = options;
  const token = await resolveGitHubToken(env);
  if (!token)
    console.info(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        message:
          'GitHub SCM disabled: no token resolved from GH_TOKEN, GITHUB_TOKEN or gh auth token.',
      }),
    );
  const store = openStore({ dataDir });
  const terminals = new NodePtyHost({
    dataDir,
    onError: (error) => consoleLog.error('Terminal operation failed', error),
  });
  try {
    const harnessEnv = Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const core = createHelixCore({
      store,
      worktrees: new GitWorktreeManager({ dataDir, projects: store }),
      terminals,
      harnesses: {
        'claude-code': createHarness('claude-code', { env: harnessEnv }),
        codex: createHarness('codex', { env: harnessEnv }),
      },
      ...(token
        ? {
            scm: createGitHubScm({
              token,
              onError: (error) => consoleLog.error('GitHub observation failed', error),
            }),
          }
        : {}),
      buildFeedbackMessage,
      harnessStartsWithPrompt: () => true,
      clock: () => new Date().toISOString(),
      ids: (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`,
      log: consoleLog,
    });
    let closing: Promise<void> | undefined;
    return {
      ...core,
      shutdown: () =>
        (closing ??= (async () => {
          try {
            await core.shutdown();
          } finally {
            try {
              await terminals.close();
            } finally {
              await store.close();
            }
          }
        })()),
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
