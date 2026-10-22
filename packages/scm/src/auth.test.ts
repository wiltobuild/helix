import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resolveGitHubToken } from './auth.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
beforeEach(() => {
  vi.stubEnv('GH_TOKEN', '');
  vi.stubEnv('GITHUB_TOKEN', '');
  vi.mocked(spawn).mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

test('token precedence is explicit, GH_TOKEN, GITHUB_TOKEN', async () => {
  vi.stubEnv('GH_TOKEN', 'gh');
  vi.stubEnv('GITHUB_TOKEN', 'github');
  expect(await resolveGitHubToken('explicit')).toBe('explicit');
  expect(await resolveGitHubToken()).toBe('gh');
  vi.stubEnv('GH_TOKEN', '  ');
  expect(await resolveGitHubToken()).toBe('github');
  expect(spawn).not.toHaveBeenCalled();
});
test('gh token is spawned without a shell and trims CRLF', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  const token = resolveGitHubToken();
  child.stdout.write('  example-token\r\n');
  child.emit('close', 0);
  expect(await token).toBe('example-token');
  expect(spawn).toHaveBeenCalledWith(
    'gh',
    ['auth', 'token'],
    expect.objectContaining({ shell: false, windowsHide: true }),
  );
});
test.each(['error', 'close'])(
  'missing gh auth produces a typed actionable error (%s)',
  async (event) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    const token = resolveGitHubToken();
    child.emit(event, event === 'error' ? new Error('sensitive stderr') : 1);
    await expect(token).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(token).rejects.toThrow('gh auth login');
  },
);
