import { afterEach, expect, test, vi } from 'vitest';
import { setupRequestSchema, setupResponseSchema } from '@helix/contracts';
import { createSetupChecks, type SetupOptions } from './setup.js';

afterEach(() => vi.useRealTimers());
function options(): SetupOptions {
  return {
    env: {},
    timeoutMs: 100,
    detect: (agent) =>
      Promise.resolve({ agent, installed: true, signedIn: true, version: '1.2.3' }),
    resolveToken: () => Promise.resolve('secret-token'),
    login: () => Promise.resolve('demo'),
    version: (tool) => Promise.resolve(tool === 'node' ? 'v24.0.0' : '1.2.3'),
  };
}
test('all checks OK with defaults and strict request/response schemas', async () => {
  const result = await createSetupChecks(options())();
  expect(result.agents.codex).toMatchObject({
    ok: true,
    installed: true,
    signedIn: true,
    version: '1.2.3',
  });
  expect(result.agents['claude-code'].ok).toBe(true);
  expect(result.github).toMatchObject({ ok: true, tokenResolved: true, login: 'demo' });
  expect(Object.values(result.tools).every((check) => check.ok)).toBe(true);
  expect(result.config).toMatchObject({
    reviewer: true,
    autoApprove: true,
    maxWorkers: 3,
    maxTurns: 20,
    codexModel: null,
    codexEffort: null,
  });
  expect(setupRequestSchema.safeParse({ extra: true }).success).toBe(false);
  expect(setupResponseSchema.safeParse({ ...result, token: 'secret' }).success).toBe(false);
  expect(
    setupResponseSchema.safeParse({ ...result, github: { ...result.github, token: 'secret' } })
      .success,
  ).toBe(false);
});
test('missing agent, unknown sign-in and failed tools stay independent', async () => {
  const result = await createSetupChecks({
    ...options(),
    detect: (agent) =>
      Promise.resolve({ agent, installed: agent !== 'codex', signedIn: 'unknown' }),
    version: (tool) => {
      if (tool === 'git') throw new Error('secret-token');
      return Promise.resolve('1.0');
    },
  })();
  expect(result.agents.codex).toMatchObject({ ok: false, installed: false });
  expect(result.agents.codex.fix).toContain('Install');
  // Unverified sign-in passes (most CLIs can't report it cheaply); it must not send a signed-in
  // user to log in again.
  expect(result.agents['claude-code']).toMatchObject({ ok: true, signedIn: 'unknown' });
  expect(result.agents['claude-code'].fix).toBeUndefined();
  expect(result.tools.git.ok).toBe(false);
  expect(result.tools.pnpm.ok).toBe(true);
  expect(result.github.ok).toBe(true);
  expect(JSON.stringify(result)).not.toContain('secret-token');
});
test('a confirmed sign-out fails with the login fix', async () => {
  const result = await createSetupChecks({
    ...options(),
    detect: (agent) => Promise.resolve({ agent, installed: true, signedIn: false }),
  })();
  expect(result.agents.codex).toMatchObject({ ok: false, detail: 'Not signed in' });
  expect(result.agents.codex.fix).toBe('Run `codex login`');
  expect(result.agents['claude-code'].fix).toBe('Run `claude auth login`');
});
test('GitHub off skips credential lookup and login', async () => {
  const resolveToken = vi.fn<NonNullable<SetupOptions['resolveToken']>>();
  const login = vi.fn<NonNullable<SetupOptions['login']>>();
  const result = await createSetupChecks({
    ...options(),
    env: { HELIX_GITHUB: 'off' },
    resolveToken,
    login,
  })();
  expect(result.github).toMatchObject({ ok: true, status: 'off', tokenResolved: false });
  expect(resolveToken).not.toHaveBeenCalled();
  expect(login).not.toHaveBeenCalled();
});
test('missing token gives an actionable failure', async () => {
  const result = await createSetupChecks({
    ...options(),
    resolveToken: () => Promise.resolve(undefined),
  })();
  expect(result.github).toMatchObject({ ok: false, status: 'unavailable', tokenResolved: false });
  expect(result.github.fix).toContain('gh auth login');
});
test('parallel hanging probes time out without losing healthy checks', async () => {
  vi.useFakeTimers();
  const started: string[] = [];
  const result = createSetupChecks({
    ...options(),
    detect: (agent) => {
      started.push(agent);
      return new Promise(() => undefined);
    },
    version: (tool) => {
      started.push(tool);
      return tool === 'git' ? new Promise(() => undefined) : Promise.resolve('1.0');
    },
    resolveToken: () => {
      started.push('github');
      return new Promise(() => undefined);
    },
  })();
  await vi.advanceTimersByTimeAsync(0);
  expect(started.sort()).toEqual(['claude-code', 'codex', 'git', 'github', 'node', 'pnpm']);
  await vi.advanceTimersByTimeAsync(100);
  const value = await result;
  expect(value.agents.codex.detail).toBe('Probe timed out');
  expect(value.tools.git.detail).toBe('Probe timed out');
  expect(value.github.detail).toBe('Probe timed out');
  expect(value.tools.node.ok).toBe(true);
  expect(value.config.ok).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
test('slow optional login does not invalidate a resolved token', async () => {
  vi.useFakeTimers();
  const result = createSetupChecks({ ...options(), login: () => new Promise(() => undefined) })();
  await vi.advanceTimersByTimeAsync(25);
  expect((await result).github).toEqual({
    ok: true,
    detail: 'GitHub token resolved',
    status: 'on',
    tokenResolved: true,
  });
});
test('tokens never appear in returned fields or logs, including probe errors', async () => {
  const log = vi.spyOn(console, 'log');
  const info = vi.spyOn(console, 'info');
  const error = vi.spyOn(console, 'error');
  try {
    const result = await createSetupChecks({
      ...options(),
      env: { GH_TOKEN: 'env-secret', GITHUB_TOKEN: 'other-secret' },
      login: () => Promise.resolve('secret-token'),
      detect: (agent) =>
        Promise.resolve({
          agent,
          installed: true,
          signedIn: true,
          version: 'env-secret other-secret secret-token',
        }),
      version: () => Promise.reject(new Error('secret-token')),
    })();
    for (const secret of ['env-secret', 'other-secret', 'secret-token'])
      expect(JSON.stringify(result)).not.toContain(secret);
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});
test('effective settings use the daemon parsers and exclude unrelated environment', async () => {
  const result = await createSetupChecks({
    ...options(),
    env: {
      HELIX_REVIEWER: 'off',
      HELIX_AUTO_APPROVE: 'off',
      HELIX_MAX_WORKERS: '5',
      HELIX_MAX_TURNS: '12',
      HELIX_CODEX_MODEL: 'gpt-6.1-sol',
      HELIX_CODEX_EFFORT: 'high',
      PRIVATE_SECRET: 'never-output',
    },
  })();
  expect(result.config).toMatchObject({
    ok: true,
    reviewer: false,
    autoApprove: false,
    maxWorkers: 5,
    maxTurns: 12,
    codexModel: 'gpt-6.1-sol',
    codexEffort: 'high',
  });
  expect(JSON.stringify(result)).not.toContain('never-output');
  const invalid = await createSetupChecks({ ...options(), env: { HELIX_MAX_TURNS: '-1' } })();
  expect(invalid.config.ok).toBe(false);
  expect(invalid.agents.codex.ok).toBe(true);
});
