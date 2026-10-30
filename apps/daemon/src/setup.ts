import { spawn } from 'node:child_process';
import { createHarness } from '@helix/harness';
import {
  setupResponseSchema,
  type AgentKind,
  type HarnessInfo,
  type HelixCore,
  type SetupResponse,
} from '@helix/contracts';
import {
  approvalPolicyFromEnv,
  codexOverrides,
  crossReviewFromEnv,
  limitsFromEnv,
} from './config.js';
import { resolveGitHubToken } from './credentials.js';

// Optional extension keeps embedded cores compatible without changing the shared core port.
export type SetupCore = HelixCore & { setup?: () => Promise<SetupResponse> };
type Tool = 'git' | 'node' | 'pnpm';
export type SetupOptions = {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  timeoutMs?: number;
  detect?: (agent: AgentKind) => Promise<HarnessInfo>;
  resolveToken?: () => Promise<string | undefined>;
  login?: (token: string, signal: AbortSignal) => Promise<string | undefined>;
  version?: (tool: Tool, signal: AbortSignal) => Promise<string>;
};

/** Fixed executable/arguments only; pnpm's Windows shim requires cmd.exe. */
export function toolVersion(
  tool: Tool,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      tool === 'pnpm' && process.platform === 'win32' ? 'pnpm.cmd' : tool,
      ['--version'],
      {
        env,
        windowsHide: true,
        shell: tool === 'pnpm' && process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    let output = '';
    const stop = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
      reject(new Error('Probe stopped'));
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 4096) stop();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      signal.removeEventListener('abort', stop);
      if (code === 0 && output.trim()) resolve(output.trim().split(/\r?\n/)[0]!);
      else reject(new Error('Version unavailable'));
    });
  });
}

async function githubLogin(token: string, signal: AbortSignal): Promise<string | undefined> {
  const response = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal,
    redirect: 'error',
  });
  if (!response.ok) return undefined;
  const body: unknown = await response.json();
  return body &&
    typeof body === 'object' &&
    'login' in body &&
    typeof body.login === 'string' &&
    /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(body.login)
    ? body.login
    : undefined;
}

