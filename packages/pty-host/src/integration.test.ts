import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { sessionIdSchema, type TerminalOutput } from '@helix/contracts';
import { NodePtyHost } from './index.js';

async function until(predicate: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error('Timed out');
    await delay(25);
  }
}
async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux')
      return !(await readFile(`/proc/${pid}/stat`, 'utf8')).includes(') Z ');
    return true;
  } catch {
    return false;
  }
}
describe.skipIf(process.env.HELIX_E2E !== '1')('real Node 24 PTY', () => {
  let root: string;
  let host: NodePtyHost;
  const id = sessionIdSchema.parse('real');
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'helix pty spaces '));
    host = new NodePtyHost({ dataDir: root });
  });
  afterEach(async () => {
    await host.close();
    const target = resolve(root);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);
  test.skipIf(process.platform !== 'win32').each(['cmd', 'bat'])(
    'resolves a PATH .%s shim and delivers hostile arguments verbatim',
    async (extension) => {
      const bin = join(root, 'bin & tools');
      await mkdir(bin);
      const shim = join(bin, `helix-cli.${extension}`);
      const script = join(root, 'arguments.cjs');
      const result = join(root, 'arguments.json');
      await writeFile(
        script,
        "require('node:fs').writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)));",
      );
      await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
      const args = [
        'spaces and "quotes" & | < > ^ %PATH% !HELIX_TEST!',
        '',
        'trailing\\',
        'slashes\\\\"quoted',
        '& echo INJECTED > injected.txt &',
        '100% ! ^ ( ) [ ] ; , * ?',
      ];
      let exited = false;
      host.onExit(() => {
        exited = true;
      });
      await host.spawn(id, {
        command: 'helix-cli',
        args: [result, ...args],
        cwd: root,
        env: { PATH: bin, PATHEXT: '.CMD;.EXE;.COM;.BAT', HELIX_TEST: 'must not expand' },
      });
      await until(() => exited);
      expect(JSON.parse(await readFile(result, 'utf8'))).toEqual(args);
      await expect(readFile(join(root, 'injected.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
    30_000,
  );
  test('immediate stop during native startup leaves no running terminal', async () => {
    await host.spawn(id, {
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>process.exit(0),10000);setInterval(()=>{},1000)'],
      cwd: root,
    });
    await host.kill(id);
    expect(host.list()).toEqual([]);
  }, 30_000);
  test('prints, replays, accepts stdin, resizes before output, and exits with code', async () => {
    const messages: TerminalOutput[] = [];
    const second: TerminalOutput[] = [];
    let exited = false;
    let code: number | null = null;
    host.onExit((_, value) => {
      code = value;
      exited = true;
    });
    await host.spawn(id, {
      command: process.execPath,
      args: [
        '-e',
        "setTimeout(()=>console.log('HELIX_READY'),100); process.stdin.on('data', d=>{if(d.toString().includes('ping')){console.log('HELIX_PONG');setTimeout(()=>process.exit(7),100)}})",
      ],
      cwd: root,
    });
    const attachment = await host.attach(id, (message) => messages.push(message));
    attachment.resize(100, 35);
    const text = () =>
      messages
        .filter((m) => m.t === 'out')
        .map((m) => m.data)
        .join('');
    await until(() => text().includes('HELIX_READY'));
    await host.attach(id, (message) => second.push(message));
    expect(second[0]?.t).toBe('out');
    attachment.write('ping\r');
    await until(() => exited);
    expect(code).toBe(7);
    expect(text()).toContain('HELIX_PONG');
    expect(second.at(-1)).toEqual({ t: 'exit', code: 7 });
    await host.flush();
    expect(await readFile(join(root, 'terminals', 'real.log'), 'utf8')).toBe(text());
  }, 30_000);
  test('kills child and grandchild, not only the PTY parent', async () => {
    const childFile = join(root, 'child.cjs');
    const parentFile = join(root, 'parent.cjs');
    const pidFile = join(root, 'pids.json');
    await writeFile(
      childFile,
      "const {spawn}=require('node:child_process');const fs=require('node:fs');const p=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[2],JSON.stringify([process.pid,p.pid]));setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000);",
    );
    await writeFile(
      parentFile,
      "require('node:child_process').spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'inherit'});setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000);",
    );
    await host.spawn(id, {
      command: process.execPath,
      args: [parentFile, childFile, pidFile],
      cwd: root,
    });
    let pids: number[] = [];
    await until(async () => {
      try {
        pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
        return pids.length === 2;
      } catch {
        return false;
      }
    });
    for (const pid of pids) expect(await isAlive(pid)).toBe(true);
    await host.kill(id);
    await until(async () => (await Promise.all(pids.map(isAlive))).every((value) => !value));
    expect(host.list()).toEqual([]);
  }, 30_000);
  test('rotates real raw terminal output with a small threshold', async () => {
    host = new NodePtyHost({ dataDir: root, logMaxBytes: 128 });
    const messages: TerminalOutput[] = [];
    let exited = false;
    host.onExit(() => {
      exited = true;
    });
    await host.spawn(id, {
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write('abcdef'.repeat(100));setTimeout(()=>process.exit(0),100)",
      ],
      cwd: root,
    });
    await host.attach(id, (message) => messages.push(message));
    await until(() => exited);
    await host.flush();
    const all = Buffer.from(
      messages
        .filter((m) => m.t === 'out')
        .map((m) => m.data)
        .join(''),
    );
    const active = await readFile(join(root, 'terminals', 'real.log'));
    const rotated = await readFile(join(root, 'terminals', 'real.log.1'));
    expect(active.length).toBeLessThanOrEqual(128);
    expect(rotated.length).toBe(128);
    expect(Buffer.concat([rotated, active])).toEqual(
      all.subarray(all.length - rotated.length - active.length),
    );
  }, 30_000);
});
