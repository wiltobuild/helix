export const HELIX_GIT_INSTRUCTIONS =
  'Helix manages git for this task. Edit files only; do not run git add/commit/push or create branches. Helix commits your changes when your turn ends.';

const writes = new Set([
  'add',
  'commit',
  'push',
  'merge',
  'rebase',
  'reset',
  'restore',
  'cherry-pick',
  'revert',
  'stash',
  'clean',
  'am',
  'apply',
  'update-index',
  'update-ref',
  'symbolic-ref',
  'fetch',
  'pull',
  'init',
  'clone',
  'gc',
  'prune',
]);
const shells = /^(?:.*[/\\])?(?:ba?sh|zsh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/i;
const git = /^(?:.*[/\\])?git(?:\.exe)?$/i;
const separator = /^[\n;&|(){}]$/;

/** Recognize ordinary Git invocations and shell wrappers, without executing shell input. */
export function isGitWriteCommand(command: unknown): boolean {
  const tokens = Array.isArray(command)
    ? command.filter((part): part is string => typeof part === 'string')
    : typeof command === 'string'
      ? (command.match(/"[^"]*"|'[^']*'|[^\s;&|(){}]+|[\n;&|(){}]/g) ?? []).map((part) =>
          /^['"]/.test(part) ? part.slice(1, -1) : part,
        )
      : [];
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (separator.test(token)) {
      start = i + 1;
      continue;
    }
    const prefix = tokens.slice(start, i);
    const executable =
      prefix.every((part) => /^[A-Za-z_][A-Za-z_0-9]*=/.test(part)) ||
      ['env', 'sudo', 'command', 'exec'].includes(prefix[0] ?? '');
    if (!executable) continue;
    if (shells.test(token)) {
      for (let j = i + 1; j < tokens.length && !separator.test(tokens[j]!); j++) {
        if (/^(?:-c|-lc|-command|\/c)$/i.test(tokens[j]!) && isGitWriteCommand(tokens[j + 1]))
          return true;
      }
    }
    if (!git.test(token)) continue;
    let j = i + 1;
    while (tokens[j]?.startsWith('-')) {
      if (
        ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(tokens[j]!)
      )
        j++;
      j++;
    }
    const subcommand = tokens[j]?.toLowerCase();
    const end = tokens.findIndex((part, index) => index > j && separator.test(part));
    const args = tokens.slice(j + 1, end < 0 ? undefined : end);
    if (subcommand && writes.has(subcommand)) return true;
    if (subcommand === 'checkout' || subcommand === 'switch') return true;
    if (subcommand === 'branch') {
      if (args.includes('--list') || args.includes('-l')) continue;
      if (
        args.some(
          (arg) => !['--list', '-l', '-a', '-r', '-v', '-vv', '--show-current'].includes(arg),
        )
      )
        return true;
    }
    if (
      subcommand === 'tag' &&
      args.length &&
      !args.some((arg) => ['--list', '-l', '-v', '--verify'].includes(arg))
    )
      return true;
    if (subcommand === 'worktree' && args[0] !== 'list') return true;
    if (
      subcommand === 'remote' &&
      ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'prune', 'update'].includes(
        args[0] ?? '',
      )
    )
      return true;
    if (subcommand === 'reflog' && ['delete', 'expire', 'drop', 'write'].includes(args[0] ?? ''))
      return true;
    if (
      subcommand === 'config' &&
      args.length &&
      !args.some((arg) =>
        /^(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l|--show-origin|--show-scope|get|list)$/.test(
          arg,
        ),
      )
    )
      return true;
  }
  return false;
}
