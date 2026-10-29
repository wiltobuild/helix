import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createHelixCore, type CoreLog } from '@helix/core';
import { isHelixError, type HelixCore } from '@helix/contracts';
import { openStore } from '@helix/storage';
import { GitWorktreeManager } from '@helix/git';
import { NodePtyHost } from '@helix/pty-host';
import { createHarness, orchestratorPrompt, reviewerPrompt } from '@helix/harness';
import { createGitHubScm, buildFeedbackMessage } from '@helix/scm';
import { cacheHarnessDetection } from './harness-cache.js';
import { orchestratorScratch, sessionEnvironment, writeHelixLauncher } from './helix-launcher.js';

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

/**
 * Optional Codex overrides from the environment: HELIX_CODEX_MODEL (e.g. gpt-6.1-sol) and
 * HELIX_CODEX_EFFORT (low|medium|high|xhigh|max). Unset means Codex's own configured default.
 */
export function codexOverrides(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  const model = env.HELIX_CODEX_MODEL?.trim();
  const effort = env.HELIX_CODEX_EFFORT?.trim();
  if (model) {
    if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error('HELIX_CODEX_MODEL is not a model id');
    args.push('-c', `model=${model}`);
  }
  if (effort) {
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
      throw new Error('HELIX_CODEX_EFFORT must be low, medium, high, xhigh or max');
    args.push('-c', `model_reasoning_effort=${effort}`);
  }
  return args;
}

/** Optional #9 limits from HELIX_MAX_TURNS and HELIX_MAX_WORKERS (positive integers). */
export function limitsFromEnv(env: NodeJS.ProcessEnv): {
  maxTurnsPerTask?: number;
  maxParallelWorkers?: number;
} {
  const read = (name: string) => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const maxTurnsPerTask = read('HELIX_MAX_TURNS');
  const maxParallelWorkers = read('HELIX_MAX_WORKERS');
  return {
    ...(maxTurnsPerTask ? { maxTurnsPerTask } : {}),
    ...(maxParallelWorkers ? { maxParallelWorkers } : {}),
  };
}

/**
 * Approval policy. By default Helix answers routine requests itself: Claude Code edits inside its
 * worktree (as Codex already may), read-only commands there, and the project's own scripts.
 * HELIX_AUTO_APPROVE=off sends every request to the user.
 */
export function approvalPolicyFromEnv(env: NodeJS.ProcessEnv): {
  autoApproveSafeCommands: boolean;
  claudePermissionMode: 'manual' | 'acceptEdits';
} {
  const raw = env.HELIX_AUTO_APPROVE?.trim().toLowerCase();
  if (raw && raw !== 'on' && raw !== 'off') throw new Error('HELIX_AUTO_APPROVE must be on or off');
  const on = raw !== 'off';
  return { autoApproveSafeCommands: on, claudePermissionMode: on ? 'acceptEdits' : 'manual' };
}

export function crossReviewFromEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HELIX_REVIEWER?.trim().toLowerCase();
  if (raw && raw !== 'on' && raw !== 'off') throw new Error('HELIX_REVIEWER must be on or off');
  return raw !== 'off';
}

export async function createRealCore(options: {
  dataDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<HelixCore> {
  const { dataDir, env } = options;
  // Validate configuration before touching storage or credentials.
  const codexArgs = codexOverrides(env);
  const limits = limitsFromEnv(env);
  const approvals = approvalPolicyFromEnv(env);
  // HELIX_GITHUB=off never looks up a token. `gh auth token` reads the OS keyring directly, so
  // an empty GH_CONFIG_DIR alone does not keep the operator's GitHub login away from Helix.
  const githubOff = env.HELIX_GITHUB?.trim().toLowerCase() === 'off';
  const token = githubOff ? undefined : await resolveGitHubToken(env);
  if (!token)
    console.info(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        message: githubOff
          ? 'GitHub SCM disabled: HELIX_GITHUB=off.'
          : 'GitHub SCM disabled: no token resolved from GH_TOKEN, GITHUB_TOKEN or gh auth token.',
      }),
    );
  await writeHelixLauncher(dataDir);
  const store = openStore({ dataDir });
  const terminals = new NodePtyHost({
    dataDir,
    onError: (error) => consoleLog.error('Terminal operation failed', error),
  });
  try {
    const harnessEnv = Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const harnessOptions = {
      env: harnessEnv,
      dataDir,
      autoApproveSafeCommands: approvals.autoApproveSafeCommands,
      log: (message: string) =>
        console.info(JSON.stringify({ ts: new Date().toISOString(), level: 'info', message })),
      note: (sessionId: import('@helix/contracts').SessionId, text: string) => {
        void core
          .recordNote(sessionId, text)
          .catch((error: unknown) =>
            consoleLog.error('Could not record harness explanation', error),
          );
      },
    };
    const harnesses = {
      'claude-code': createHarness('claude-code', {
        ...harnessOptions,
        claudePermissionMode: approvals.claudePermissionMode,
      }),
      codex: createHarness('codex', {
        ...harnessOptions,
        ...(codexArgs.length ? { extraArgs: codexArgs } : {}),
      }),
    };
    const core = createHelixCore({
      store,
      worktrees: new GitWorktreeManager({ dataDir, projects: store }),
      terminals,
      harnesses,
      orchestratorPrompt: (ctx) =>
        orchestratorPrompt({ ...ctx, scratchDir: orchestratorScratch(dataDir, ctx.session) }),
      reviewerPrompt,
      crossReview: crossReviewFromEnv(env),
      dataDir,
      sessionEnv: sessionEnvironment(dataDir, env),
      detectHarnesses: cacheHarnessDetection(harnesses, (message, error) =>
        consoleLog.error(message, error),
      ),
      ...(env.HELIX_STALL_TIMEOUT_MS ? { stallTimeoutMs: Number(env.HELIX_STALL_TIMEOUT_MS) } : {}),
      ...(Object.keys(limits).length ? { limits } : {}),
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
