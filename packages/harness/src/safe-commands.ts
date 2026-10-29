import { isGitWriteCommand } from './git-policy.js';
import { insideWorktree } from './worktree-paths.js';
import path from 'node:path';

/**
 * Commands Helix approves without asking: reading files in the session worktree and running the
 * project's own scripts. Everything else (writes outside the worktree, new dependencies, network
 * tools, shell expansion, redirection) still goes to the user. Recognized by parsing only; nothing
 * here executes shell input.
 */
export function isSafeCommand(
  command: unknown,
  worktree: string,
  readRoots: readonly string[] = [],
  executionCwd = worktree,
): boolean {
  const script = unwrapShell(command);
  if (script === undefined || isGitWriteCommand(command) || isGitWriteCommand(script)) return false;
  // Allowed glue: `cd x && …`, a trailing stderr merge, and paging output through head/tail.
  const body = script
    .replace(/\s+2>&1\b/g, '')
    .replace(/\s*\|\s*(?:head|tail)(?:\s+-n)?(?:\s+-?\d+)?\s*$/, '')
    .trim();
  if (!body || /[\n\r;`$<>|]|(?<!&)&(?!&)/.test(body)) return false;
  const segments = body.split('&&').map((part) => tokenize(part.trim()));
  if (segments.some((tokens) => tokens === undefined || tokens.length === 0)) return false;
  let cwd = path.resolve(worktree, executionCwd);
  const roots = [worktree, ...readRoots];
  if (readRoots.length && !roots.some((root) => insideWorktree(root, [cwd]))) return false;
  return (segments as string[][]).every((tokens) => {
    if (!readRoots.length) return safeSegment(tokens, worktree);
    if (!safeReadSegment(tokens, cwd, roots, worktree)) return false;
    if (tokens[0]?.toLowerCase() === 'cd') cwd = path.resolve(cwd, nativePath(tokens[1]!));
    return true;
  });
}

/** Review mode never approves scripts, installs, permission expansion or write-capable flags. */
function safeReadSegment(
  tokens: string[],
  cwd: string,
  roots: readonly string[],
  scratch: string,
): boolean {
  const [head, ...args] = tokens;
  const name = head!.replace(/\.(?:exe|cmd)$/i, '').toLowerCase();
  const inside = (arg: string) => {
    const normalized = nativePath(arg);
    if (normalized.startsWith('~') || normalized.split('/').includes('..')) return false;
    return roots.some((root) => insideWorktree(root, [path.resolve(cwd, normalized)]));
  };
  if (name === 'cd') return args.length === 1 && inside(args[0]!);
  if (name === 'helix') {
    const rest = args.filter((arg) => arg !== '--json');
    return (
      rest.length === 5 &&
      rest[0] === 'review' &&
      rest[1] === 'submit' &&
      rest[3] === '--head' &&
      /^[\w.-]+$/.test(rest[4]!) &&
      insideWorktree(scratch, [path.resolve(cwd, nativePath(rest[2]!))])
    );
  }
  if (name === 'git') {
    const rest = [...args];
    if (rest[0] === '-C') {
      if (!rest[1] || !inside(rest[1])) return false;
      rest.splice(0, 2);
    }
    if (!GIT_READS.has(rest.shift() ?? '')) return false;
    // Git's output, pager and external diff options can write or execute arbitrary code.
    if (
      rest.some((arg) =>
        /^--(?:output|ext-diff|textconv|exec|open-files-in-pager)(?:=|$)/.test(arg),
      )
    )
      return false;
    return rest.every((arg) => arg.startsWith('-') || inside(arg));
  }
  if (!READ_ONLY.has(name)) return false;
  if (
    args.some((arg) =>
      /^-(?:exec|execdir|ok|okdir|delete|fprint|fls)|^--(?:pre|hostname-bin)(?:=|$)/.test(arg),
    )
  )
    return false;
  return args.every((arg) => arg.startsWith('-') || inside(arg));
}

const SHELL = /^(?:.*[/\\])?(?:ba?sh|sh|zsh|powershell|pwsh)(?:\.exe)?$/i;
const SCRIPT_FLAG = /^(?:-c|-lc|-command)$/i;

/** The script a shell wrapper runs (`powershell -NoProfile -Command '…'`, `bash -lc '…'`). */
function unwrapShell(command: unknown): string | undefined {
  const argv = Array.isArray(command)
    ? command.every((part) => typeof part === 'string')
      ? command
      : undefined
    : typeof command === 'string'
      ? tokenize(command.trim())
      : undefined;
  if (!argv?.length) return undefined;
  if (!SHELL.test(argv[0]!)) return Array.isArray(command) ? argv.join(' ') : (command as string);
  const flag = argv.findIndex((part) => SCRIPT_FLAG.test(part));
  const rest = argv.slice(1, flag);
  if (flag === -1 || flag !== argv.length - 2 || rest.some((part) => !/^-noprofile$/i.test(part)))
    return undefined;
  return argv[flag + 1];
}

/** Whitespace split that honors single and double quotes; undefined on unbalanced quotes. */
function tokenize(text: string): string[] | undefined {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s"']+)|(["'])/g;
  let current: string | undefined;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[4]) return undefined;
    const piece = m[1] ?? m[2] ?? m[3] ?? '';
    const joined = m.index === last && current !== undefined;
    if (joined) current += piece;
    else {
      if (current !== undefined) tokens.push(current);
      current = piece;
    }
    last = re.lastIndex;
  }
  if (current !== undefined) tokens.push(current);
  return tokens;
}

const READ_ONLY = new Set([
  'ls',
  'dir',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'echo',
  'which',
  'where',
  'grep',
  'rg',
  'find',
  'tree',
  'get-childitem',
  'gci',
  'get-content',
  'gc',
  'select-string',
  'get-location',
]);
const GIT_READS = new Set(['status', 'diff', 'log', 'show']);
const DEV_TOOLS = new Set(['prettier', 'vitest', 'tsc', 'eslint', 'jest']);
const HELIX = new Set(['explain', 'plan', 'status']);

function safeSegment(tokens: string[], worktree: string): boolean {
  const [head, ...args] = tokens;
  const name = head!
    .replace(/^.*[/\\]/, '')
    .replace(/\.(?:exe|cmd)$/i, '')
    .toLowerCase();
  const paths = () => args.every((arg) => arg.startsWith('-') || insidePath(arg, worktree));
  if (name === 'cd') return args.length === 1 && insidePath(args[0]!, worktree);
  if (READ_ONLY.has(name)) {
    if (
      name === 'find' &&
      args.some((arg) => /^-(?:exec|execdir|ok|okdir|delete|fprint)/.test(arg))
    )
      return false;
    return paths();
  }
  if (name === 'git') return GIT_READS.has(args[0] ?? '') && paths();
  if (
    (name === 'node' || name === 'npm' || name === 'pnpm') &&
    /^(?:--version|-v)$/.test(args[0] ?? '')
  )
    return args.length === 1;
  if (name === 'npm' || name === 'pnpm') {
    const [sub, ...rest] = args;
    if (sub === 'ci' || sub === 'install' || sub === 'i')
      return rest.every((arg) => arg.startsWith('-')); // No new packages.
    if (sub === 'test' || sub === 't') return true;
    if (sub === 'run' || sub === 'run-script') return /^[\w:.-]+$/.test(rest[0] ?? '');
    return false;
  }
  if (name === 'npx') return DEV_TOOLS.has(args[0] ?? '') && paths();
  if (name === 'helix') return HELIX.has(args[0] === '--json' ? (args[1] ?? '') : (args[0] ?? ''));
  return false;
}

/**
 * Relative paths without `..`, or absolute paths inside the worktree, resolved through symlinks
 * and junctions. `~` and anything elsewhere fail closed.
 */
function insidePath(arg: string, worktree: string): boolean {
  const posix = arg.replace(/\\/g, '/');
  if (posix.startsWith('~') || posix.split('/').includes('..')) return false;
  // Git Bash spells C:\x as /c/x.
  return insideWorktree(worktree, [nativePath(posix)]);
}

function nativePath(value: string): string {
  const posix = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? posix.replace(/^\/([A-Za-z])\//, '$1:/') : posix;
}
