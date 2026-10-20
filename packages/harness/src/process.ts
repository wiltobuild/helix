import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HelixError } from '@helix/contracts';
import type { HarnessOptions } from './options.js';

const jobProcesses = new WeakSet<ChildProcessWithoutNullStreams>();

/** Windows CRT quoting; the resulting string is passed directly to CreateProcess. */
function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

export function environment(options: HarnessOptions): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (process.platform === 'win32') {
      for (const existing of Object.keys(env)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
      }
    }
    env[key] = value;
  }
  return env;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

export async function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<string | undefined> {
  const explicit = isAbsolute(name) || /[/\\]/.test(name);
  const directories = explicit ? [''] : (envValue(env, 'PATH') ?? '').split(delimiter);
  const extensions =
    process.platform === 'win32' && !extname(name)
      ? (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = explicit
        ? resolve(cwd, name + extension)
        : resolve(cwd, directory.replace(/^"|"$/g, ''), name + extension);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        /* Keep searching PATH. */
      }
    }
  }
  return undefined;
}

/** A deliberately restricted batch boundary. Prompts and RPC payloads always use stdin. */
export function quoteCmdArgument(value: string): string {
  if (/["%!^\r\n\0]/.test(value)) {
    throw new HelixError(
      'INVALID_REQUEST',
      'Batch shim arguments cannot contain quotes, %, !, ^ or line breaks; use a native executable for these arguments.',
    );
  }
  return `"${value.replace(/(\\+)$/, '$1$1')}"`;
}

export function spawnExecutable(
  bin: string,
  args: string[],
  options: HarnessOptions,
  cwd = options.cwd ?? process.cwd(),
): ChildProcessWithoutNullStreams {
  const env = environment(options);
  const workingDirectory = resolve(cwd);
  const shared = {
    cwd: workingDirectory,
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
  };
  if (process.platform === 'win32') {
    let target = bin;
    let argumentsText = args.map(quoteWindowsArgument).join(' ');
    if (/\.(cmd|bat)$/i.test(bin)) {
      const command = [bin, ...args].map(quoteCmdArgument).join(' ');
      target = envValue(env, 'ComSpec') ?? 'cmd.exe';
      argumentsText = `/d /v:off /s /c "${command}"`;
    }
    const launch = Buffer.from(
      JSON.stringify({ bin: target, arguments: argumentsText, cwd: workingDirectory }),
    ).toString('base64');
    const powershell = join(
      envValue(process.env, 'SystemRoot') ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const child = spawn(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        fileURLToPath(new URL('./windows-job.ps1', import.meta.url)),
        '-Launch',
        launch,
      ],
      { ...shared, stdio: 'pipe' },
    );
    jobProcesses.add(child);
    return child;
  }
  return spawn(bin, args, { ...shared, stdio: 'pipe', shell: false });
}

export function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function killTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (hasExited(child)) return;
    // Closing the supervisor closes its unique job handle and kills descendants.
    // This uses libuv's retained handle instead of reopening by PID.
    if (jobProcesses.has(child) && child.kill('SIGKILL')) return;
    const taskkill = join(
      envValue(process.env, 'SystemRoot') ?? 'C:\\Windows',
      'System32',
      'taskkill.exe',
    );
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', (error) =>
        reject(new HelixError('INTERNAL_ERROR', 'Could not terminate process tree', String(error))),
      );
      killer.on('exit', (code) =>
        code === 0 || hasExited(child)
          ? resolve()
          : reject(new HelixError('INTERNAL_ERROR', 'taskkill could not terminate process tree')),
      );
    });
    return;
  }
  // Children share the detached process group, including children whose parent has exited.
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw new HelixError('INTERNAL_ERROR', 'Could not terminate process group', String(error));
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export async function probe(
  bin: string,
  args: string[],
  options: HarnessOptions,
): Promise<{ code: number | null; text: string }> {
  const child = spawnExecutable(bin, [...(options.extraArgs ?? []), ...args], options);
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      void killTree(child).catch(() => undefined);
      reject(new HelixError('HARNESS_UNAVAILABLE', 'Harness probe timed out'));
    }, options.requestTimeoutMs ?? 10_000);
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-64_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, text: output.trim() });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end();
  });
}
