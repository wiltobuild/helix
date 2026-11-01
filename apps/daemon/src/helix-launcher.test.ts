import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { fixtures, sessionIdSchema } from '@helix/contracts';
import {
  GIT_BASH_SHIM,
  launcherContents,
  orchestratorScratch,
  sessionEnvironment,
} from './helix-launcher.js';
import { createRealCore } from './real-core.js';
import { startDaemon } from './lifecycle.js';

const exec = promisify(execFile);
const projectEvent = fixtures.passwordResetRun.find((e) => e.type === 'project.added')!;
const sessionEvent = fixtures.passwordResetRun.find((e) => e.type === 'session.created')!;
if (projectEvent.type !== 'project.added' || sessionEvent.type !== 'session.created')
  throw new Error('Missing fixture');
const project = projectEvent.payload.project;
const session = sessionEvent.payload.session;

test('orchestrators and reviewers receive CLI discovery, identity and a prepended PATH', () => {
  const dataDir = join(tmpdir(), 'helix data');
  const base = process.platform === 'win32' ? { Path: 'base-path' } : { PATH: 'base-path' };
  const env = sessionEnvironment(dataDir, base);
  const shared = {
    HELIX_DATA_DIR: dataDir,
    HELIX_SESSION_ID: session.id,
    HELIX_PROJECT_ID: project.id,
    PATH: join(dataDir, 'bin') + delimiter + 'base-path',
  };
  // Orchestrators also get a scratch folder for their plan artifact, created on demand.
  const scratch = orchestratorScratch(dataDir, session);
  expect(scratch.startsWith(join(tmpdir(), 'helix-plan-scratch-'))).toBe(true);
  expect(scratch.startsWith(dataDir + sep)).toBe(false);
  const unsafeIdScratch = orchestratorScratch(dataDir, {
    id: sessionIdSchema.parse('../../outside'),
  });
  expect(unsafeIdScratch.startsWith(join(tmpdir(), 'helix-plan-scratch-'))).toBe(true);
  expect(unsafeIdScratch).not.toContain('outside');
  expect(env({ project, session: { ...session, role: 'orchestrator' } })).toEqual({
    ...shared,
    HELIX_SCRATCH_DIR: scratch,
  });
  expect(existsSync(scratch)).toBe(true);
  expect(env({ project, session: { ...session, role: 'worker' } })).toBeUndefined();
  expect(env({ project, session: { ...session, role: 'reviewer' } })).toEqual(shared);
  expect(
    sessionEnvironment(dataDir, { PATH: '' })({
      project,
      session: { ...session, role: 'orchestrator' },
    })?.PATH,
  ).toBe(join(dataDir, 'bin'));
  expect(base).toEqual(
    process.platform === 'win32' ? { Path: 'base-path' } : { PATH: 'base-path' },
  );
  rmSync(dirname(scratch), { recursive: true, force: true });
});

test('orchestrator scratch ignores a planted predictable parent and stays private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helix-scratch-test-'));
  try {
    const planted = join(root, 'helix-plan-scratch');
    mkdirSync(planted);
    const scratch = orchestratorScratch(join(root, 'data'), session, root);
    expect(scratch.startsWith(join(root, 'helix-plan-scratch-'))).toBe(true);
    expect(dirname(scratch)).not.toBe(planted);
    expect(scratch).toBe(orchestratorScratch(join(root, 'data'), session, root));
    if (process.platform !== 'win32') {
      expect((await stat(dirname(scratch))).mode & 0o077).toBe(0);
      expect((await stat(scratch)).mode & 0o077).toBe(0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'orchestrator scratch rejects a shared temporary root without a sticky bit',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'helix-scratch-test-'));
    try {
      await chmod(root, 0o777);
      expect(() => orchestratorScratch(join(root, 'data'), session, root)).toThrow(/sticky bit/);
      await chmod(root, 0o1777);
      const scratch = orchestratorScratch(join(root, 'data'), session, root);
      expect((await stat(dirname(scratch))).mode & 0o077).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'orchestrator scratch rejects a session directory whose permissions become shared',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'helix-scratch-test-'));
    try {
      const data = join(root, 'data');
      const scratch = orchestratorScratch(data, session, root);
      await chmod(scratch, 0o777);
      expect(() => orchestratorScratch(data, session, root)).toThrow(/not private/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('launcher templates quote workspace paths and forward all arguments', () => {
  const root = join(tmpdir(), "repo with spaces and 'quotes' 100%");
  const windows = launcherContents(root, 'win32');
  expect(windows).toBe(
    '@echo off\r\nsetlocal DisableDelayedExpansion\r\n' +
      '"' +
      join(root, 'node_modules', '.bin', 'tsx.cmd').replaceAll('%', '%%') +
      '" "' +
      join(root, 'apps', 'cli', 'src', 'main.ts').replaceAll('%', '%%') +
      '" %*\r\n',
  );
  const posix = launcherContents(root, 'linux');
  expect(posix.startsWith('#!/bin/sh\nexec ')).toBe(true);
  expect(posix).toContain("'\"'\"'");
  expect(posix.endsWith(' "$@"\n')).toBe(true);
});

test('startup writes an executable launcher that discovers the test daemon and runs --json status', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helix launcher with spaces-'));
  const env: NodeJS.ProcessEnv = { ...process.env, HELIX_GITHUB: 'off' };
  // CLI discovery must use this test's run.json even on an operator-configured machine.
  delete env.HELIX_URL;
  const core = await createRealCore({ dataDir, env });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon({ core, dataDir, port: 0, version: 'launcher-test' });
    const launcher = join(dataDir, 'bin', process.platform === 'win32' ? 'helix.cmd' : 'helix');
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    expect(await readFile(launcher, 'utf8')).toBe(launcherContents(root));
    if (process.platform !== 'win32') expect((await stat(launcher)).mode & 0o111).toBe(0o111);
    const childEnv = { ...env, HELIX_DATA_DIR: dataDir };
    const result =
      process.platform === 'win32'
        ? await exec(
            process.env.ComSpec ?? 'cmd.exe',
            ['/d', '/s', '/c', `""${launcher}" --json status"`],
            {
              env: childEnv,
              cwd: dataDir,
              windowsHide: true,
              windowsVerbatimArguments: true,
              timeout: 20_000,
            },
          )
        : await exec(launcher, ['--json', 'status'], {
            env: childEnv,
            cwd: dataDir,
            timeout: 20_000,
          });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(expect.any(Object));
    expect(result.stdout).not.toContain('error');
    if (process.platform === 'win32') {
      // Claude Code's Bash tool is Git Bash: plain `helix` must resolve there too.
      expect(await readFile(join(dataDir, 'bin', 'helix'), 'utf8')).toBe(GIT_BASH_SHIM);
      const bash = await exec('bash', ['-c', 'helix --json status'], {
        env: {
          ...childEnv,
          PATH: `${join(dataDir, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        },
        cwd: dataDir,
        windowsHide: true,
        timeout: 20_000,
      });
      expect(JSON.parse(bash.stdout)).toEqual(expect.any(Object));
    }
  } finally {
    if (daemon) await daemon.stop();
    else await core.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);
