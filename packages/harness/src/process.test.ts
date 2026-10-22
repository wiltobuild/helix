import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { killTree, spawnExecutable } from './process.js';

const executable = fileURLToPath(new URL('./__fixtures__/pipe-cli.cjs', import.meta.url));

it.skipIf(process.platform !== 'win32').each(['0', '1'])(
  'moves all three Windows pipes independently with stdin open (HELIX_DEBUG_PROCESS=%s)',
  async (debug) => {
    const child = spawnExecutable(process.execPath, [executable], {
      env: { HELIX_DEBUG_PROCESS: debug },
    });
    let output = '';
    let diagnostics = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostics += chunk.toString('utf8');
    });
    child.stdin.on('error', () => undefined);
    const closed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
    try {
      // The child cannot finish its stderr write if either output pump is
      // blocked behind the idle stdin pump. No stdin EOF to rescue the bridge.
      await expect.poll(() => output, { timeout: 15_000 }).toBe('ready\n');
      const stderrPayload = () =>
        diagnostics.replace(/\[Helix process [^\]]+\] [^\r\n]+\r?\n/g, '');
      await expect.poll(() => stderrPayload().length).toBe(128 * 1024);
      expect(stderrPayload().replaceAll('e', '')).toBe('');
      for (const frame of ['first hé🙂', 'second']) {
        child.stdin.write(frame + '\n');
        await expect.poll(() => output, { timeout: 5000 }).toContain(frame + '\n');
      }
      if (debug === '1') {
        for (const stage of [
          'compiled',
          'job entered',
          'child started pid=',
          'first stdin byte',
          'first stdout byte',
        ]) {
          await expect.poll(() => diagnostics).toContain(stage);
        }
        expect(diagnostics).toMatch(/\[Helix process \d{4}-\d{2}-\d{2}T[^\]]+Z\]/);
      } else expect(diagnostics.length).toBe(128 * 1024);
      child.stdin.end();
      await closed;
      expect(child.exitCode).toBe(0);
    } finally {
      await killTree(child);
      await closed;
    }
  },
  30_000,
);
