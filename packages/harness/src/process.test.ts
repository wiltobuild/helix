import { appendFile, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  killLiveProcesses,
  killTree,
  prepareSupervisorAssembly,
  spawnExecutable,
} from './process.js';
import type { HarnessOptions } from './options.js';

/** Runs a tiny node child through the supervisor with stage markers on; returns its output. */
async function supervise(options: HarnessOptions) {
  const child = spawnExecutable(process.execPath, ['-e', "process.stdout.write('ok')"], {
    ...options,
    env: { ...options.env, HELIX_DEBUG_PROCESS: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  child.stdin.on('error', () => undefined);
  child.stdin.end();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { stdout, stderr, code };
}
const windowsOnly = it.skipIf(process.platform !== 'win32');

windowsOnly(
  'loads the supervisor assembly only after verifying it against the in-memory hash (#36)',
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'helix-supervisor-'));
    const prepared = await prepareSupervisorAssembly(dataDir);
    expect(prepared?.assembly.startsWith(join(dataDir, 'cache', 'windows-job'))).toBe(true);
    expect(prepared?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const run = await supervise({ dataDir });
    expect(run).toMatchObject({ stdout: 'ok', code: 0 });
    expect(run.stderr).toContain('compiled (verified cache)');
  },
  60_000,
);

windowsOnly(
  'falls back to an in-memory compile when the cached assembly was tampered with (#36)',
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'helix-supervisor-'));
    const prepared = await prepareSupervisorAssembly(dataDir);
    await appendFile(prepared!.assembly, Buffer.from([0]));
    const run = await supervise({ dataDir });
    expect(run).toMatchObject({ stdout: 'ok', code: 0 });
    expect(run.stderr).toContain('compiled (fallback: hash mismatch)');
    expect(run.stderr).not.toContain('compiled (verified cache)');
  },
  60_000,
);

windowsOnly(
  'compiles in memory without a data dir and never writes a cache under %TEMP% (#36)',
  async () => {
    const legacy = join(tmpdir(), 'helix-windows-job');
    const before = await stat(legacy).catch(() => undefined);
    const run = await supervise({});
    expect(run).toMatchObject({ stdout: 'ok', code: 0 });
    expect(run.stderr).toContain('compiled (in-memory)');
    const after = await stat(legacy).catch(() => undefined);
    expect(after?.mtimeMs).toBe(before?.mtimeMs);
  },
  60_000,
);

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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const spawnOrphaningParent = async () => {
  const pidFile = join(await mkdtemp(join(tmpdir(), 'helix-process-')), 'grandchild.pid');
  // The parent starts a long-lived grandchild, records its PID, then exits on its own.
  const script = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>process.exit(0),200)`;
  const child = spawnExecutable(process.execPath, ['-e', script], {});
  child.stdin.on('error', () => undefined);
  await expect
    .poll(() => readFile(pidFile, 'utf8').catch(() => ''), { timeout: 10_000 })
    .not.toBe('');
  return { child, grandchild: Number(await readFile(pidFile, 'utf8')) };
};

it('kills a descendant that outlives its already-exited parent', async () => {
  const { child, grandchild } = await spawnOrphaningParent();
  expect(alive(grandchild)).toBe(true);
  await expect
    .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 15_000 })
    .toBe(true);
  await killTree(child);
  await expect.poll(() => alive(grandchild), { timeout: 10_000 }).toBe(false);
}, 30_000);

it('kills every live agent tree when the host process exits abruptly', async () => {
  const { grandchild } = await spawnOrphaningParent();
  expect(alive(grandchild)).toBe(true);
  killLiveProcesses();
  await expect.poll(() => alive(grandchild), { timeout: 10_000 }).toBe(false);
}, 30_000);
