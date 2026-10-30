import { createCodexVisualProvider } from './visual-images.js';
import { resolveExecutable } from '@helix/harness';
import {
  approvalPolicyFromEnv,
  codexOverrides,
  crossReviewFromEnv,
  limitsFromEnv,
} from './config.js';
export {
  approvalPolicyFromEnv,
  codexOverrides,
  crossReviewFromEnv,
  limitsFromEnv,
} from './config.js';
import { createSetupChecks, type SetupCore } from './setup.js';
import { randomUUID } from 'node:crypto';
import { resolveGitHubToken } from './credentials.js';
export { resolveGitHubToken } from './credentials.js';
import { createHelixCore, type CoreLog } from '@helix/core';
import { HelixError } from '@helix/contracts';
import { isHelixError } from '@helix/contracts';
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

export async function createRealCore(options: {
  dataDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<SetupCore> {
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
    const codexBin = await resolveExecutable('codex', env);
    // Probe lazily: ordinary daemon startup and nonvisual tasks never launch an image process.
    const visualImages = codexBin
      ? {
          generate: async (
            input: Parameters<import('@helix/core').VisualImageProvider['generate']>[0],
          ) => {
            const provider = await createCodexVisualProvider({ bin: codexBin, dataDir, env });
            if (!provider)
              throw new HelixError('HARNESS_UNAVAILABLE', 'Codex image capability unavailable');
            return provider.generate(input);
          },
        }
      : undefined;
    const core = createHelixCore({
      ...(visualImages ? { visualImages } : {}),
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
      setup: createSetupChecks({ env, dataDir, resolveToken: () => resolveGitHubToken(env, 2500) }),
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
