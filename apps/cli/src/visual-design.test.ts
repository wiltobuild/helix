import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, vi } from 'vitest';
import { createHelixClient } from '@helix/api-client';
import { runCli } from './cli.js';
test('publishes checkpoint with stable request identity and never accepts an agent approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helix-visual-cli-'));
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ design: null })));
  const client = createHelixClient({ baseUrl: 'http://localhost:9999', fetch: fetcher });
  const options = { client, cwd: dir, stdout: vi.fn(), stderr: vi.fn() };
  const file = join(dir, 'checkpoint.json');
  try {
    await writeFile(
      file,
      JSON.stringify({
        requestId: 'checkpoint-one',
        revision: 3,
        action: 'checkpoint',
        checkpoint: {
          workerSessionId: 'worker-1',
          headSha: 'sha1',
          previewUrl: 'http://localhost:5179',
          recommendation: 'Check the layout',
          reducedMotion: true,
        },
      }),
    );
    expect(await runCli(['design', 'checkpoint', file, '--session', 'design-1'], options)).toBe(0);
    expect(fetcher.mock.calls[0]?.[1]?.body).toContain('checkpoint-one');
    await writeFile(
      file,
      JSON.stringify({
        requestId: 'no',
        revision: 3,
        action: 'approve',
        conceptIds: ['one'],
        text: 'Approve my own work',
      }),
    );
    expect(await runCli(['design', 'checkpoint', file, '--session', 'design-1'], options)).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
