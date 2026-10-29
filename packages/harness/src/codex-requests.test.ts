import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  fixtures,
  eventSchemas,
  type HarnessEmission,
  type ApprovalDecision,
} from '@helix/contracts';
import { CodexSession } from './codex.js';
import { HELIX_GIT_INSTRUCTIONS } from './git-policy.js';

// Shapes checked against codex app-server generate-json-schema, 2026-10-20.
const created = fixtures.passwordResetRun.find((e) => e.type === 'session.created')!;
if (created.type !== 'session.created') throw new Error('Missing session');
const template = created.payload.session;
class Probe extends CodexSession {
  frames: unknown[] = [];
  protected override write(frame: unknown): Promise<void> {
    this.frames.push(frame);
    return Promise.resolve();
  }
  protected override ensureOpen(): void {}
  inject(frame: unknown): void {
    this.receive(frame);
  }
  running(): void {
    this.busy = true;
    this.resumeToken = 'thread';
  }
}
let root: string;
let probe: Probe;
let events: HarnessEmission[];
let note = vi.fn<(sessionId: string, message: string) => void>();
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'helix-requests-'));
  mkdirSync(path.join(root, 'worktree'));
  note = vi.fn();
  probe = new Probe({ note }, { cwd: path.join(root, 'worktree'), session: template });
  probe.running();
  events = [];
  probe.onEvent((e) => {
    expect(eventSchemas[e.type].shape.payload.safeParse(e.payload).success).toBe(true);
    events.push(e);
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const base = { threadId: 'thread', turnId: 'turn', itemId: 'item', startedAtMs: 1 };
const approvals = [
  {
    method: 'item/commandExecution/requestApproval',
    params: { ...base, command: 'npm install', cwd: '.', commandActions: [] },
  },
  { method: 'item/fileChange/requestApproval', params: base },
  {
    method: 'item/permissions/requestApproval',
    params: { ...base, cwd: '.', permissions: { network: { enabled: true } } },
  },
  {
    method: 'applyPatchApproval',
    params: {
      conversationId: 'thread',
      callId: 'item',
      fileChanges: { '../outside.md': { type: 'add', content: 'hello' } },
    },
  },
  {
    method: 'execCommandApproval',
    params: {
      conversationId: 'thread',
      callId: 'item',
      command: ['npm', 'install'],
      cwd: '.',
      parsedCmd: [],
    },
  },
];
test('legacy Git command approval is denied with the Helix commit explanation', async () => {
  probe.inject({
    id: 'git',
    method: 'execCommandApproval',
    params: {
      conversationId: 'thread',
      callId: 'git',
      command: ['powershell.exe', '-Command', 'git add .; git commit -m task'],
      cwd: '.',
      parsedCmd: [],
    },
  });
  await Promise.resolve();
  expect(probe.frames).toEqual([
    { id: 'git', result: { decision: { denied: { rejection: HELIX_GIT_INSTRUCTIONS } } } },
  ]);
  expect(events).toEqual([]);
  expect(note).toHaveBeenCalledWith(template.id, expect.stringContaining('Helix commits'));
});
test('modern Git command approval is declined and the active turn receives the explanation', async () => {
  probe.inject({
    id: 'git',
    method: 'item/commandExecution/requestApproval',
    params: { ...base, command: 'git -C repo push', commandActions: [] },
  });
  await Promise.resolve();
  expect(probe.frames[0]).toEqual({ id: 'git', result: { decision: 'decline' } });
  expect(probe.frames[1]).toEqual({
    id: 1,
    method: 'turn/steer',
    params: {
      threadId: 'thread',
      expectedTurnId: 'turn',
      input: [{ type: 'text', text: HELIX_GIT_INSTRUCTIONS, text_elements: [] }],
    },
  });
  probe.inject({ id: 1, result: { turnId: 'turn' } });
  expect(events).toEqual([]);
  expect(note).toHaveBeenCalledWith(template.id, expect.stringContaining('Helix commits'));
});
describe.each(approvals)('$method', ({ method, params }) => {
  test.each<ApprovalDecision>(['approved', 'rejected', 'changes_requested'])(
    'responds exactly once to %s with its schema response',
    async (decision) => {
      probe.inject({ id: 'approval', method, params });
      const event = events.find((e) => e.type === 'approval.requested');
      expect(event?.type).toBe('approval.requested');
      if (event?.type !== 'approval.requested') throw new Error('Missing approval');
      expect(probe.frames).toEqual([]);
      await probe.decide(event.payload.approval.id, decision);
      const legacy = method === 'applyPatchApproval' || method === 'execCommandApproval';
      const result =
        method === 'item/permissions/requestApproval'
          ? {
              permissions: decision === 'approved' ? { network: { enabled: true } } : {},
              scope: 'turn',
            }
          : {
              decision: legacy
                ? decision === 'approved'
                  ? 'approved'
                  : decision === 'changes_requested'
                    ? 'abort'
                    : { denied: { rejection: 'Rejected by the user in Helix' } }
                : decision === 'approved'
                  ? 'accept'
                  : decision === 'changes_requested'
                    ? 'cancel'
                    : 'decline',
            };
      expect(probe.frames).toEqual([{ id: 'approval', result }]);
      await expect(probe.decide(event.payload.approval.id, decision)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    },
  );
});
test.each([
  [
    'mcpServer/elicitation/request',
    {
      threadId: 'thread',
      serverName: 'test',
      mode: 'form',
      message: 'Input',
      requestedSchema: { type: 'object', properties: {} },
    },
    { action: 'decline', content: null },
  ],
  [
    'item/tool/call',
    { threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'external', arguments: {} },
    {
      success: false,
      contentItems: [
        { type: 'inputText', text: 'Helix does not support Codex server request: item/tool/call' },
      ],
    },
  ],
] as const)(
  '%s receives a schema decline immediately and an explanation',
  async (method, params, result) => {
    probe.inject({ id: 7, method, params });
    await Promise.resolve();
    expect(probe.frames).toEqual([{ id: 7, result }]);
    expect(note).toHaveBeenCalledWith(template.id, expect.stringContaining(method));
    expect(events).toEqual([]);
  },
);
test.each([
  ['attestation/generate', {}, -32000],
  [
    'account/chatgptAuthTokens/refresh',
    { reason: 'unauthorized', previousAccountId: null },
    -32000,
  ],
  ['future/unknown', { threadId: 'subagent' }, -32601],
] as const)(
  '%s gets a JSON-RPC error (never fake credentials) and an explanation',
  async (method, params, code) => {
    probe.inject({ id: 0, method, params });
    await Promise.resolve();
    expect(probe.frames).toEqual([
      { id: 0, error: { code, message: `Helix does not support Codex server request: ${method}` } },
    ]);
    expect(note).toHaveBeenCalledOnce();
  },
);
test('item/tool/requestUserInput uses the next messages as per-question answers, without starting/interruption of a turn', async () => {
  probe.inject({
    id: 'question',
    method: 'item/tool/requestUserInput',
    params: {
      ...base,
      isBlocking: true,
      questions: [
        {
          id: 'color',
          header: 'Color',
          question: 'Which color?',
          options: [{ label: 'Blue', description: 'Blue paint' }],
        },
        { id: 'size', header: 'Size', question: 'Which size?', options: null },
      ],
    },
  });
  expect(events).toContainEqual({
    type: 'chat.item',
    payload: { item: { kind: 'question', prompt: 'Which color?', options: ['Blue'] } },
  });
  expect(events.at(-1)).toMatchObject({ payload: { activity: 'waiting_input' } });
  await probe.send('Blue', 'queue');
  expect(probe.frames).toEqual([]);
  expect(events.at(-1)).toMatchObject({ payload: { item: { prompt: 'Which size?' } } });
  await probe.send('Large', 'interrupt');
  expect(probe.frames).toEqual([
    {
      id: 'question',
      result: { answers: { color: { answers: ['Blue'] }, size: { answers: ['Large'] } } },
    },
  ]);
  expect(events.at(-1)).toMatchObject({ payload: { activity: 'active' } });
});
test.each(['applyPatchApproval', 'item/fileChange/requestApproval'])(
  '%s auto-approves only known worktree paths, including subagent requests',
  async (method) => {
    const filename = path.join(root, 'worktree', 'HELLO.md');
    probe.inject({
      method: 'item/started',
      params: {
        ...base,
        threadId: 'subagent',
        item: {
          id: 'item',
          type: 'fileChange',
          changes: [{ path: filename, kind: { type: 'add' }, diff: '+hello' }],
        },
      },
    });
    probe.inject({
      id: 'auto',
      method,
      params: {
        ...base,
        threadId: 'subagent',
        conversationId: 'subagent',
        callId: 'item',
        fileChanges: { [filename]: { type: 'add', content: 'hello' } },
      },
    });
    await Promise.resolve();
    expect(probe.frames).toEqual([
      { id: 'auto', result: { decision: method === 'applyPatchApproval' ? 'approved' : 'accept' } },
    ]);
    expect(events.filter((e) => e.type === 'approval.requested')).toEqual([]);
    expect(note).toHaveBeenCalledWith(template.id, expect.stringContaining('auto-approved'));
  },
);
test.each(['mixed', 'rename', 'prefix', 'junction', 'empty'])(
  'does not auto-approve %s paths',
  (scenario) => {
    const filename = path.join(root, 'worktree', 'HELLO.md');
    const changes: Record<string, unknown> = { [filename]: { type: 'add', content: 'hello' } };
    if (scenario === 'mixed')
      changes[path.join(root, 'outside.md')] = { type: 'add', content: 'outside' };
    if (scenario === 'rename')
      changes[filename] = {
        type: 'update',
        unified_diff: '',
        move_path: path.join(root, 'outside.md'),
      };
    if (scenario === 'prefix') {
      delete changes[filename];
      changes[path.join(root, 'worktree-other', 'x')] = { type: 'add', content: '' };
    }
    if (scenario === 'junction') {
      const outside = path.join(root, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, path.join(root, 'worktree', 'link'), 'junction');
      delete changes[filename];
      changes[path.join(root, 'worktree', 'link', 'x')] = { type: 'add', content: '' };
    }
    probe.inject({
      id: 1,
      method: 'applyPatchApproval',
      params: {
        conversationId: 'thread',
        callId: 'item',
        fileChanges: scenario === 'empty' ? {} : changes,
      },
    });
    expect(probe.frames).toEqual([]);
    expect(events[0]?.type).toBe('approval.requested');
  },
);
test('v2 rename destination outside the worktree requires user approval', () => {
  probe.inject({
    method: 'item/started',
    params: {
      ...base,
      item: {
        id: 'item',
        type: 'fileChange',
        changes: [{ path: 'a.md', kind: { type: 'update', move_path: '../outside.md' }, diff: '' }],
      },
    },
  });
  probe.inject({ id: 1, method: 'item/fileChange/requestApproval', params: base });
  expect(probe.frames).toEqual([]);
  expect(events.some((e) => e.type === 'approval.requested')).toBe(true);
});

test('patchUpdated replaces the file paths before v2 approval', async () => {
  probe.inject({
    method: 'item/fileChange/patchUpdated',
    params: { ...base, changes: [{ path: 'new.md', kind: { type: 'add' }, diff: '+hello' }] },
  });
  probe.inject({ id: 'patch', method: 'item/fileChange/requestApproval', params: base });
  await Promise.resolve();
  expect(probe.frames).toEqual([{ id: 'patch', result: { decision: 'accept' } }]);
});

test('relative paths from a subagent with an unknown cwd require approval', () => {
  probe.inject({
    id: 'relative',
    method: 'applyPatchApproval',
    params: {
      conversationId: 'subagent',
      callId: 'call',
      fileChanges: { 'HELLO.md': { type: 'add', content: 'hello' } },
    },
  });
  expect(probe.frames).toEqual([]);
  expect(events[0]?.type).toBe('approval.requested');
});

test('resolving an approval does not clear a simultaneous pending question', async () => {
  probe.inject({ id: 'approval', method: approvals[0]!.method, params: approvals[0]!.params });
  probe.inject({
    id: 'question',
    method: 'item/tool/requestUserInput',
    params: {
      ...base,
      isBlocking: true,
      questions: [{ id: 'q', header: 'Choice', question: 'Which?' }],
    },
  });
  const approval = events.find((e) => e.type === 'approval.requested')!;
  if (approval.type !== 'approval.requested') throw new Error('Missing approval');
  await probe.decide(approval.payload.approval.id, 'approved');
  expect(events.filter((e) => e.type === 'activity.changed').at(-1)).toMatchObject({
    payload: { activity: 'waiting_input' },
  });
  await probe.send('This', 'queue');
  expect(probe.frames.at(-1)).toEqual({
    id: 'question',
    result: { answers: { q: { answers: ['This'] } } },
  });
});

test('cancelled questions advance to the next request and completed turns close pending requests', () => {
  for (const id of ['first', 'second'])
    probe.inject({
      id,
      method: 'item/tool/requestUserInput',
      params: { ...base, isBlocking: true, questions: [{ id, header: 'Choice', question: id }] },
    });
  probe.inject({ method: 'serverRequest/resolved', params: { requestId: 'first' } });
  expect(events.at(-1)).toMatchObject({ payload: { item: { prompt: 'second' } } });
  probe.inject({ id: 'approval', method: approvals[0]!.method, params: approvals[0]!.params });
  probe.inject({
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } },
  });
  expect(probe.frames).toEqual([
    { id: 'second', result: { answers: {} } },
    { id: 'approval', result: { decision: 'cancel' } },
  ]);
});

test('with auto-approval on, Codex runs project scripts in its worktree without an approval', () => {
  const auto = new Probe(
    { note, autoApproveSafeCommands: true },
    { cwd: path.join(root, 'worktree'), session: template },
  );
  auto.running();
  const seen: HarnessEmission[] = [];
  auto.onEvent((e) => seen.push(e));
  const ps = (script: string) =>
    `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command '${script}'`;
  const request = (id: string, command: string, cwd = '.') =>
    auto.inject({
      id,
      method: 'item/commandExecution/requestApproval',
      params: { ...base, command, cwd, commandActions: [] },
    });
  request('ci', ps('npm run ci'));
  request('elsewhere', ps('npm run ci'), root);
  request('net', ps('curl https://example.com'));
  expect(auto.frames).toEqual([{ id: 'ci', result: { decision: 'accept' } }]);
  expect(seen.filter((e) => e.type === 'approval.requested')).toHaveLength(2);
});
