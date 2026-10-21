import { expect, test } from 'vitest';
import { fixtures, type HarnessEmission } from '@helix/contracts';
import { ClaudeSession } from './claude.js';
import { HELIX_GIT_INSTRUCTIONS, isGitWriteCommand } from './git-policy.js';

test.each(
  [
    'git add -A',
    'git commit -m "work"',
    'git push origin HEAD',
    'git -C "C:\\repo with spaces" -c user.name=Helix commit -m work',
    'git status; git switch -c task',
    'git status\r\ngit commit -m work',
    'git branch task',
    'git checkout -b task',
    [
      'powershell.exe',
      '-NoProfile',
      '-Command',
      'Set-Location repo; git add .; git commit -m done',
    ],
    ['bash', '-lc', 'git add . && git commit -m done'],
    '"C:\\Program Files\\Git\\bin\\git.exe" commit -m done',
    'git config user.name Someone',
    'git worktree add ../work',
  ].map((command) => ({ command })),
)('recognizes a Git write: $command', ({ command }) =>
  expect(isGitWriteCommand(command)).toBe(true),
);

test.each([
  'npm install',
  'git status --short',
  'git diff --stat',
  'git log -1',
  'git -C "C:\\repo with spaces" rev-parse HEAD',
  'git branch --show-current',
  'git branch --list "helix/*"',
  'git worktree list',
  'git config --get user.name',
  'echo "git commit"',
  'echo git commit',
  'cat git-notes.md',
])('leaves ordinary/read-only command approvals to the user: %s', (command) =>
  expect(isGitWriteCommand(command)).toBe(false),
);

class Probe extends ClaudeSession {
  frames: unknown[] = [];
  protected override write(frame: unknown): Promise<void> {
    this.frames.push(frame);
    return Promise.resolve();
  }
  inject(frame: unknown): void {
    this.receive(frame);
  }
}
const created = fixtures.passwordResetRun.find((e) => e.type === 'session.created')!;
if (created.type !== 'session.created') throw new Error('Missing session');

test('Claude denies Git writes with instructions and a note, without surfacing an approval', () => {
  const notes: string[] = [];
  const probe = new Probe(
    { note: (_id, text) => notes.push(text) },
    { cwd: '.', session: created.payload.session },
  );
  const events: HarnessEmission[] = [];
  probe.onEvent((event) => events.push(event));
  probe.inject({
    type: 'control_request',
    request_id: 'git',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'git add . && git commit -m work' },
    },
  });
  expect(probe.frames).toEqual([
    {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'git',
        response: { behavior: 'deny', message: HELIX_GIT_INSTRUCTIONS },
      },
    },
  ]);
  expect(notes).toEqual([`Declined agent Git write: ${HELIX_GIT_INSTRUCTIONS}`]);
  expect(events).toEqual([]);
  probe.inject({
    type: 'control_request',
    request_id: 'other',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'npm install' },
    },
  });
  expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
});
