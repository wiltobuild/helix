import { stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { HelixError } from '@helix/contracts';

export interface ExecutableOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seams for Windows resolution on every CI platform. */
  platform?: NodeJS.Platform;
  isFile?: (path: string) => Promise<boolean>;
}

function environment(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).findLast(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/** Windows PATH/PATHEXT lookup; explicit absolute paths and non-Windows pass through. */
export async function resolveExecutable(
  command: string,
  options: ExecutableOptions = {},
): Promise<string> {
  if ((options.platform ?? process.platform) !== 'win32' || win32.isAbsolute(command))
    return command;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const isFile =
    options.isFile ??
    (async (path: string) => {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    });
  const extensions = [
    ...new Set(
      (environment(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((value) => value.toLowerCase())
        .filter((value) => /^\.[a-z0-9]+$/.test(value)),
    ),
  ];
  // Prefer a native executable across PATH over a batch shim of the same name.
  const ordered = [
    '.exe',
    '.com',
    ...extensions.filter((ext) => ext !== '.exe' && ext !== '.com'),
  ].filter((ext) => extensions.includes(ext));
  const directories = /[\\/]/.test(command)
    ? [cwd]
    : [cwd, ...(environment(env, 'PATH') ?? '').split(';')];
  const suffixes = win32.extname(command) ? ['', ...ordered] : ordered;
  for (const suffix of suffixes) {
    for (const directory of directories) {
      const candidate = win32.resolve(cwd, directory.replace(/^"(.*)"$/, '$1'), command + suffix);
      if (await isFile(candidate)) return candidate;
    }
  }
  throw new HelixError('NOT_FOUND', `Terminal executable not found on PATH: ${command}`);
}

const meta = /[()[\]%!^"`<>&|;, *?]/g;
function escapeMeta(value: string): string {
  return value.replace(meta, '^$&');
}

function shimArgument(value: string): string {
  // First encode a native Windows argv element (backslashes before quotes/end).
  let quoted = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === '\\') {
      slashes++;
      continue;
    }
    quoted += '\\'.repeat(character === '"' ? 2 * slashes + 1 : slashes) + character;
    slashes = 0;
  }
  quoted += '\\'.repeat(2 * slashes) + '"';
  // Two cmd parsing passes: /c invocation, then the shim's %* forwarding.
  return escapeMeta(escapeMeta(quoted));
}

export interface TerminalCommand {
  command: string;
  args: string[] | string;
}

/** String args are a verbatim node-pty Windows command line, not an argv array. */
export async function resolveTerminalCommand(
  command: string,
  args: string[],
  options: ExecutableOptions = {},
): Promise<TerminalCommand> {
  const executable = await resolveExecutable(command, options);
  if ((options.platform ?? process.platform) !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) {
    return { command: executable, args };
  }
  if ([executable, ...args].some((value) => /[\0\r\n]/.test(value))) {
    throw new HelixError(
      'INVALID_REQUEST',
      'Windows batch arguments cannot contain NUL or line breaks.',
    );
  }
  const env = options.env ?? process.env;
  return {
    command:
      environment(env, 'ComSpec') ??
      win32.join(environment(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    args: `/d /s /v:off /c "${[escapeMeta(executable), ...args.map(shimArgument)].join(' ')}"`,
  };
}
