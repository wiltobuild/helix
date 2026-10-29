import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  agentReviewSchema,
  fixtures,
  type HarnessEmission,
  type HelixEvent,
} from '@helix/contracts';
import { ClaudeSession } from './claude.js';
import { CodexSession } from './codex.js';
import { REVIEW_WRITE_DENIAL } from './session.js';
import { isSafeCommand } from './safe-commands.js';
import { createHarness, REVIEWER_PROMPT, reviewerPrompt } from './index.js';
import { record } from './protocol.js';

const template = fixtures.crossReviewRun.find(
  (e): e is HelixEvent<'session.created'> =>
    e.type === 'session.created' && e.payload.session.role === 'reviewer',
)!.payload.session;
class ClaudeProbe extends ClaudeSession {
  frames: unknown[] = [];
  protected override write(frame: unknown): Promise<void> {
    this.frames.push(frame);
    return Promise.resolve();
  }
  inject(frame: unknown): void {
    this.receive(frame);
  }
}
class CodexProbe extends CodexSession {
  frames: unknown[] = [];
  protected override write(frame: unknown): Promise<void> {
    this.frames.push(frame);
    return Promise.resolve();
  }
  inject(frame: unknown): void {
    this.receive(frame);
  }
}
let root: string;
let scratch: string;
let worktree: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'helix-review-mode-'));
  scratch = path.join(root, 'scratch');
  worktree = path.join(root, 'worktree');
  mkdirSync(scratch);
  mkdirSync(worktree);
  symlinkSync(
    worktree,
    path.join(scratch, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])(
  'Claude denies %s outside scratch without asking, including junctions',
  (tool) => {
    for (const filename of [
      path.join(worktree, 'source.ts'),
      '../worktree/source.ts',
      'escape/source.ts',
      '',
    ]) {
      const probe = new ClaudeProbe(
        { claudePermissionMode: 'acceptEdits' },
        { session: template, cwd: scratch, review: { worktreePath: worktree } },
      );
      const events: HarnessEmission[] = [];
      probe.onEvent((e) => events.push(e));
      probe.inject({
        type: 'control_request',
        request_id: 'write',
        request: {
          subtype: 'can_use_tool',
          tool_name: tool,
          input: { [tool === 'NotebookEdit' ? 'notebook_path' : 'file_path']: filename },
        },
      });
      expect(probe.frames).toEqual([
        {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'write',
            response: { behavior: 'deny', message: REVIEW_WRITE_DENIAL },
          },
        },
      ]);
      expect(events).toEqual([]);
    }
  },
);

test.each(['applyPatchApproval', 'item/fileChange/requestApproval'])(
  'Codex denies %s outside scratch without asking and allows verdict files',
  async (method) => {
    const note = vi.fn();
    const probe = new CodexProbe(
      { note },
      { session: template, cwd: scratch, review: { worktreePath: worktree } },
    );
    const events: HarnessEmission[] = [];
    probe.onEvent((e) => events.push(e));
    const modern = method.startsWith('item/');
    for (const filename of [path.join(worktree, 'source.ts'), 'escape/source.ts']) {
      if (modern)
        probe.inject({
          method: 'item/started',
          params: { item: { id: 'file', type: 'fileChange', changes: [{ path: filename }] } },
        });
      probe.inject({
        id: 'write',
        method,
        params: modern ? { itemId: 'file' } : { fileChanges: { [filename]: { type: 'add' } } },
      });
      await Promise.resolve();
      expect(probe.frames.at(-1)).toEqual({
        id: 'write',
        result: { decision: modern ? 'decline' : { denied: { rejection: REVIEW_WRITE_DENIAL } } },
      });
    }
    expect(events.some((e) => e.type === 'approval.requested')).toBe(false);
    expect(note).toHaveBeenCalledWith(template.id, REVIEW_WRITE_DENIAL);
    probe.inject({
      id: 'verdict',
      method: 'applyPatchApproval',
      params: { fileChanges: { 'verdict.json': { type: 'add' } } },
    });
    await Promise.resolve();
    expect(probe.frames.at(-1)).toEqual({ id: 'verdict', result: { decision: 'approved' } });
  },
);

test('review commands allow read roots and submit but reject scripts, writes, escapes and Git execution flags', () => {
  const wt = worktree.replace(/\\/g, '/');
  const sc = scratch.replace(/\\/g, '/');
  for (const command of [
    `cd "${wt}" && git diff main...HEAD`,
    ...['diff', 'log', 'show', 'status'].map((verb) => `git -C "${wt}" ${verb}`),
    `cat "${wt}/source.ts"`,
    `grep -n bug "${wt}/source.ts"`,
    `cd "${wt}" && cat source.ts`,
    `helix review submit verdict.json --head abc123`,
    `helix.cmd --json review submit "${sc}/verdict.json" --head abc123`,
    ['powershell.exe', '-NoProfile', '-Command', `git -C "${wt}" diff main...HEAD`],
  ])
    expect(isSafeCommand(command, scratch, [worktree]), String(command)).toBe(true);
  for (const command of [
    `cd "${wt}" && npm test`,
    `cd "${wt}" && npm ci`,
    `npm run build`,
    `cd "${wt}" && node script.js`,
    `npx vitest`,
    `rm source.ts`,
    `git -C "${wt}" diff --output=source.ts`,
    `git diff --ext-diff`,
    `git log --textconv`,
    `git -c core.pager=evil log`,
    `find . -delete`,
    `rg --pre=script pattern .`,
    `cat "${root.replace(/\\/g, '/')}/secret"`,
    `cat ../../secret`,
    `helix review submit "${wt}/verdict.json" --head abc`,
    'helix plan submit plan.json',
    'echo hi > source.ts',
    'git diff; rm source.ts',
  ])
    expect(isSafeCommand(command, scratch, [worktree]), String(command)).toBe(false);
  expect(isSafeCommand('git diff', scratch, [worktree], worktree)).toBe(true);
});

