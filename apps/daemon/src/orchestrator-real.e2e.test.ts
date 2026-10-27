import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createHelixClient } from '@helix/api-client';
import { projectUpTo, type HelixEvent, type SessionId } from '@helix/contracts';
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
  frame: { id?: string | number; method?: string; result?: unknown; error?: unknown };
};

test.skipIf(process.env.HELIX_E2E !== '1')(
  'real orchestrator submits a plan through its helix launcher and waits for approval without editing',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'helix-orchestrator-real-'));
    const repo = path.join(root, 'small app');
    const dataDir = path.join(root, 'data');
    const events: HelixEvent[] = [];
    let core: Awaited<ReturnType<typeof createRealCore>> | undefined;
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    let sessionId: SessionId | undefined;
    let protocolPath: string | undefined;
    console.info(`Real orchestrator E2E artifacts: ${root}`);
    try {
      await mkdir(path.join(repo, 'src'), { recursive: true });
      await mkdir(path.join(repo, 'test'));
      await git(repo, 'init', '-b', 'main');
      await git(repo, 'config', 'user.name', 'Helix E2E');
      await git(repo, 'config', 'user.email', 'helix-e2e@example.test');
      await git(repo, 'config', 'commit.gpgsign', 'false');
      await git(repo, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
      await writeFile(
        path.join(repo, 'package.json'),
        JSON.stringify(
          {
            name: 'orchestrator-smoke-app',
            private: true,
            type: 'module',
            scripts: { test: 'node --test' },
          },
          null,
          2,
        ) + '\n',
      );
      await writeFile(
        path.join(repo, 'README.md'),
        'A tiny greeting and totals app. Run node --test.\n',
      );
      await writeFile(
        path.join(repo, 'src', 'greeting.js'),
        'export const greet = (name) => `Hello, ${name}!`;\n',
      );
      await writeFile(
        path.join(repo, 'src', 'total.js'),
        'export const total = (values) => values.reduce((sum, value) => sum + value, 0);\n',
      );
      await writeFile(
        path.join(repo, 'test', 'app.test.js'),
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n" +
          "import { greet } from '../src/greeting.js';\nimport { total } from '../src/total.js';\n" +
          "test('greeting', () => assert.equal(greet('Ada'), 'Hello, Ada!'));\n" +
          "test('total', () => assert.equal(total([2, 3]), 5));\n",
      );
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'Initial app');
      const initialSha = await git(repo, 'rev-parse', 'HEAD');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HELIX_GITHUB: 'off',
        HELIX_CODEX_MODEL: 'gpt-6.1-sol',
        HELIX_CODEX_EFFORT: 'medium',
        HELIX_DEBUG_PROTOCOL: '1',
        HELIX_STALL_TIMEOUT_MS: '360000',
      };
      env.HELIX_URL = '';
      core = await createRealCore({ dataDir, env });
      daemon = await startDaemon({ core, dataDir, port: 0, version: 'orchestrator-real-e2e' });
      const client = createHelixClient({ baseUrl: `http://127.0.0.1:${daemon.port}` });
      const installed = (await core.harnesses()).find((h) => h.agent === 'codex');
      expect(installed?.installed, 'Install Codex before HELIX_E2E=1').toBe(true);
      expect(installed?.signedIn, 'Run codex login before HELIX_E2E=1').toBe(true);
      const project = await client.createProject({ repoPath: repo });
      const refresh = async () => {
        for (;;) {
          const since = events.at(-1)?.seq ?? 0;
          const page = await client.projectEvents(project.id, { since, limit: 1000 });
          if (!page.events.length) return;
          if (page.lastSeq <= since) throw new Error('Event cursor did not advance');
          events.push(...page.events);
        }
      };
      const session = await client.createSession(
        project.id,
        {
          title: 'Plan greeting and totals improvements',
          prompt:
            'Inspect this app read-only and submit exactly two tasks: add an optional uppercase greeting mode, and reject non-numeric values in total(). Each task needs tests and explicit file ownership; order the tasks if they share the existing test file. Use helix plan submit with a temporary artifact outside the repository, then explain the split. Do not implement, approve or start workers. Stop after reporting that the plan awaits human approval.',
          agent: 'codex',
          interface: 'chat',
          planWithOrchestrator: true,
        },
        { idempotencyKey: 'real-orchestrator-plan' },
      );
      sessionId = session.id;
      protocolPath = path.join(dataDir, 'logs', `${session.id}.protocol.jsonl`);
      expect(session.role).toBe('orchestrator');
      await expect
        .poll(
          async () => {
            await refresh();
            return events.some(
              (e) =>
                e.type === 'plan.submitted' && e.payload.plan.orchestratorSessionId === session.id,
            );
          },
          { timeout: 360_000, interval: 1000 },
        )
        .toBe(true);
      // Let the final explanation/reply settle before checking protocol requests and git.
      await expect
        .poll(
          async () => {
            await refresh();
            return projectUpTo(events, events.at(-1)!.seq, { strict: true }).sessions[session.id]
              ?.activity;
          },
          { timeout: 60_000, interval: 500 },
        )
        .toBe('idle');
      await refresh();
      const state = projectUpTo(events, events.at(-1)!.seq, { strict: true });
      const plan = Object.values(state.plans).find((p) => p.orchestratorSessionId === session.id)!;
      expect(plan).toBeDefined();
      expect(plan.status).toBe('awaiting_approval');
      expect(plan.nodes).toHaveLength(2);
      for (const node of plan.nodes) {
        expect(node.files.length).toBeGreaterThan(0);
        expect(node.files.every((file) => file.trim().length > 0)).toBe(true);
        expect(node.rationale.trim().length).toBeGreaterThan(0);
        expect(node.sessionId).toBeUndefined();
      }
      expect(events.filter((e) => e.type === 'plan.approved')).toEqual([]);
      expect(
        events.filter((e) => e.type === 'session.created' && e.payload.session.role === 'worker'),
      ).toEqual([]);
      expect(
        await git(session.worktreePath!, 'status', '--porcelain', '--untracked-files=all'),
      ).toBe('');
      expect(await git(session.worktreePath!, 'rev-parse', 'HEAD')).toBe(initialSha);
      expect(await git(session.worktreePath!, 'diff', initialSha)).toBe('');
      const frames = (await readFile(protocolPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as ProtocolRow);
      expect(
        frames.some((row) => row.direction === 'out' && row.frame.method === 'turn/start'),
      ).toBe(true);
      const pending = new Map<string | number, string>();
      for (const { direction, frame } of frames) {
        if (frame.id === undefined) continue;
        if (direction === 'in' && frame.method) pending.set(frame.id, frame.method);
        if (direction === 'out' && !frame.method && ('result' in frame || 'error' in frame))
          pending.delete(frame.id);
      }
      expect([...pending], `Unanswered server requests in ${protocolPath}`).toEqual([]);
      await client.stopSession(session.id);
    } finally {
      try {
        if (sessionId) await core?.stopSession(sessionId);
      } finally {
        try {
          if (daemon) await daemon.stop();
          else await core?.shutdown();
        } finally {
          await writeFile(
            path.join(root, 'events.jsonl'),
            events.map((e) => JSON.stringify(e)).join('\n') + '\n',
          );
          console.info(
            `Orchestrator E2E diagnostics retained: ${root}${protocolPath ? `; protocol: ${protocolPath}` : ''}`,
          );
        }
      }
    }
  },
  480_000,
);
