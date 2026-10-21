import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { createHelixClient, type EventSubscription } from '@helix/api-client';
import {
  boardColumn,
  deriveStatus,
  projectUpTo,
  type AgentHarness,
  type HarnessSession,
  type HarnessEmission,
  type HelixEvent,
} from '@helix/contracts';
import { createHelixCore } from '@helix/core';
import { openStore } from '@helix/storage';
import { GitWorktreeManager } from '@helix/git';
import { NodePtyHost } from '@helix/pty-host';
import { createHarness } from '@helix/harness';
import { buildFeedbackMessage, createGitHubScm } from '@helix/scm';
import { createFakeGitHub, createFakeHarness } from '@helix/testing';
import { startDaemon } from './lifecycle.js';

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec('git', args, { cwd, windowsHide: true, timeout: 15_000 })).stdout.trim();
}
const message = (text: string): HarnessEmission => ({
  type: 'chat.item',
  payload: { item: { kind: 'message', role: 'assistant', text } },
});

/** Adds filesystem effects to the shared scripted fake, preserving its emissions. */
function editingHarness(worktrees: GitWorktreeManager, repair: Promise<void>): AgentHarness {
  const fake = createFakeHarness({
    kind: 'codex',
    turns: [
      [{ emission: message('Implemented the change') }],
      [{ emission: message('Fixed the failing check') }],
    ],
  });
  return {
    kind: fake.kind,
    detect: () => fake.detect(),
    start: (options) => {
      let handle: HarnessSession | undefined;
      const listeners = new Set<(event: HarnessEmission) => void>();
      let off: (() => void) | undefined;
      let turn = 0;
      return Promise.resolve({
        // CONTRACT-REQUEST: shared fake starts on start(), whereas core owns the
        // initial send. Lazily start it on that send to avoid an extra fake turn.
        send: async (text, mode) => {
          if (turn > 0) await repair;
          await writeFile(
            join(options.cwd, 'task.txt'),
            turn++ === 0 ? 'first change\n' : 'fixed change\n',
          );
          await worktrees.commitAll(options.cwd, turn === 1 ? 'Implement task' : 'Fix CI');
          if (!handle) {
            handle = await fake.start(options);
            off = handle.onEvent((event) => {
              for (const cb of listeners) cb(event);
            });
          } else await handle.send(text, mode);
        },
        onEvent: (cb) => {
          listeners.add(cb);
          return () => {
            listeners.delete(cb);
          };
        },
        interrupt: () => handle?.interrupt() ?? Promise.resolve(),
        stop: async () => {
          off?.();
          await handle?.stop();
        },
      });
    },
  };
}

