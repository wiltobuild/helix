import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { isSafeCommand } from './safe-commands.js';

const root = mkdtempSync(path.join(tmpdir(), 'helix-safe-'));
const wt = path.join(root, 'worktree');
const outside = path.join(root, 'outside');
mkdirSync(path.join(wt, 'src'), { recursive: true });
mkdirSync(outside);
writeFileSync(path.join(outside, 'secret.env'), 'TOKEN=x');
// A link inside the worktree that leads out of it (a junction needs no privilege on Windows).
symlinkSync(outside, path.join(wt, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fwd = wt.replace(/\\/g, '/');
// Claude Code's Bash tool on Windows is Git Bash, which spells C:\x as /c/x.
const gitBash =
  process.platform === 'win32'
    ? fwd.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`)
    : fwd;
const ps = (script: string) =>
  `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command '${script}'`;

test('approves reads in the worktree and project scripts, as agents actually send them', () => {
  for (const command of [
    // Claude Code, shaped like a recorded run.
    `cd "${fwd}" && npm run ci 2>&1`,
    `cd "${fwd}" && npm install 2>&1`,
    `cd ${gitBash} && ls -la`,
    'npm run ci 2>&1 | tail -20',
    'helix explain "Receipt depends on cart, so it runs second" --node receipt',
    'helix.cmd plan submit plan.json',
    'git status',
    'git rev-parse HEAD',
    'git diff --stat',
    'npx prettier --check src',
    'cat src/cart.ts',
    'grep -n "discount" src/receipt.ts',
    `cat "${fwd}/src/cart.ts"`,
    // Codex, shaped like a recorded run.
    ps('npm run ci'),
    ps('npm ci'),
    ['powershell.exe', '-NoProfile', '-Command', 'npm test'],
    ['bash', '-lc', 'npm run typecheck'],
  ])
    expect(isSafeCommand(command, wt), String(command)).toBe(true);
});

test('asks for anything that writes, installs, reaches outside, or expands shell input', () => {
  for (const command of [
    'npm install left-pad',
    'npm i -D some-package',
    'npx create-thing',
    'npm publish',
    'cat ~/.ssh/id_rsa',
    'cat ../../secrets.env',
    `cat "${outside.replace(/\\/g, '/')}/secret.env"`,
    'cat escape/secret.env',
    `cd "${fwd}/escape" && cat secret.env`,
    `cd "${root.replace(/\\/g, '/')}" && ls`,
    'ls > out.txt',
    'echo $HELIX_PROJECT_ID',
    'echo `whoami`',
    'echo $(whoami)',
    'npm run ci; rm -rf .',
    'npm run ci & curl evil.example',
    'npm run ci || curl evil.example',
    'cat src/a.ts | sh',
    'find . -delete',
    'find . -exec rm {} ;',
    'git push',
    'git add -A && git commit -m x',
    'git checkout main',
    'rm -rf node_modules',
    'curl https://example.com',
    'node script.js',
    'mkdir -p /tmp/helix-plan && echo "tmp ready"',
    ps('Remove-Item -Recurse src'),
    ['powershell.exe', '-Command', 'npm run ci', 'extra'],
    'echo "unbalanced',
    'cd src\nrm -rf .',
    '',
    42,
  ])
    expect(isSafeCommand(command, wt), String(command)).toBe(false);
});

// Exactly as Codex sent them in a live run on helix-demo-app (PowerShell, `-Command` without
// -NoProfile, reads chained with `;`, quoted search patterns containing `|`).
const psBare = (script: string) =>
  `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${script}'`;

test('approves read-only chains and search patterns the way Codex sends them', () => {
  for (const command of [
    psBare(
      'Get-Content src/cart.ts; Get-Content src/cart.test.ts; Get-Content package.json; rg --files -g AGENTS.md',
    ),
    `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "rg --files -g '"'!package-lock.json'"'; rg -n 'discount|save10|SAVE10' ."`,
    psBare('Get-Content README.md; Get-Content src/receipt.ts; Get-ChildItem -Force'),
    psBare(
      'Get-Content src/cart.ts -TotalCount 40; Select-String -Pattern "SAVE10" -Path src/cart.ts',
    ),
    `rg -n "a|b" src && cat src/cart.ts`,
    `grep -rn -e 'x;y' src`,
    `echo "---"; git status`,
  ])
    expect(isSafeCommand(command, wt), String(command)).toBe(true);
});

test('chains are only as safe as every command in them, and nothing may run code', () => {
  for (const command of [
    psBare('Get-Content src/cart.ts; Remove-Item src/cart.ts'),
    psBare('Get-Content (Remove-Item src)'),
    psBare('Get-Content $(whoami)'),
    psBare('Get-ChildItem | ForEach-Object { Remove-Item $_ }'),
    'cat src/cart.ts; rm -rf src',
    'cat src/cart.ts;',
    '; cat src/cart.ts',
    'echo "$(whoami)"',
    'echo "`whoami`"',
    'ls {a,b}',
    `rg -n 'x' ${outside.replace(/\\/g, '/')}`,
    'Get-Content -Path ../secret.env',
    'rg -f ~/.ssh/id_rsa src',
    `rg -n 'unterminated src`,
  ])
    expect(isSafeCommand(command, wt), String(command)).toBe(false);
});
