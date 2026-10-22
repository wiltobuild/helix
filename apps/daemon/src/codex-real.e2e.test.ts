import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createHelixClient, type EventSubscription } from '@helix/api-client';
import { projectUpTo, type HelixEvent } from '@helix/contracts';
import { createRealCore } from './real-core.js';
import { startDaemon } from './lifecycle.js';

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, windowsHide: true, timeout: 15_000 })).stdout
    .replace(/\r\n/g, '\n')
    .trim();
}
type ProtocolRow = {
  direction: 'in' | 'out';
  ts: string;
  frame: { id?: string | number; method?: string; result?: unknown; error?: unknown };
};

test.skipIf(process.env.HELIX_E2E !== '1')(
  'real daemon commits Codex edits on the session branch without approvals, orphaned requests or unknown activity',
  async () => {
    // Keep the complete throwaway repo and diagnostics, including on failure. Never delete a dirty worktree.
    const root = await mkdtemp(path.join(tmpdir(), 'helix-codex-real-'));
    const repo = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    const events: HelixEvent[] = [];
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    let core: Awaited<ReturnType<typeof createRealCore>> | undefined;
    let stream: EventSubscription | undefined;
    let protocolPath: string | undefined;
    console.info(`Real Codex E2E artifacts: ${root}`);
    try {
      await mkdir(repo);
      await git(repo, 'init', '-b', 'main');
      await git(repo, 'config', 'user.name', 'Helix E2E');
      await git(repo, 'config', 'user.email', 'helix-e2e@example.test');
      await git(repo, 'config', 'commit.gpgsign', 'false');
      await git(repo, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
      await writeFile(path.join(repo, 'README.md'), 'Helix real Codex smoke test\n');
      await git(repo, 'add', 'README.md');
      await git(repo, 'commit', '-m', 'Initial commit');
      core = await createRealCore({
        dataDir,
        env: { ...process.env, HELIX_DEBUG_PROTOCOL: '1', HELIX_STALL_TIMEOUT_MS: '180000' },
      });
      daemon = await startDaemon({ core, dataDir, port: 0, version: 'codex-real-e2e' });
      const client = createHelixClient({ baseUrl: `http://127.0.0.1:${daemon.port}` });
      const installed = (await core.harnesses()).find((h) => h.agent === 'codex');
      expect(installed?.installed, 'Install Codex before HELIX_E2E=1').toBe(true);
      expect(installed?.signedIn, 'Run codex login before HELIX_E2E=1').toBe(true);
      const project = await client.createProject({ repoPath: repo });
      stream = client.events({
        projectId: project.id,
        onEvent: (event) => {
          events.push(event);
          console.info(
            `[Codex E2E] #${event.seq} ${event.type}${event.type === 'activity.changed' ? ` ${event.payload.activity}` : ''}`,
          );
        },
      });
      const deadline = Date.now() + 240_000;
      const session = await client.createSession(
        project.id,
        {
          title: 'Real Codex HELLO',
          prompt: 'Create HELLO.md containing the word hello.',
          agent: 'codex',
          interface: 'chat',
        },
        { idempotencyKey: 'real-codex-hello' },
      );
      protocolPath = path.join(dataDir, 'logs', `${session.id}.protocol.jsonl`);
      let complete = false;
      while (Date.now() < deadline) {
        expect(
          events.filter((event) => event.type === 'approval.requested'),
          `Task must commit without approvals; inspect ${protocolPath}`,
        ).toEqual([]);
        expect(
          events.some(
            (event) => event.type === 'activity.changed' && event.payload.activity === 'unknown',
          ),
          `Unknown activity; inspect ${protocolPath}`,
        ).toBe(false);
        const state = events.some((e) => e.type === 'project.added')
          ? projectUpTo(events, Number.MAX_SAFE_INTEGER, { strict: true }).sessions[session.id]
          : undefined;
        if (
          state?.activity === 'idle' &&
          events.some((e) => e.type === 'worktree.diff_updated' && e.payload.filesChanged === 1) &&
          events.some((e) => e.type === 'explain.note' && e.payload.text.startsWith('Committed '))
        ) {
          complete = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(complete, `Timed out after 4 minutes; inspect ${protocolPath}`).toBe(true);
      expect(await git(repo, 'show', `${session.branch}:HELLO.md`)).toMatch(/\bhello\b/);
      expect(await git(session.worktreePath!, 'branch', '--show-current')).toBe(session.branch);
      expect(
        Number(await git(repo, 'rev-list', '--count', `main..${session.branch}`)),
      ).toBeGreaterThanOrEqual(1);
      expect(await git(session.worktreePath!, 'status', '--porcelain')).toBe('');
      const sha = await git(repo, 'rev-parse', session.branch!);
      expect(await git(repo, 'log', '-1', '--format=%B', session.branch!)).toContain(
        `${session.title}\n\nTurn 1 by codex via Helix`,
      );
      const committed = events.find(
        (event) =>
          event.type === 'explain.note' &&
          event.payload.text === `Committed ${sha.slice(0, 7)}: ${session.title}`,
      );
      expect(committed).toBeDefined();
      expect(events.find((event) => event.seq === committed?.causedBy)).toMatchObject({
        type: 'activity.changed',
        payload: { activity: 'idle' },
      });
      const diff = await client.sessionDiff(session.id, { scope: 'pr' });
      expect(diff.files.map((file) => file.path)).toEqual(['HELLO.md']);
      expect(events.filter((event) => event.type === 'approval.requested')).toEqual([]);
      const frames = (await readFile(protocolPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as ProtocolRow);
      expect(
        frames.some((row) => row.direction === 'out' && row.frame.method === 'turn/start'),
      ).toBe(true);
      const pending = new Map<string | number, string>();
      for (const row of frames) {
        const frame = row.frame;
        if (frame.id === undefined) continue;
        if (row.direction === 'in' && frame.method) pending.set(frame.id, frame.method);
        if (row.direction === 'out' && !frame.method && ('result' in frame || 'error' in frame))
          pending.delete(frame.id);
      }
      expect([...pending], `Unanswered server requests in ${protocolPath}`).toEqual([]);
    } finally {
      stream?.close();
      try {
        if (daemon) await daemon.stop();
        else await core?.shutdown();
      } finally {
        await writeFile(
          path.join(root, 'events.jsonl'),
          events.map((event) => JSON.stringify(event)).join('\n') + '\n',
        );
        console.info(
          `Codex E2E diagnostics retained: ${root}${protocolPath ? `; protocol: ${protocolPath}` : ''}`,
        );
      }
    }
  },
  330_000,
);
