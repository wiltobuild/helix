import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  HelixError,
  sessionIdSchema,
  terminalOutputSchema,
  type TerminalOutput,
} from '@helix/contracts';
import { NodePtyHost, type PtyProcess } from './index.js';
import { tailUtf8 } from './log.js';

class FakePty implements PtyProcess {
  pid = 12345;
  data = new Set<(data: string) => unknown>();
  exits = new Set<(event: { exitCode: number }) => unknown>();
  write = vi.fn<(data: string | Buffer) => void>();
  resize = vi.fn<(cols: number, rows: number) => void>();
  pause = vi.fn();
  resume = vi.fn();
  kill = vi.fn(() => this.exit(0));
  onData: PtyProcess['onData'] = (cb) => {
    this.data.add(cb);
    return {
      dispose: () => {
        this.data.delete(cb);
      },
    };
  };
  onExit: PtyProcess['onExit'] = (cb) => {
    this.exits.add(cb);
    return {
      dispose: () => {
        this.exits.delete(cb);
      },
    };
  };
  output(data: string) {
    for (const cb of this.data) cb(data);
  }
  exit(exitCode: number) {
    for (const cb of this.exits) cb({ exitCode });
  }
}
const id = sessionIdSchema.parse('test');
const options = { command: 'node', args: ['-e', 'script'], cwd: process.cwd() };
let root: string;
let host: NodePtyHost;
let pty: FakePty;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'helix-pty-unit-'));
  pty = new FakePty();
  host = new NodePtyHost({ dataDir: root, spawnPty: () => pty, killTree: () => Promise.resolve() });
});
afterEach(async () => {
  await host.close();
  const target = resolve(root);
  if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
  await rm(target, { recursive: true, force: true });
});
test('resizes before output and writes input without stripping ANSI', async () => {
  const spawn = vi.fn(() => pty);
  host = new NodePtyHost({ dataDir: root, spawnPty: spawn, killTree: () => Promise.resolve() });
  await host.spawn(id, { ...options, env: { HELIX_TEST: 'yes' }, cols: 90, rows: 30 });
  expect(spawn).toHaveBeenCalledWith(
    'node',
    ['-e', 'script'],
    expect.objectContaining({
      cols: 90,
      rows: 30,
      env: expect.objectContaining({ HELIX_TEST: 'yes' }) as unknown,
    }),
  );
  const output: TerminalOutput[] = [];
  const attachment = await host.attach(id, (message) =>
    output.push(terminalOutputSchema.parse(message)),
  );
  attachment.resize(120, 40);
  attachment.write('\x1b[Ahello\r');
  expect(pty.resize).toHaveBeenCalledWith(120, 40);
  expect(pty.write).toHaveBeenCalledWith('\x1b[Ahello\r');
  pty.output('\x1b[31mred\x1b[0m\r\n');
  expect(output).toEqual([{ t: 'out', data: '\x1b[31mred\x1b[0m\r\n' }]);
  expect(() => attachment.resize(0, 10)).toThrow(HelixError);
  await host.flush();
  expect(await readFile(join(root, 'terminals', 'test.log'), 'utf8')).toBe(
    '\x1b[31mred\x1b[0m\r\n',
  );
});
test('replays before live data even with reentrant output and multiple attachers', async () => {
  await host.spawn(id, options);
  pty.output('history');
  const first: TerminalOutput[] = [];
  const second: TerminalOutput[] = [];
  const a = await host.attach(id, (message) => {
    first.push(message);
    if (message.t === 'out' && message.data === 'history') pty.output('during replay');
  });
  const b = await host.attach(id, (message) => second.push(message));
  pty.output('live');
  a.detach();
  pty.output('only second');
  expect(first).toEqual([
    { t: 'out', data: 'history' },
    { t: 'out', data: 'during replay' },
    { t: 'out', data: 'live' },
  ]);
  expect(second).toEqual([
    { t: 'out', data: 'historyduring replay' },
    { t: 'out', data: 'live' },
    { t: 'out', data: 'only second' },
  ]);
  b.detach();
  expect(() => a.write('no')).toThrow(HelixError);
});
test('exit callback and replay retain exit code, list contains only live terminals', async () => {
  const exit = vi.fn();
  const unsubscribe = host.onExit(exit);
  await host.spawn(id, options);
  expect(host.list()).toEqual([id]);
  const messages: TerminalOutput[] = [];
  await host.attach(id, (message) => messages.push(message));
  pty.output('done');
  pty.exit(17);
  pty.exit(18);
  expect(exit).toHaveBeenCalledExactlyOnceWith(id, 17);
  expect(host.list()).toEqual([]);
  const late: TerminalOutput[] = [];
  await host.attach(id, (message) => late.push(message));
  expect(late).toEqual([
    { t: 'out', data: 'done' },
    { t: 'exit', code: 17 },
  ]);
  expect(messages).toEqual(late);
  unsubscribe();
  await host.kill(id);
});
test('caps UTF-8 scrollback in bytes and rotates oversized chunks exactly', async () => {
  host = new NodePtyHost({
    dataDir: root,
    scrollbackBytes: 7,
    logMaxBytes: 10,
    spawnPty: () => pty,
    killTree: () => Promise.resolve(),
  });
  await host.spawn(id, options);
  pty.output('0123456789abcdefghijXYZ');
  await host.flush();
  expect(await readFile(join(root, 'terminals', 'test.log.1'), 'utf8')).toBe('abcdefghij');
  expect(await readFile(join(root, 'terminals', 'test.log'), 'utf8')).toBe('XYZ');
  pty.output('😀😀');
  const messages: TerminalOutput[] = [];
  await host.attach(id, (message) => messages.push(message));
  expect(messages).toEqual([{ t: 'out', data: '😀' }]);
  expect(pty.pause).toHaveBeenCalled();
  await host.flush();
  expect(pty.resume).toHaveBeenCalled();
  expect(tailUtf8(Buffer.from('a😀b'), 5).toString()).toBe('😀b');
});
test('kill awaits tree teardown before native handle cleanup and is idempotent', async () => {
  const order: string[] = [];
  const killTree = vi.fn(() => {
    order.push('tree');
    return Promise.resolve();
  });
  pty.kill = vi.fn(() => {
    order.push('pty');
    pty.exit(0);
  });
  host = new NodePtyHost({ dataDir: root, spawnPty: () => pty, killTree });
  await host.spawn(id, options);
  await Promise.all([host.kill(id), host.kill(id)]);
  expect(order).toEqual(['tree', 'pty']);
  expect(killTree).toHaveBeenCalledExactlyOnceWith(12345);
});
test('rejects duplicate, invalid and unknown sessions using HelixError', async () => {
  await expect(host.attach(id, () => undefined)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(host.kill(id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(host.spawn(sessionIdSchema.parse('../escape'), options)).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  });
  await expect(host.spawn(id, { ...options, cols: -1 })).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  });
  const spawning = host.spawn(id, options);
  await expect(host.spawn(id, options)).rejects.toMatchObject({ code: 'CONFLICT' });
  await spawning;
});
test('isolates throwing listeners and releases failed spawn reservation', async () => {
  const errors = vi.fn();
  const spawnPty = vi.fn(() => {
    throw new Error('bad executable');
  });
  const failing = new NodePtyHost({ dataDir: root, spawnPty });
  await expect(failing.spawn(id, options)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  await expect(failing.spawn(id, options)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  expect(spawnPty).toHaveBeenCalledTimes(2);
  host = new NodePtyHost({
    dataDir: root,
    spawnPty: () => pty,
    killTree: () => Promise.resolve(),
    onError: errors,
  });
  await host.spawn(id, options);
  await host.attach(id, () => {
    throw new Error('observer');
  });
  const received: TerminalOutput[] = [];
  await host.attach(id, (message) => received.push(message));
  pty.output('still delivered');
  expect(received).toHaveLength(1);
  expect(errors).toHaveBeenCalledTimes(1);
});
