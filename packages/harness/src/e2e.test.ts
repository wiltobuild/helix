import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fixtures, type HarnessEmission, type HarnessSession } from '@helix/contracts';
import { createHarness } from './index.js';

for (const kind of ['claude-code', 'codex'] as const)
  it.skipIf(process.env.HELIX_E2E !== '1')(
    `${kind} real one-turn smoke`,
    async (context) => {
      const harness = createHarness(kind);
      const info = await harness.detect();
      if (!info.installed || info.signedIn === false)
        context.skip('CLI must be installed and signed in');
      const created = fixtures.passwordResetRun.find((event) => event.type === 'session.created');
      if (!created || created.type !== 'session.created')
        throw new Error('Missing session fixture');
      const cwd = await mkdtemp(join(tmpdir(), 'helix-harness-e2e-'));
      let session: HarnessSession | undefined;
      try {
        session = await harness.start({
          cwd,
          session: {
            ...created.payload.session,
            agent: kind,
            prompt: 'Reply with the word ok. Do not use tools.',
          },
        });
        const events: HarnessEmission[] = [];
        session.onEvent((event) => events.push(event));
        await session.send('Reply with the word ok. Do not use tools.', 'queue');
        await expect
          .poll(
            () =>
              events.some(
                (event) =>
                  event.type === 'chat.item' &&
                  event.payload.item.kind === 'message' &&
                  event.payload.item.role === 'assistant',
              ),
            { timeout: 90_000 },
          )
          .toBe(true);
        await expect
          .poll(
            () =>
              events.some(
                (event) => event.type === 'activity.changed' && event.payload.activity === 'idle',
              ),
            { timeout: 90_000 },
          )
          .toBe(true);
        await session.stop();
        expect(events).toContainEqual({
          type: 'activity.changed',
          payload: { activity: 'exited' },
        });
      } finally {
        await session?.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    120_000,
  );
