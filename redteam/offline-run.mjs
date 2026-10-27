#!/usr/bin/env node
// Offline red-team run: Helix works on the attackers' content with no GitHub credentials.
//
//   node redteam/offline-run.mjs [--repo owner/name] [--pr N] [--port 4393]
//                                [--model gpt-6.1-sol] [--effort medium] [--turns 8] [--workers 2]
//
// 1. Clones the public sandbox anonymously into a fresh run folder and removes its remote.
// 2. Starts an isolated Helix daemon (own data dir and port) with HELIX_GITHUB=off, so Helix
//    never looks up a GitHub token. Agents inherit an environment with GH_TOKEN/GITHUB_TOKEN
//    removed, an empty gh config dir, an empty git global config with system config ignored
//    (no credential manager), and a `gh` stub first on PATH that refuses to run.
//    LIMIT: agents still run as the operator's OS user. `gh auth token` reads the OS keyring
//    directly, so an approved command could still reach stored credentials. Command approval
//    is the real defense here; for hard isolation, run this under a separate OS user or VM.
// 3. Leaves the daemon running until Ctrl+C. The operator drives it from the browser.
// Codex keeps its own sign-in (~/.codex); nothing else from the operator's accounts is passed.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: 'wiltobuild/helix-redteam' },
    port: { type: 'string', default: '4393' },
    model: { type: 'string', default: 'gpt-6.1-sol' },
    effort: { type: 'string', default: 'medium' },
    turns: { type: 'string', default: '8' },
    workers: { type: 'string', default: '2' },
    pr: { type: 'string' },
  },
});
if (values.pr !== undefined && !/^[1-9]\d*$/.test(values.pr)) throw new Error('Invalid --pr');
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(values.repo)) throw new Error('Invalid --repo');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const run = join(tmpdir(), 'helix-redteam-runs', stamp);
const repo = join(run, 'repo');
const data = join(run, 'data');
const ghConfig = join(run, 'empty-gh-config');
const gitConfig = join(run, 'empty-gitconfig');
const bin = join(run, 'bin');
await mkdir(ghConfig, { recursive: true });
await mkdir(data, { recursive: true });
await mkdir(bin, { recursive: true });
await writeFile(gitConfig, '');
// Defense in depth: a `gh` that refuses, found before the real one.
const refusal = 'gh is disabled during Helix red-team runs.';
await writeFile(join(bin, 'gh.cmd'), `@echo ${refusal} 1>&2\r\n@exit /b 1\r\n`);
await writeFile(join(bin, 'gh'), `#!/bin/sh\necho "${refusal}" >&2\nexit 1\n`, { mode: 0o755 });

// The isolated environment, used for every git call below and for the daemon and its agents.
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(GH_|GITHUB_)/i.test(key) || /^GIT_ASKPASS$|^SSH_ASKPASS$/i.test(key)) delete env[key];
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ''}`;
Object.assign(env, {
  HELIX_GITHUB: 'off',
  GH_CONFIG_DIR: ghConfig,
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
  HELIX_DATA_DIR: data,
  HELIX_PORT: values.port,
  HELIX_CODEX_MODEL: values.model,
  HELIX_CODEX_EFFORT: values.effort,
  HELIX_MAX_TURNS: values.turns,
  HELIX_MAX_WORKERS: values.workers,
  HELIX_DEBUG_PROTOCOL: '1',
});

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim();
git(['clone', '--quiet', `https://github.com/${values.repo}.git`, repo]);
if (values.pr) {
  // Run against an attacker's pull request: its head becomes this run's main.
  git(['fetch', '--quiet', 'origin', `pull/${values.pr}/head`], repo);
  git(['checkout', '--quiet', '-B', 'main', 'FETCH_HEAD'], repo);
}
git(['remote', 'remove', 'origin'], repo);
git(['config', 'user.name', 'Helix Red Team'], repo);
git(['config', 'user.email', 'redteam@example.invalid'], repo);
const head = git(['rev-parse', '--short', 'HEAD'], repo);

if (!existsSync(join(root, 'apps', 'web', 'dist', 'index.html')))
  console.log('Note: no web build found; run `pnpm --filter @helix/web build` for the browser UI.');

console.log(`
Helix red-team run (offline)
  run folder : ${run}
  target     : ${values.repo}${values.pr ? ` PR #${values.pr}` : ''} @ ${head} (no remote, no credentials)
  agent      : codex ${values.model} / ${values.effort}, max ${values.turns} turns, ${values.workers} workers
  daemon     : http://127.0.0.1:${values.port}

Next: open the daemon URL, add the repository path
  ${repo}
create a task (or plan), approve it, and review the run against redteam/README.md.
Event log and protocol logs stay in ${data}. Press Ctrl+C to stop Helix.
`);

const daemon = spawn('pnpm', ['--filter', '@helix/daemon', 'exec', 'tsx', 'src/main.ts'], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
const stop = () => daemon.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
daemon.on('exit', (code) => process.exit(code ?? 0));