test('review adapters refuse shell write requests and permission expansion', async () => {
  const start = { session: template, cwd: scratch, review: { worktreePath: worktree } };
  const claude = new ClaudeProbe({ autoApproveSafeCommands: true }, start);
  claude.inject({
    type: 'control_request',
    request_id: 'shell',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: `cd "${worktree}" && npm run fix` },
    },
  });
  expect(claude.frames[0]).toMatchObject({ response: { response: { behavior: 'deny' } } });
  const codex = new CodexProbe({ autoApproveSafeCommands: true }, start);
  codex.inject({
    id: 'shell',
    method: 'item/commandExecution/requestApproval',
    params: { command: 'npm run fix', cwd: worktree },
  });
  codex.inject({
    id: 'permissions',
    method: 'item/permissions/requestApproval',
    params: { permissions: { fileSystem: { write: [worktree] } } },
  });
  await Promise.resolve();
  expect(codex.frames).toEqual([
    { id: 'shell', result: { decision: 'decline' } },
    { id: 'permissions', result: { permissions: {}, scope: 'turn' } },
  ]);
  codex.inject({
    id: 'read',
    method: 'item/commandExecution/requestApproval',
    params: { command: 'git diff', cwd: worktree },
  });
  await Promise.resolve();
  expect(codex.frames.at(-1)).toEqual({ id: 'read', result: { decision: 'accept' } });
});

test('Codex reviewer forces scratch workspace-write and network access for local helix CLI', async () => {
  const transcript = path.join(root, 'protocol.jsonl');
  const session = await createHarness('codex', {
    bin: process.execPath,
    extraArgs: [fileURLToPath(new URL('./__fixtures__/fake-cli.cjs', import.meta.url)), 'codex'],
    env: { HELIX_FAKE_TRANSCRIPT: transcript },
    codexSandbox: 'danger-full-access',
  }).start({ session: template, cwd: scratch, review: { worktreePath: worktree } });
  try {
    await session.send('hold', 'queue');
    const frames = (await readFile(transcript, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => record(JSON.parse(line)));
    expect(frames.find((f) => f.method === 'thread/start')!.params).toMatchObject({
      cwd: scratch,
      sandbox: 'workspace-write',
      config: {
        'sandbox_workspace_write.network_access': true,
        'sandbox_workspace_write.writable_roots': [],
      },
    });
    expect(record(frames.find((f) => f.method === 'turn/start')!.params).sandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: [scratch],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
  } finally {
    await session.stop();
  }
}, 20_000);

test('reviewer prompt exports a valid verdict example and names task, base and requested head', () => {
  const example = REVIEWER_PROMPT.match(/```json\n([\s\S]*?)\n```/)![1]!;
  expect(agentReviewSchema.parse(JSON.parse(example)).verdict).toBe('approve');
  const worker = fixtures.crossReviewRun.find(
    (e): e is HelixEvent<'session.created'> =>
      e.type === 'session.created' && e.payload.session.role === 'worker',
  )!.payload.session;
  const pr = fixtures.crossReviewRun.find((e) => e.type === 'pr.opened')!.payload.pr;
  const prompt = reviewerPrompt({
    project: fixtures.crossReviewProject,
    worker,
    reviewer: template,
    pr,
  });
  for (const text of [
    worker.prompt,
    pr.headSha,
    'Base branch: main',
    'CI already passed',
    'Never edit',
    'helix review submit',
    'blocker or',
    'major issues',
  ])
    expect(prompt).toContain(text);
});

test('Claude reviewers read the worktree under review without a prompt, but nothing else', () => {
  const start = { session: template, cwd: scratch, review: { worktreePath: worktree } };
  const allowed = [
    { tool: 'Read', input: { file_path: path.join(worktree, 'src', 'cart.ts') } },
    { tool: 'Glob', input: { pattern: 'src/**/*.ts', path: worktree } },
    { tool: 'Grep', input: { pattern: 'discount', path: worktree } },
    { tool: 'Grep', input: { pattern: 'discount' } },
    { tool: 'LS', input: { path: scratch } },
  ];
  const asked = [
    { tool: 'Read', input: { file_path: path.join(root, 'secret.env') } },
    { tool: 'Glob', input: { pattern: '../**/*.env', path: worktree } },
    { tool: 'Read', input: { file_path: path.join(scratch, 'escape', '..', '..', 'x') } },
  ];
  for (const [expected, cases] of [
    ['allow', allowed],
    ['ask', asked],
  ] as const)
    for (const { tool, input } of cases) {
      const probe = new ClaudeProbe({}, start);
      const events: HarnessEmission[] = [];
      probe.onEvent((e) => events.push(e));
      probe.inject({
        type: 'control_request',
        request_id: 'read',
        request: { subtype: 'can_use_tool', tool_name: tool, input },
      });
      const label = `${tool} ${JSON.stringify(input)}`;
      if (expected === 'allow') {
        expect(probe.frames, label).toEqual([
          {
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: 'read',
              response: { behavior: 'allow', updatedInput: input },
            },
          },
        ]);
        expect(
          events.filter((e) => e.type === 'approval.requested'),
          label,
        ).toEqual([]);
      } else {
        expect(probe.frames, label).toEqual([]);
        expect(
          events.some((e) => e.type === 'approval.requested'),
          label,
        ).toBe(true);
      }
    }
});
