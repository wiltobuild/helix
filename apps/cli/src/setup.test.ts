import { expect, test, vi } from 'vitest';
import { createHelixClient } from '@helix/api-client';
import type { SetupResponse } from '@helix/contracts';
import { runCli } from './cli.js';

function fixture(ok = true): SetupResponse {
  const agent = {
    ok,
    detail: ok ? 'Installed and signed in' : 'Not signed in',
    installed: true,
    signedIn: ok,
    version: '1.2.3',
    ...(!ok ? { fix: 'Run `codex login`' } : {}),
  };
  const tool = { ok: true, detail: '1.0', version: '1.0' };
  return {
    agents: { codex: agent, 'claude-code': agent },
    github: { ok: true, detail: 'off (HELIX_GITHUB=off)', status: 'off', tokenResolved: false },
    tools: { git: tool, node: tool, pnpm: tool },
    config: {
      ok: true,
      detail: 'Effective daemon settings',
      reviewer: true,
      autoApprove: true,
      maxWorkers: 3,
      maxTurns: 20,
      codexModel: null,
      codexEffort: null,
    },
  };
}
test.each([true, false])('setup human and JSON output (ready=%s)', async (ok) => {
  const body = fixture(ok);
  const fetcher = vi.fn<typeof fetch>((input) => {
    expect(input instanceof Request ? input.url : input.toString()).toBe(
      'http://127.0.0.1:4317/api/setup',
    );
    return Promise.resolve(Response.json(body));
  });
  const stdout = vi.fn();
  const stderr = vi.fn();
  const options = {
    client: createHelixClient({ baseUrl: 'http://127.0.0.1:4317', fetch: fetcher }),
    stdout,
    stderr,
  };
  expect(await runCli(['setup'], options)).toBe(ok ? 0 : 1);
  const text = String(stdout.mock.calls[0]?.[0]);
  expect(text).toContain(ok ? '\u2713 codex' : '\u2717 codex');
  expect(text).toContain('GitHub: off');
  expect(text).toContain('maxWorkers=3 maxTurns=20');
  if (!ok) expect(text).toContain('Fix: Run `codex login`');
  expect(await runCli(['setup', '--json'], options)).toBe(ok ? 0 : 1);
  expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toEqual(body);
  expect(stderr).not.toHaveBeenCalled();
});
test('setup rejects unexpected arguments before contacting daemon', async () => {
  const stderr = vi.fn();
  expect(await runCli(['setup', 'extra'], { stderr })).toBe(1);
});