async function scenario(real: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'helix-integration-'));
  const repo = join(root, 'repo');
  const dataDir = join(root, 'data');
  const remote = join(root, 'remote.git');
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let stream: EventSubscription | undefined;
  let store: ReturnType<typeof openStore> | undefined;
  const release = Promise.withResolvers<void>();
  const log = { error: vi.fn() };
  try {
    await mkdir(repo);
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.name', 'Helix Integration');
    await git(repo, 'config', 'user.email', 'helix@example.test');
    await git(repo, 'config', 'commit.gpgsign', 'false');
    await git(repo, 'config', 'core.hooksPath', join(root, 'no-hooks'));
    await writeFile(join(repo, 'task.txt'), 'baseline\n');
    await git(repo, 'add', 'task.txt');
    await git(repo, 'commit', '-m', 'Initial commit');
    if (!real) {
      await git(root, 'init', '--bare', remote);
      await git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
      // Real Git pushes stay local; the fetch URL supplies fake GitHub identity.
      await git(repo, 'remote', 'set-url', '--push', 'origin', remote);
    }
    store = openStore({ dataDir });
    const worktrees = new GitWorktreeManager({ dataDir, projects: store });
    const github = createFakeGitHub();
    const scm = createGitHubScm({
      token: 'fake-token',
      fetch: github.fetch,
      pollMs: 30,
      onError: (error) => {
        log.error('SCM failure', error);
      },
    });
    const harness = real
      ? createHarness('codex', { codexApprovalPolicy: 'never', codexSandbox: 'workspace-write' })
      : editingHarness(worktrees, release.promise);
    if (real) {
      const detected = await harness.detect();
      expect(detected.installed, 'Install Codex before running HELIX_E2E=1').toBe(true);
      expect(detected.signedIn, 'Sign in with codex login before running HELIX_E2E=1').not.toBe(
        false,
      );
    }
    const core = createHelixCore({
      store,
      worktrees,
      terminals: new NodePtyHost({ dataDir }),
      harnesses: { codex: harness },
      harnessStartsWithPrompt: () => real,
      ...(!real ? { scm } : {}),
      buildFeedbackMessage,
      clock: () => new Date().toISOString(),
      ids: (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`,
      log,
    });
    daemon = await startDaemon({ core, dataDir, port: 0, version: 'integration' });
    const client = createHelixClient({ baseUrl: `http://127.0.0.1:${daemon.port}` });
    const project = await client.createProject({ repoPath: repo });
    const events: HelixEvent[] = [];
    stream = client.events({
      projectId: project.id,
      onEvent: (event) => {
        events.push(event);
      },
    });
    const request = {
      title: 'One real task',
      agent: 'codex',
      interface: 'chat' as const,
      prompt:
        'Replace task.txt with exactly "first change" followed by a newline. Commit this change with git. Do not create any other files. Then report completion.',
    };
    const session = await client.createSession(project.id, request, { idempotencyKey: 'one-task' });
    expect(await client.createSession(project.id, request, { idempotencyKey: 'one-task' })).toEqual(
      session,
    );
    const waitFor = async (predicate: (event: HelixEvent) => boolean) => {
      await vi.waitFor(() => expect(events.some(predicate)).toBe(true), {
        timeout: real ? 180_000 : 15_000,
        interval: 25,
      });
      return events.find(predicate)!;
    };
    await waitFor((e) => e.type === 'activity.changed' && e.payload.activity === 'idle');
    expect(events.filter((e) => e.type === 'session.created')).toHaveLength(1);
    const created = events.find((e) => e.type === 'session.created')!;
    const worktree = events.find((e) => e.type === 'worktree.created')!;
    const started = events.find((e) => e.type === 'session.started')!;
    expect(created.seq).toBeLessThan(worktree.seq);
    expect(worktree.seq).toBeLessThan(started.seq);
    expect(
      events.some(
        (e) =>
          e.type === 'chat.item' &&
          e.payload.item.kind === 'message' &&
          e.payload.item.role === 'assistant',
      ),
    ).toBe(true);
    const snapshot = (seq: number = events.at(-1)!.seq) =>
      projectUpTo(events, seq, { strict: true });
    const column = (seq?: number) => boardColumn(deriveStatus(snapshot(seq).sessions[session.id]!));
    expect(column(created.seq)).toBe('pending');
    expect(column(started.seq)).toBe('working');
    const diff = await client.sessionDiff(session.id, { scope: 'pr' });
    expect(diff.files.map((file) => file.path)).toContain('task.txt');
    expect(diff.unifiedDiff).toContain('+first change');
    expect(await worktrees.commitsAhead(session.worktreePath!, 'main')).toBe(1);
    if (real) {
      expect(log.error).not.toHaveBeenCalled();
      return;
    }

    const opened = await waitFor((e) => e.type === 'pr.opened');
    if (opened.type !== 'pr.opened') throw new Error('Expected PR');
    const number = opened.payload.pr.number;
    expect(column()).toBe('in_review');
    const firstHead = await worktrees.headSha(session.worktreePath!);
    expect(await git(root, '--git-dir', remote, 'rev-parse', session.branch!)).toBe(firstHead);
    github.setPr(number, { head: { sha: firstHead, ref: session.branch! } });
    github.setChecks(number, [
      { id: 1, name: 'task test', status: 'completed', conclusion: 'failure' },
    ]);
    const routed = await waitFor((e) => e.type === 'feedback.routed');
    const failed = events.find((e) => e.type === 'ci.updated' && e.payload.checks.failed === 1)!;
    expect(routed.causedBy).toBe(failed.seq);
    expect(column()).toBe('in_review');
    expect(deriveStatus(snapshot().sessions[session.id]!)).toBe('ci_failed');
    release.resolve();
    await waitFor(
      (e) =>
        e.type === 'chat.item' &&
        e.payload.item.kind === 'message' &&
        e.payload.item.text === 'Fixed the failing check',
    );
    await waitFor(
      (e) => e.seq > routed.seq && e.type === 'activity.changed' && e.payload.activity === 'idle',
    );
    const active = events.find(
      (e) => e.seq > routed.seq && e.type === 'activity.changed' && e.payload.activity === 'active',
    )!;
    expect(column(active.seq)).toBe('working');
    expect(active.causedBy).toBe(routed.seq);
    const fixed = await client.sessionDiff(session.id, { scope: 'pr' });
    expect(fixed.unifiedDiff).toContain('+fixed change');
    const fixedHead = await worktrees.headSha(session.worktreePath!);
    expect(await git(root, '--git-dir', remote, 'rev-parse', session.branch!)).toBe(fixedHead);
    github.setPr(number, { head: { sha: fixedHead, ref: session.branch! } });
    github.setChecks(number, [
      { id: 2, name: 'task test', status: 'completed', conclusion: 'success' },
    ]);
    await waitFor(
      (e) => e.seq > routed.seq && e.type === 'ci.updated' && e.payload.checks.passed === 1,
    );
    expect(column()).toBe('ready_to_merge');
    const merged = await client.mergeSession(session.id);
    const mergeEvent = await waitFor((e) => e.type === 'pr.merged');
    expect(mergeEvent.payload).toMatchObject({ mergeSha: merged.mergeSha });
    expect(column()).toBe('archive');
    expect(deriveStatus(snapshot().sessions[session.id]!)).toBe('merged');
    expect(Object.values(snapshot().sessions).map((s) => boardColumn(deriveStatus(s)))).toEqual([
      'archive',
    ]);
    expect(snapshot().anomalies).toEqual([]);
    expect(events.filter((e) => e.type === 'feedback.routed')).toHaveLength(1);
    expect(github.requests.some((r) => r.method === 'PUT' && r.path.endsWith('/merge'))).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    stream?.close();
    try {
      await daemon?.stop();
    } finally {
      await store?.close();
      // root is exclusively the mkdtemp directory created above; never the source repo.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

test(
  'real HTTP + SQLite + Git: task, SSE, diff, failed CI, repair, green CI, merge',
  () => scenario(false),
  60_000,
);
test.skipIf(process.env.HELIX_E2E !== '1')(
  'real Codex: task through HTTP and SSE to a committed diff',
  () => scenario(true),
  240_000,
);