export function createSetupChecks(options: SetupOptions = {}): () => Promise<SetupResponse> {
  // Snapshot the daemon's environment; never return the environment object itself.
  const env = { ...(options.env ?? process.env) };
  const timeoutMs = options.timeoutMs ?? 3000;
  const detect =
    options.detect ??
    ((agent: AgentKind) =>
      createHarness(agent, {
        env: Object.fromEntries(
          Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        requestTimeoutMs: Math.max(1, Math.floor(timeoutMs / 2)),
        ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      }).detect());
  return async () => {
    const secrets = new Set(
      [env.GH_TOKEN?.trim(), env.GITHUB_TOKEN?.trim()].filter((s): s is string => !!s),
    );
    async function probe<T extends { ok: boolean; detail: string }>(
      run: (signal: AbortSignal) => Promise<T>,
      fallback: T,
    ): Promise<T> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(() => run(controller.signal)),
          new Promise<T>((resolve) => {
            timer = setTimeout(() => {
              controller.abort();
              resolve({ ...fallback, detail: 'Probe timed out' });
            }, timeoutMs);
          }),
        ]);
      } catch {
        // Error messages and process stderr can contain credentials.
        return fallback;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }
    const agent = (kind: AgentKind) =>
      probe<SetupResponse['agents']['codex']>(
        async () => {
          const info = await detect(kind);
          const signedIn = info.signedIn ?? 'unknown';
          // Most CLIs give no cheap sign-in signal, so detect() often says "unknown". Only a
          // confirmed sign-out fails the check; telling a signed-in user to log in again before a
          // demo is worse than reporting that sign-in wasn't verified.
          const ok = info.installed && signedIn !== false;
          return {
            ok,
            installed: info.installed,
            signedIn,
            ...(info.version ? { version: info.version } : {}),
            detail: !info.installed
              ? 'Not installed'
              : signedIn === true
                ? 'Installed and signed in'
                : signedIn === false
                  ? 'Not signed in'
                  : 'Installed; sign-in not verified (the first task will show a login error if needed)',
            ...(!ok
              ? {
                  fix: !info.installed
                    ? `Install ${kind === 'codex' ? 'Codex CLI' : 'Claude Code'} and add it to PATH`
                    : `Run \`${kind === 'codex' ? 'codex login' : 'claude auth login'}\``,
                }
              : {}),
          };
        },
        {
          ok: false,
          detail: 'Agent detection failed',
          installed: false,
          signedIn: 'unknown',
          fix: `Check ${kind} installation and login, then retry`,
        },
      );
    const github = probe<SetupResponse['github']>(
      async (signal) => {
        if (env.HELIX_GITHUB?.trim().toLowerCase() === 'off')
          return {
            ok: true,
            detail: 'off (HELIX_GITHUB=off)',
            status: 'off',
            tokenResolved: false,
          };
        const token = await (options.resolveToken ?? (() => resolveGitHubToken(env, timeoutMs)))();
        if (!token)
          return {
            ok: false,
            detail: 'No GitHub token resolved',
            status: 'unavailable',
            tokenResolved: false,
            fix: 'Run `gh auth login` or set GH_TOKEN/GITHUB_TOKEN',
          };
        secrets.add(token);
        // Login is optional: a slow/offline API must not turn token discovery into a failure.
        let login: string | undefined;
        const loginController = new AbortController();
        const abort = () => loginController.abort();
        signal.addEventListener('abort', abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          login = await Promise.race([
            Promise.resolve()
              .then(() => (options.login ?? githubLogin)(token, loginController.signal))
              .catch(() => undefined),
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), Math.min(500, timeoutMs / 4));
            }),
          ]);
        } finally {
          clearTimeout(timer);
          loginController.abort();
          signal.removeEventListener('abort', abort);
        }
        return {
          ok: true,
          detail: 'GitHub token resolved',
          status: 'on',
          tokenResolved: true,
          ...(login ? { login } : {}),
        };
      },
      {
        ok: false,
        detail: 'GitHub check failed',
        status: 'unavailable',
        tokenResolved: false,
        fix: 'Run `gh auth login` or set GH_TOKEN/GITHUB_TOKEN',
      },
    );
    const tool = (name: Tool) =>
      probe<SetupResponse['tools']['git']>(
        async (signal) => {
          const version = await (
            options.version ?? ((tool, signal) => toolVersion(tool, env, signal))
          )(name, signal);
          return { ok: true, detail: version, version };
        },
        { ok: false, detail: 'Version unavailable', fix: `Install ${name} and add it to PATH` },
      );
    const config = probe<SetupResponse['config']>(
      () => {
        codexOverrides(env);
        const limits = limitsFromEnv(env);
        return Promise.resolve({
          ok: true,
          detail: 'Effective daemon settings',
          reviewer: crossReviewFromEnv(env),
          autoApprove: approvalPolicyFromEnv(env).autoApproveSafeCommands,
          maxWorkers: limits.maxParallelWorkers ?? 3,
          maxTurns: limits.maxTurnsPerTask ?? 20,
          codexModel: env.HELIX_CODEX_MODEL?.trim() || null,
          codexEffort: (env.HELIX_CODEX_EFFORT?.trim() ||
            null) as SetupResponse['config']['codexEffort'],
        });
      },
      {
        ok: false,
        detail: 'Invalid daemon settings',
        fix: 'Check HELIX_REVIEWER, HELIX_AUTO_APPROVE, HELIX_MAX_WORKERS, HELIX_MAX_TURNS and HELIX_CODEX_MODEL/EFFORT',
      },
    );
    const [codex, claude, githubResult, git, node, pnpm, configResult] = await Promise.all([
      agent('codex'),
      agent('claude-code'),
      github,
      tool('git'),
      tool('node'),
      tool('pnpm'),
      config,
    ]);
    const result: SetupResponse = {
      agents: { codex, 'claude-code': claude },
      github: githubResult,
      tools: { git, node, pnpm },
      config: configResult,
    };
    // Only schema-approved fields survive, with known credentials redacted from every string.
    return setupResponseSchema.parse(
      JSON.parse(
        JSON.stringify(result, (_key, value: unknown) =>
          typeof value === 'string'
            ? [...secrets].reduce((s, secret) => s.replaceAll(secret, '[redacted]'), value)
            : value,
        ),
      ),
    );
  };
}
