import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { sessionIdSchema, sessionSchema } from '@helix/contracts';
import { createHarness } from './harness.js';

const context = {
  id: sessionIdSchema.parse('session_discovery_test'),
  agent: 'codex' as const,
  interface: 'chat' as const,
  title: 'Develop a concept',
  createdAt: '2026-10-30T00:00:00Z',
};

test('discovery uses actual scratch child environment and restrictive protocol without a project Session', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'helix-discovery-harness-'));
  const transcript = path.join(cwd, 'protocol.jsonl');
  vi.stubEnv('HELIX_DISCOVERY_TEST_PARENT', 'must-not-inherit');
  vi.stubEnv('gIt_DISCOVERY_TEST_PARENT', 'must-not-inherit');
  try {
    expect(sessionSchema.safeParse(context).success).toBe(false);
    const session = await createHarness('codex', {
      bin: process.execPath,
      extraArgs: [
        fileURLToPath(new URL('./__fixtures__/fake-discovery.cjs', import.meta.url)),
        transcript,
      ],
      env: { hElIx_DISCOVERY_TEST_OVERRIDE: 'must-not-inherit', DISCOVERY_SAFE_TEST: 'yes' },
      codexSandbox: 'danger-full-access',
      codexApprovalPolicy: 'on-request',
      autoApproveSafeCommands: true,
    }).start({ purpose: 'discovery', session: context, cwd });
    try {
      const records = (await readFile(transcript, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records[0]).toEqual({
        spawnedEnvironment: { forbiddenKeys: [], safe: 'yes', temp: cwd },
      });
      expect(records.find((frame) => frame.method === 'thread/start')).toMatchObject({
        params: {
          cwd,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          config: {
            'features.shell_tool': false,
            'features.apps': false,
            'features.multi_agent': false,
            web_search: 'disabled',
          },
        },
      });
      expect(records.some((frame) => frame.method === 'turn/start')).toBe(false);
    } finally {
      await session.stop();
    }
  } finally {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('discovery metadata cannot select a Claude build adapter', async () => {
  await expect(
    createHarness('claude-code').start({ purpose: 'discovery', session: context, cwd: '.' }),
  ).rejects.toThrow('requires the Codex');
});
