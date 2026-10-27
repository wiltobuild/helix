import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { openStore } from '@helix/storage';
import { HelixError } from '@helix/contracts';
import {
  codexOverrides,
  consoleLog,
  createRealCore,
  limitsFromEnv,
  resolveGitHubToken,
} from './real-core.js';
import { startDaemon } from './lifecycle.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('@helix/storage', async (original) => {
  const storage = await original<typeof import('@helix/storage')>();
  return { ...storage, openStore: vi.fn(storage.openStore) };
});
function gh(output: string, code = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    child.stdout.emit('data', output);
    child.emit('close', code);
  });
  return child as unknown as ReturnType<typeof spawn>;
}
beforeEach(() => {
  vi.mocked(spawn).mockImplementation(() => gh('', 1));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test('credential precedence and gh fallback do not reveal token or stderr', async () => {
  expect(await resolveGitHubToken({ GH_TOKEN: ' first ', GITHUB_TOKEN: 'second' })).toBe('first');
  expect(await resolveGitHubToken({ GITHUB_TOKEN: 'second' })).toBe('second');
  expect(spawn).not.toHaveBeenCalled();
  vi.mocked(spawn).mockImplementationOnce(() => gh('third\r\n'));
  expect(await resolveGitHubToken({ PATH: 'test-path' })).toBe('third');
  expect(spawn).toHaveBeenCalledWith(
    'gh',
    ['auth', 'token'],
    expect.objectContaining({
      env: { PATH: 'test-path' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
  expect(await resolveGitHubToken({})).toBeUndefined();
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleLog.error(
    'Adapter failed',
    new HelixError('UNAUTHORIZED', 'secret prompt/token', { token: 'secret' }),
  );
  expect(String(error.mock.calls[0]?.[0])).not.toContain('secret');
  expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
    code: 'UNAUTHORIZED',
    level: 'error',
  });
});

test('real composition runs without SCM and closes its store exactly once', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helix-composition-'));
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const core = await createRealCore({ dataDir, env: {} });
  const store = vi.mocked(openStore).mock.results.at(-1)!.value as ReturnType<typeof openStore>;
  const close = vi.spyOn(store, 'close');
  try {
    const daemon = await startDaemon({ core, dataDir, port: 0, version: 'test' });
    expect(await core.health()).toEqual({ status: 'ok', version: '0.0.0' });
    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0]?.[0])).toContain('GitHub SCM disabled');
    process.emit('SIGTERM');
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await Promise.all([daemon.stop(), core.shutdown(), core.shutdown()]);
    expect(close).toHaveBeenCalledOnce();
    await expect(store.listProjects()).rejects.toThrow();
  } finally {
    await core.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Codex model/effort and limits come from validated environment variables', () => {
  expect(codexOverrides({})).toEqual([]);
  expect(
    codexOverrides({ HELIX_CODEX_MODEL: 'gpt-6.1-sol', HELIX_CODEX_EFFORT: 'medium' }),
  ).toEqual(['-c', 'model=gpt-6.1-sol', '-c', 'model_reasoning_effort=medium']);
  expect(() => codexOverrides({ HELIX_CODEX_MODEL: 'x"; rm -rf /' })).toThrow(/model id/);
  expect(() => codexOverrides({ HELIX_CODEX_EFFORT: 'extreme' })).toThrow(/HELIX_CODEX_EFFORT/);
  expect(limitsFromEnv({})).toEqual({});
  expect(limitsFromEnv({ HELIX_MAX_TURNS: '8', HELIX_MAX_WORKERS: '2' })).toEqual({
    maxTurnsPerTask: 8,
    maxParallelWorkers: 2,
  });
  for (const bad of ['0', '-1', '2.5', 'many'])
    expect(() => limitsFromEnv({ HELIX_MAX_TURNS: bad })).toThrow(/positive integer/);
});

test('HELIX_GITHUB=off never looks up a GitHub token', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helix-github-off-'));
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.mocked(spawn).mockClear();
  const core = await createRealCore({
    dataDir,
    env: { HELIX_GITHUB: 'off', GH_TOKEN: 'should-not-be-used' },
  });
  try {
    expect(vi.mocked(spawn).mock.calls.some(([cmd]) => cmd === 'gh')).toBe(false);
    expect(info.mock.calls.map((c) => String(c[0])).join('\n')).toContain('HELIX_GITHUB=off');
  } finally {
    await core.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});
