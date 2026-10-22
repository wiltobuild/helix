import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { createHelixClient, type EventSubscription } from '@helix/api-client';
import {
  boardColumn,
  deriveStatus,
  projectUpTo,
  whyChain,
  type HelixEvent,
} from '@helix/contracts';
import { createRealCore } from './real-core.js';
import { startDaemon } from './lifecycle.js';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const setupScript = path.join(repoRoot, 'scripts', 'e2e', 'setup-github-sandbox.mjs');

type Sandbox = {
  fullName: string;
  owner: string;
  cloneUrl: string;
  checkName: string;
  marker: string;
};

async function run(command: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec(command, args, {
    cwd,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.replace(/\r\n/g, '\n').trim();
}
const git = (cwd: string, ...args: string[]) => run('git', args, cwd);
const ghJson = async <T>(...args: string[]): Promise<T> =>
  JSON.parse(await run('gh', ['api', ...args])) as T;

// Real GitHub, real Codex, real daemon. Opt in twice: HELIX_E2E=1 for real agents and
// HELIX_E2E_GITHUB=1 because this creates/updates a private repository and runs Actions.
test.skipIf(process.env.HELIX_E2E !== '1' || process.env.HELIX_E2E_GITHUB !== '1')(
  'real GitHub loop: push → PR → failing CI → routed fix → green CI → merge only on request',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'helix-github-real-'));
    const repo = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    const runId = randomUUID().slice(0, 8);
    const events: HelixEvent[] = [];
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    let core: Awaited<ReturnType<typeof createRealCore>> | undefined;
    let stream: EventSubscription | undefined;
    let sandbox: Sandbox | undefined;
    let branch: string | undefined;
    let merged = false;
    console.info(`Real GitHub E2E ${runId}; artifacts: ${root}`);
    const progress = (text: string) => console.info(`[GitHub E2E ${runId}] ${text}`);
    const waitFor = async (
      label: string,
      predicate: (event: HelixEvent) => boolean,
      timeoutMs: number,
    ): Promise<HelixEvent> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = events.find(predicate);
        if (found) {
          progress(`${label}: #${found.seq}`);
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(`Timed out waiting for ${label}; events are in ${root}`);
    };
    const merges = () => events.filter((e) => e.type === 'pr.merged');

    try {
      sandbox = JSON.parse(await run(process.execPath, [setupScript])) as Sandbox;
      progress(`sandbox ${sandbox.fullName}`);
      await git(root, 'clone', '--quiet', sandbox.cloneUrl, repo);
      await git(repo, 'config', 'user.name', 'Helix E2E');
      await git(repo, 'config', 'user.email', 'helix-e2e@example.test');
      await git(repo, 'config', 'commit.gpgsign', 'false');
      await git(repo, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
      expect(await git(repo, 'ls-files', sandbox.marker)).toBe('');

      core = await createRealCore({
        dataDir,
        env: { ...process.env, HELIX_DEBUG_PROTOCOL: '1', HELIX_STALL_TIMEOUT_MS: '180000' },
      });
      daemon = await startDaemon({ core, dataDir, port: 0, version: 'github-real-e2e' });
      const client = createHelixClient({ baseUrl: `http://127.0.0.1:${daemon.port}` });
      const codex = (await core.harnesses()).find((h) => h.agent === 'codex');
      expect(codex?.installed, 'Install Codex before running this test').toBe(true);
      expect(codex?.signedIn, 'Run codex login before running this test').toBe(true);

      const project = await client.createProject({ repoPath: repo });
      expect(project.github, 'Helix must detect the GitHub remote').toMatchObject({
        owner: sandbox.owner,
      });
      stream = client.events({
        projectId: project.id,
        onEvent: (event) => {
          events.push(event);
          console.info(
            `[GitHub E2E ${runId}] #${event.seq} ${event.type}${event.causedBy ? ` ← #${event.causedBy}` : ''}`,
          );
        },
      });

      const file = `E2E-${runId}.md`;
      const session = await client.createSession(
        project.id,
        {
          title: `GitHub E2E ${runId}`,
          prompt: `Create a file named ${file} at the repository root containing the word hello.`,
          agent: 'codex',
          interface: 'chat',
        },
        { idempotencyKey: `github-e2e-${runId}` },
      );
      branch = session.branch;
      const state = () => projectUpTo(events, events.at(-1)!.seq, { strict: true });
      const column = () => boardColumn(deriveStatus(state().sessions[session.id]!));

      // 1. Helix commits, pushes and opens the PR.
      const opened = await waitFor('pr.opened', (e) => e.type === 'pr.opened', 300_000);
      if (opened.type !== 'pr.opened') throw new Error('unreachable');
      const number = opened.payload.pr.number;
      const remoteHead = await run('git', ['ls-remote', sandbox.cloneUrl, `refs/heads/${branch}`]);
      expect(remoteHead, 'Helix must push the session branch').toContain(`refs/heads/${branch}`);

      // 2. The first CI run fails on the real Actions check.
      const failed = await waitFor(
        'failing ci.updated',
        (e) =>
          e.type === 'ci.updated' && e.payload.prNumber === number && e.payload.checks.failed > 0,
        600_000,
      );
      if (failed.type !== 'ci.updated') throw new Error('unreachable');
      expect(failed.payload.checks.failingNames).toContain(sandbox.checkName);

      // 3. Helix routes that failure to the owning agent, caused by the ci.updated.
      const routed = await waitFor(
        'feedback.routed',
        (e) => e.type === 'feedback.routed' && e.causedBy === failed.seq,
        60_000,
      );
      if (routed.type !== 'feedback.routed') throw new Error('unreachable');
      expect(routed.payload.summary).toContain(sandbox.checkName);
      const repairTurn = await waitFor(
        'repair turn',
        (e) =>
          e.seq > routed.seq &&
          e.type === 'activity.changed' &&
          e.payload.activity === 'active' &&
          e.causedBy === routed.seq,
        120_000,
      );

      // 4. The fix is committed by Helix, pushed, and the next CI run passes.
      const fixCommit = await waitFor(
        'repair commit',
        (e) =>
          e.seq > repairTurn.seq &&
          e.type === 'explain.note' &&
          e.payload.text.startsWith('Committed '),
        600_000,
      );
      const green = await waitFor(
        'green ci.updated',
        (e) =>
          e.seq > routed.seq &&
          e.type === 'ci.updated' &&
          e.payload.prNumber === number &&
          e.payload.checks.total > 0 &&
          e.payload.checks.failed === 0 &&
          e.payload.checks.pending === 0,
        600_000,
      );
      expect(green.seq).toBeGreaterThan(fixCommit.seq);
      const marker = await ghJson<{ content: string }>(
        `repos/${sandbox.fullName}/contents/${sandbox.marker}?ref=${encodeURIComponent(branch!)}`,
      );
      expect(Buffer.from(marker.content, 'base64').toString('utf8')).toMatch(/fixed/i);

      // The causal chain runs from the fix commit back through the routed feedback to the failing check.
      const chain = whyChain(events, fixCommit.seq).map((e) => e.seq);
      expect(chain).toEqual(expect.arrayContaining([fixCommit.seq, routed.seq, failed.seq]));
      expect(chain.indexOf(routed.seq)).toBeLessThan(chain.indexOf(failed.seq));

      // 5. Ready, but nothing merges without the explicit call.
      await waitFor('ready to merge', () => column() === 'ready_to_merge', 120_000);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      expect(merges(), 'Helix must not merge on its own').toEqual([]);
      const before = await ghJson<{ merged: boolean; state: string }>(
        `repos/${sandbox.fullName}/pulls/${number}`,
      );
      expect(before).toMatchObject({ merged: false, state: 'open' });

      // 6. The API call that stands in for the human's Merge click.
      const result = await client.mergeSession(session.id);
      merged = true;
      const mergeEvent = await waitFor('pr.merged', (e) => e.type === 'pr.merged', 120_000);
      expect(mergeEvent.payload).toMatchObject({ prNumber: number, mergeSha: result.mergeSha });
      const after = await ghJson<{ merged: boolean; merge_commit_sha: string }>(
        `repos/${sandbox.fullName}/pulls/${number}`,
      );
      expect(after).toMatchObject({ merged: true, merge_commit_sha: result.mergeSha });
      expect(merges()).toHaveLength(1);
      expect(deriveStatus(state().sessions[session.id]!)).toBe('merged');
      expect(events.filter((e) => e.type === 'feedback.routed')).toHaveLength(1);
      expect(state().anomalies).toEqual([]);
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
        // Only the sandbox's own merged session branch is removed; nothing else is touched.
        if (sandbox && branch && merged)
          await run('gh', [
            'api',
            '-X',
            'DELETE',
            `repos/${sandbox.fullName}/git/refs/heads/${branch}`,
          ]).catch(() => undefined);
        console.info(`GitHub E2E diagnostics retained: ${root}`);
      }
    }
  },
  1_800_000,
);
