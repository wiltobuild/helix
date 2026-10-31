import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HelixError } from '@helix/contracts';
import type { HarnessOptions } from './options.js';

const jobProcesses = new WeakSet<ChildProcessWithoutNullStreams>();
const liveProcesses = new Set<ChildProcessWithoutNullStreams>();
let exitHookInstalled = false;

/**
 * Synchronously kills every agent process tree this process started and has not seen exit.
 * Runs from the `exit` hook so an abrupt daemon exit cannot orphan agents. Windows agents run
 * inside a kill-on-close job owned by their supervisor, so killing the supervisor is enough.
 */
export function killLiveProcesses(): void {
  for (const child of liveProcesses) {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* Already gone. */
    }
  }
  liveProcesses.clear();
}

function track(child: ChildProcessWithoutNullStreams): void {
  liveProcesses.add(child);
  child.once('close', () => liveProcesses.delete(child));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', killLiveProcesses);
}

/** Windows CRT quoting; the resulting string is passed directly to CreateProcess. */
function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

export function environment(
  options: HarnessOptions,
  additions?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = options.inheritEnv === false ? {} : { ...process.env };
  for (const [key, value] of [
    ...Object.entries(options.env ?? {}),
    ...Object.entries(additions ?? {}),
  ]) {
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

const supervisorScript = () => fileURLToPath(new URL('./windows-job.ps1', import.meta.url));
const powershellPath = () =>
  join(
    envValue(process.env, 'SystemRoot') ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

export type SupervisorAssembly = { assembly: string; sha256: string };
type SupervisorCache = {
  ready?: SupervisorAssembly;
  pending?: Promise<SupervisorAssembly | undefined>;
};
const supervisorCaches = new Map<string, SupervisorCache>();
const supervisorDir = (dataDir: string) => join(resolve(dataDir), 'cache', 'windows-job');

/**
 * Compiles the Windows supervisor assembly once per process into <dataDir>/cache/windows-job
 * (outside every agent worktree) and records its SHA-256 **in memory**. The supervisor runs
 * outside the agent's sandbox, so it only loads an assembly whose bytes match this hash; a file
 * left on disk by an earlier process is never trusted (#36). Resolves undefined when caching is
 * unavailable, in which case every launch compiles in memory.
 */
export function prepareSupervisorAssembly(
  dataDir: string | undefined,
): Promise<SupervisorAssembly | undefined> {
  if (process.platform !== 'win32' || !dataDir) return Promise.resolve(undefined);
  const dir = supervisorDir(dataDir);
  const cache = supervisorCaches.get(dir) ?? {};
  supervisorCaches.set(dir, cache);
  if (cache.ready) return Promise.resolve(cache.ready);
  cache.pending ??= (async () => {
    try {
      await mkdir(dir, { recursive: true });
      // Earlier compiles are never trusted; remove them best effort (loading holds no lock).
      for (const name of await readdir(dir))
        if (/^HelixProcessJob-.*\.dll$/i.test(name))
          await rm(join(dir, name), { force: true }).catch(() => undefined);
      const assembly = join(dir, `HelixProcessJob-${randomUUID()}.dll`);
      await new Promise<void>((done, fail) => {
        const child = spawn(
          powershellPath(),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            supervisorScript(),
            '-CompileTo',
            assembly,
          ],
          { windowsHide: true, stdio: 'ignore' },
        );
        child.once('error', fail);
        child.once('close', (code) =>
          code === 0 ? done() : fail(new Error(`Supervisor compile exited ${code}`)),
        );
      });
      const sha256 = createHash('sha256')
        .update(await readFile(assembly))
        .digest('hex');
      cache.ready = { assembly, sha256 };
      return cache.ready;
    } catch {
      // A later launch may try again; until then launches compile in memory.
      delete cache.pending;
      return undefined;
    }
  })();
  return cache.pending;
}

/** The verified assembly if it is ready; otherwise starts preparing it and returns undefined. */
function readySupervisorAssembly(dataDir: string | undefined): SupervisorAssembly | undefined {
  if (process.platform !== 'win32' || !dataDir) return undefined;
  const ready = supervisorCaches.get(supervisorDir(dataDir))?.ready;
  if (!ready) void prepareSupervisorAssembly(dataDir);
  return ready;
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
    const prepared = readySupervisorAssembly(options.dataDir);
    const launch = Buffer.from(
      JSON.stringify({
        bin: target,
        arguments: argumentsText,
        cwd: workingDirectory,
        ...(prepared ?? {}),
      }),
    ).toString('base64');
    const child = spawn(
      powershellPath(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        supervisorScript(),
        '-Launch',
        launch,
      ],
      { ...shared, stdio: 'pipe' },
    );
    jobProcesses.add(child);
    track(child);
    return child;
  }
  const child = spawn(bin, args, { ...shared, stdio: 'pipe', shell: false });
  track(child);
  return child;
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
      const cleaned = output.replace(/\[Helix process [^\]]+\] [^\r\n]+\r?\n?/g, '');
      resolve({ code, text: cleaned.trim() });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end();
  });
}
