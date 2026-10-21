import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fixtures,
  eventSchemas,
  HelixError,
  type ApprovingHarnessSession,
  type HarnessEmission,
  type HarnessStartOptions,
  type KnownAgentKind,
  type Session,
} from '@helix/contracts';
import { createHarness, detectAll } from './index.js';
import type { HarnessOptions } from './options.js';
import { quoteCmdArgument, resolveExecutable, spawnExecutable } from './process.js';
import { record } from './protocol.js';
import { HELIX_GIT_INSTRUCTIONS } from './git-policy.js';

const executable = fileURLToPath(new URL('./__fixtures__/fake-cli.cjs', import.meta.url));
const api = fixtures.passwordResetRun.find(
  (event) =>
    event.type === 'session.created' && event.payload.session.id === fixtures.passwordResetIds.api,
);
if (!api || api.type !== 'session.created') throw new Error('Missing API fixture');
const template: Session = api.payload.session;
const sessions: ApprovingHarnessSession[] = [];
const directories: string[] = [];
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'helix-harness-'));
  directories.push(path);
  return path;
}
function opts(kind: KnownAgentKind, env: Record<string, string> = {}): HarnessOptions {
  return {
    bin: process.execPath,
    extraArgs: [executable, kind === 'codex' ? 'codex' : 'claude'],
    env,
    requestTimeoutMs: 15_000,
  };
}
async function start(
  kind: KnownAgentKind,
  prompt: string,
  env: Record<string, string> = {},
  resumeToken?: string,
) {
  const cwd = await directory();
  const options: HarnessStartOptions = {
    cwd,
    session: { ...template, agent: kind, prompt },
    ...(resumeToken ? { resumeToken } : {}),
  };
  const session = await createHarness(kind, opts(kind, env)).start(options);
  sessions.push(session);
  const events: HarnessEmission[] = [];
  session.onEvent((event) => events.push(event));
  expect(messages(events)).toEqual([]);
  if (!resumeToken) await session.send(prompt, 'queue');
  return { session, events, cwd };
}
function messages(events: HarnessEmission[]): string[] {
  return events.flatMap((event) =>
    event.type === 'chat.item' && event.payload.item.kind === 'message'
      ? [event.payload.item.text]
      : [],
  );
}
function activities(events: HarnessEmission[]): string[] {
  return events.flatMap((event) =>
    event.type === 'activity.changed' ? [event.payload.activity] : [],
  );
}
async function transcript(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.stop()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('debug mode captures both directions of a real JSONL transport with no unanswered requests', async () => {
  const cwd = await directory();
  const session = await createHarness('codex', {
    ...opts('codex', { HELIX_DEBUG_PROTOCOL: '1' }),
    dataDir: cwd,
  }).start({ cwd, session: { ...template, agent: 'codex' } });
  sessions.push(session);
  const events: HarnessEmission[] = [];
  session.onEvent((event) => events.push(event));
  await session.send('approve', 'queue');
  await expect.poll(() => events.some((e) => e.type === 'approval.requested')).toBe(true);
  const approval = events.find((e) => e.type === 'approval.requested')!;
  if (approval.type !== 'approval.requested') throw new Error('Missing approval');
  await session.decide(approval.payload.approval.id, 'approved');
  await expect.poll(() => activities(events).at(-1)).toBe('idle');
  const rows = await transcript(join(cwd, 'logs', `${template.id}.protocol.jsonl`));
  const pending = new Set<unknown>();
  for (const row of rows) {
    const frame = record(row.frame);
    if (row.direction === 'in' && frame.id !== undefined && frame.method) pending.add(frame.id);
    if (row.direction === 'out' && frame.id !== undefined && !frame.method)
      pending.delete(frame.id);
  }
  expect(pending.size).toBe(0);
  expect(
    rows.some((row) => row.direction === 'out' && record(row.frame).method === 'thread/start'),
  ).toBe(true);
  expect(
    rows.some(
      (row) =>
        row.direction === 'in' &&
        record(row.frame).method === 'item/commandExecution/requestApproval',
    ),
  ).toBe(true);
  expect(
    rows.some((row) => row.direction === 'out' && record(row.frame).id === 'server-approval'),
  ).toBe(true);
}, 30_000);

it.each([undefined, 'existing-thread'])(
  'gives Codex Helix Git instructions without extra writable roots on start/resume (%s)',
  async (resumeToken) => {
    const cwd = await directory();
    const transcriptPath = join(cwd, 'transcript.jsonl');
    const options = opts('codex', { HELIX_FAKE_TRANSCRIPT: transcriptPath });
    const session = await createHarness('codex', options).start({
      cwd,
      session: { ...template, agent: 'codex' },
      ...(resumeToken ? { resumeToken } : {}),
    });
    sessions.push(session);
    const method = resumeToken ? 'thread/resume' : 'thread/start';
    const frame = (await transcript(transcriptPath)).find((row) => row.method === method)!;
    expect(record(frame.params)).not.toHaveProperty('config');
    expect(record(frame.params).developerInstructions).toBe(HELIX_GIT_INSTRUCTIONS);
    expect(record(frame.params).sandbox).toBe('workspace-write');
    expect(record(frame.params).approvalPolicy).toBe('on-request');
  },
  30_000,
);

it('appends the Git ownership instruction to the Claude system prompt', async () => {
  const cwd = await directory();
  const argsPath = join(cwd, 'args.json');
  const session = await createHarness(
    'claude-code',
    opts('claude-code', { HELIX_FAKE_ARGS_FILE: argsPath }),
  ).start({ cwd, session: { ...template, agent: 'claude-code' } });
  sessions.push(session);
  const args = JSON.parse(await readFile(argsPath, 'utf8')) as string[];
  expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(HELIX_GIT_INSTRUCTIONS);
}, 30_000);

describe.each(['claude-code', 'codex'] as const)('%s process lifecycle', (kind) => {
  it('replays fixture approvals, errors and unknown messages through the live transport', async () => {
    const path = fileURLToPath(
      new URL(`./__fixtures__/${kind === 'codex' ? 'codex' : 'claude'}.jsonl`, import.meta.url),
    );
    const { session, events } = await start(kind, 'fixture', { HELIX_FAKE_FIXTURE: path });
    await expect.poll(() => messages(events), { timeout: 10_000 }).toContain('Fixture error');
    await expect.poll(() => activities(events).at(-1)).toBe('idle');
    expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
    expect(events.some((event) => event.type === 'reasoning.summary')).toBe(true);
    expect(messages(events).filter((text) => text === 'I will inspect the API.')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|RAW REASONING/);
    expect(messages(events)).not.toContain('Other thread must not appear');
    expect(session.resumeToken).toBe('fixture-thread');
    expect(activities(events)).not.toContain('exited');
    await session.stop();
  }, 30_000);

  it('flushes the final unterminated line before an actual process exit', async () => {
    const { events } = await start(kind, 'exit');
    await expect.poll(() => activities(events).at(-1), { timeout: 10_000 }).toBe('exited');
    expect(messages(events)).toContain('final without newline');
  }, 30_000);

  it('buffers startup, runs one explicit send per turn, and emits exit only after stop', async () => {
    const { session, events } = await start(kind, 'first');
    await expect.poll(() => activities(events).at(-1)).toBe('idle');
    await session.send('second', 'queue');
    await expect.poll(() => messages(events)).toEqual(['first', 'second']);
    await expect.poll(() => activities(events).at(-1)).toBe('idle');
    await session.send('third', 'queue');
    await expect
      .poll(() => messages(events), { timeout: 5000 })
      .toEqual(['first', 'second', 'third']);
    expect(activities(events).slice(0, 3)).toEqual(['starting', 'idle', 'active']);
    expect(activities(events)).not.toContain('exited');
    for (const event of events)
      expect(eventSchemas[event.type].shape.payload.safeParse(event.payload).success).toBe(true);
    await Promise.all([session.stop(), session.stop()]);
    expect(activities(events).filter((value) => value === 'exited')).toHaveLength(1);
    await expect(session.send('late', 'queue')).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 20_000);

  it('rejects overlapping sends and interrupts before sending a replacement', async () => {
    const { session, events } = await start(kind, 'hold');
    await expect(session.send('queued', 'queue')).rejects.toMatchObject({ code: 'CONFLICT' });
    await session.send('replacement', 'interrupt');
    await expect
      .poll(() => messages(events), { timeout: 5000 })
      .toEqual(['interrupted', 'replacement']);
    expect(activities(events)).not.toContain('exited');
  }, 20_000);

  it('supports standalone interrupt, resume, and safely transports prompt metacharacters', async () => {
    const { session, events } = await start(kind, 'hold', {}, 'previous-session');
    expect(messages(events)).toEqual([]);
    await session.send('hold', 'queue');
    await session.interrupt();
    expect(session.resumeToken).toBe('previous-session');
    const text = 'quotes " & | %PATH% !NAME! ^ < >\nUTF-8 hé🙂';
    await session.send(text, 'queue');
    await expect.poll(() => messages(events), { timeout: 5000 }).toEqual(['interrupted', text]);
  }, 20_000);

  it.each(['approved', 'rejected', 'changes_requested'] as const)(
    'resolves %s permissions through the correct wire response',
    async (decision) => {
      const path = join(await directory(), 'transcript.jsonl');
      const { session, events } = await start(kind, 'approve', { HELIX_FAKE_TRANSCRIPT: path });
      await expect
        .poll(() => events.some((event) => event.type === 'approval.requested'))
        .toBe(true);
      const event = events.find((event) => event.type === 'approval.requested');
      if (!event || event.type !== 'approval.requested') throw new Error('Missing approval');
      expect(event.payload.approval.sessionId).toBe(template.id);
      expect(activities(events)).toContain('waiting_input');
      await session.decide(event.payload.approval.id, decision);
      await expect.poll(() => messages(events)).toContain('approval handled');
      const rows = await transcript(path);
      if (kind === 'claude-code') {
        const response = record(rows.find((row) => row.type === 'control_response')?.response);
        expect(response.request_id).toBe('server-approval');
        expect(record(response.response).behavior).toBe(decision === 'approved' ? 'allow' : 'deny');
      } else
        expect(rows).toContainEqual({
          id: 'server-approval',
          result: {
            decision:
              decision === 'approved'
                ? 'accept'
                : decision === 'changes_requested'
                  ? 'cancel'
                  : 'decline',
          },
        });
      await expect(session.decide(event.payload.approval.id, decision)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    },
    20_000,
  );

  it('recovers from non-JSON noise without inventing process exits', async () => {
    const { events } = await start(kind, 'noise');
    await expect.poll(() => messages(events)).toContain('noise');
    expect(activities(events)).toContain('unknown');
    await expect.poll(() => activities(events).at(-1)).toBe('idle');
    expect(activities(events)).not.toContain('exited');
  }, 20_000);

  it.each(['error', 'exit', 'timeout'])(
    'cleans up a failed %s handshake',
    async (scenario) => {
      const cwd = await directory();
      await expect(
        createHarness(kind, {
          ...opts(kind, { HELIX_FAKE_SCENARIO: scenario }),
          requestTimeoutMs: scenario === 'timeout' ? 5000 : 15_000,
        }).start({ cwd, session: template }),
      ).rejects.toMatchObject({
        code: 'HARNESS_UNAVAILABLE',
        message:
          scenario === 'error'
            ? 'Fixture initialization rejected'
            : scenario === 'exit'
              ? 'Harness process exited'
              : 'Harness request timed out',
      });
    },
    20_000,
  );

  it('kills a descendant process, not only the immediate process', async () => {
    const childPath = join(await directory(), 'child.pid');
    const { session } = await start(kind, 'hold', { HELIX_FAKE_CHILD_FILE: childPath });
    const childPid = Number(await readFile(childPath, 'utf8'));
    expect(() => process.kill(childPid, 0)).not.toThrow();
    await session.stop();
    await expect
      .poll(
        () => {
          try {
            process.kill(childPid, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 5000 },
      )
      .toBe(false);
  }, 20_000);
});

describe('detection and executable resolution', () => {
  it.each(['approve-files', 'approve-permissions'])(
    'resolves Codex %s with the proper response shape',
    async (prompt) => {
      const path = join(await directory(), 'transcript.jsonl');
      const { session, events } = await start('codex', prompt, { HELIX_FAKE_TRANSCRIPT: path });
      await expect
        .poll(() => events.some((event) => event.type === 'approval.requested'), {
          timeout: 10_000,
        })
        .toBe(true);
      const event = events.find((event) => event.type === 'approval.requested');
      if (!event || event.type !== 'approval.requested') throw new Error('Missing approval');
      await session.decide(event.payload.approval.id, 'approved');
      await expect.poll(() => messages(events)).toContain('approval handled');
      expect(await transcript(path)).toContainEqual({
        id: 'server-approval',
        result:
          prompt === 'approve-files'
            ? { decision: 'accept' }
            : { permissions: { network: { enabled: true } }, scope: 'turn' },
      });
    },
    30_000,
  );

  it('detects both fake CLIs and auth without invoking real agents', async () => {
    expect(await detectAll({ 'claude-code': opts('claude-code'), codex: opts('codex') })).toEqual([
      { agent: 'claude-code', installed: true, version: 'fixture-cli 1.0.0', signedIn: true },
      { agent: 'codex', installed: true, version: 'fixture-cli 1.0.0', signedIn: true },
    ]);
  }, 20_000);
  it('never throws for missing executables and reports typed domain errors', async () => {
    const harness = createHarness('codex', { bin: join(await directory(), 'missing') });
    expect(await harness.detect()).toEqual({
      agent: 'codex',
      installed: false,
      signedIn: 'unknown',
    });
    await expect(harness.start({ cwd: process.cwd(), session: template })).rejects.toMatchObject({
      code: 'HARNESS_UNAVAILABLE',
    });
    expect(() => createHarness('future')).toThrow(HelixError);
    await expect(
      createHarness('codex').start({
        cwd: process.cwd(),
        session: { ...template, interface: 'terminal' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('resolves explicit executable paths and quotes a restricted batch argument set', async () => {
    expect(await resolveExecutable(process.execPath)).toBe(process.execPath);
    expect(quoteCmdArgument('space & (more)')).toBe('"space & (more)"');
    for (const arg of ['%PATH%', '!cmd!', '" & echo injection', 'line\nbreak', '^escape'])
      expect(() => quoteCmdArgument(arg)).toThrow(HelixError);
  });
  it.skipIf(process.platform !== 'win32')(
    'resolves PATH + PATHEXT and runs a .cmd shim in a path containing spaces and ampersands',
    async () => {
      const cwd = await directory();
      const shim = join(cwd, 'fixture & CLI.cmd');
      await writeFile(shim, `@echo off\r\n"${process.execPath}" "${executable}" %*\r\n`);
      expect(
        (
          await resolveExecutable('fixture & CLI', { Path: cwd, PATHEXT: '.EXE;.CMD' })
        )?.toLowerCase(),
      ).toBe(shim.toLowerCase());
      const child = spawnExecutable(shim, ['claude', '--version'], {}, cwd);
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const exit = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      expect(exit).toBe(0);
      expect(output.trim()).toBe('fixture-cli 1.0.0');
    },
    20_000,
  );
});
