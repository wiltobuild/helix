import { expect, test, vi } from 'vitest';
import { resolveExecutable, resolveTerminalCommand, type ExecutableOptions } from './index.js';

function windows(files: string[], env: NodeJS.ProcessEnv = {}): ExecutableOptions {
  return {
    platform: 'win32',
    cwd: 'C:\\work',
    env: { Path: 'C:\\shims;"C:\\native tools"', Pathext: '.CMD;.BAT;.COM;.EXE', ...env },
    isFile: (path) =>
      Promise.resolve(files.some((file) => file.toLowerCase() === path.toLowerCase())),
  };
}
test('prefers native executables over earlier PATH shims and PATHEXT ordering', async () => {
  const options = windows([
    'C:\\shims\\cli.cmd',
    'C:\\native tools\\cli.exe',
    'C:\\shims\\cli.com',
  ]);
  expect(await resolveExecutable('cli', options)).toBe('C:\\native tools\\cli.exe');
  expect(await resolveExecutable('cli.cmd', options)).toBe('C:\\shims\\cli.cmd');
  expect(
    await resolveExecutable('cli.exe', windows(['C:\\shims\\cli.exe'], { Pathext: '.CMD' })),
  ).toBe('C:\\shims\\cli.exe');
  expect(
    await resolveExecutable('cli', windows(['D:\\override\\cli.exe'], { PATH: 'D:\\override' })),
  ).toBe('D:\\override\\cli.exe');
});
test('uses PATHEXT, case-insensitive environment keys, cwd, and relative paths', async () => {
  expect(await resolveExecutable('cli', windows(['C:\\work\\cli.bat'], { Pathext: '.BAT' }))).toBe(
    'C:\\work\\cli.bat',
  );
  expect(await resolveExecutable('.\\bin\\cli', windows(['C:\\work\\bin\\cli.com']))).toBe(
    'C:\\work\\bin\\cli.com',
  );
  await expect(
    resolveExecutable('cli', windows(['C:\\shims\\cli.cmd'], { Pathext: '.EXE' })),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
test('absolute paths and non-Windows invocations pass through without filesystem probes', async () => {
  const isFile = vi.fn();
  expect(await resolveExecutable('D:\\tools\\cli.exe', { ...windows([]), isFile })).toBe(
    'D:\\tools\\cli.exe',
  );
  expect(await resolveTerminalCommand('cli', ['a & b'], { platform: 'linux', isFile })).toEqual({
    command: 'cli',
    args: ['a & b'],
  });
  expect(isFile).not.toHaveBeenCalled();
});
test('batch launches use a verbatim cmd line with delayed expansion disabled', async () => {
  const launch = await resolveTerminalCommand(
    'cli',
    ['a & b', '%PATH%', '!name!', '"quoted"', ''],
    windows(['C:\\shims\\cli.cmd'], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }),
  );
  expect(launch.command).toBe('C:\\Windows\\System32\\cmd.exe');
  expect(typeof launch.args).toBe('string');
  expect(launch.args).toContain('/d /s /v:off /c "');
  expect(launch.args).toContain('^^^&');
  expect(launch.args).toContain('^^^%PATH^^^%');
  expect(launch.args).toContain('^^^!name^^^!');
  await expect(
    resolveTerminalCommand('cli', ['line\nbreak'], windows(['C:\\shims\\cli.cmd'])),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
