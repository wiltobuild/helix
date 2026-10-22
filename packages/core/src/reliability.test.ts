import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { HarnessInfo } from '@helix/contracts';
import { fixture } from './test-support.js';

afterEach(() => vi.useRealTimers());
const request = { title: 'Task', prompt: 'Do it', agent: 'codex', interface: 'chat' } as const;
test('watchdog emits one note per stall, resumes on the next emission and stops on shutdown', async () => {
  vi.useFakeTimers();
  const f = fixture({ stallTimeoutMs: 1000 });
  const p = await f.add();
  const s = await f.core.createSession(p.id, request, 'one');
  const handle = f.harness.handles.get(s.id)!;
  const active = () => handle.emit({ type: 'activity.changed', payload: { activity: 'active' } });
  const message = () =>
    handle.emit({
      type: 'chat.item',
      payload: { item: { kind: 'message', role: 'assistant', text: 'Progress' } },
    });
  active();
  await f.drain();
  await vi.advanceTimersByTimeAsync(900);
  message();
  await f.drain();
  await vi.advanceTimersByTimeAsync(900);
  expect(f.state(p.id).sessions[s.id]!.activity).toBe('active');
  await vi.advanceTimersByTimeAsync(101);
  await f.drain();
  expect(f.state(p.id).sessions[s.id]!.activity).toBe('unknown');
  const notes = () => f.store.events.filter((e) => e.type === 'explain.note');
  expect(notes()).toHaveLength(1);
  const note = notes()[0]!;
  if (note.type !== 'explain.note') throw new Error('Missing watchdog note');
  expect(note.payload.text).toContain('No activity from Codex');
  await vi.advanceTimersByTimeAsync(5000);
  await f.drain();
  expect(notes()).toHaveLength(1);
  message();
  await f.drain();
  expect(f.state(p.id).sessions[s.id]!.activity).toBe('active');
  await vi.advanceTimersByTimeAsync(1001);
  await f.drain();
  expect(notes()).toHaveLength(2);
  active();
  await f.drain();
  await f.core.shutdown();
  await vi.advanceTimersByTimeAsync(5000);
  expect(notes()).toHaveLength(2);
});
test.each(['idle', 'waiting_input', 'blocked'] as const)(
  'watchdog does not report %s as stalled',
  async (activity) => {
    vi.useFakeTimers();
    const f = fixture({ stallTimeoutMs: 1000 });
    const p = await f.add();
    const s = await f.core.createSession(p.id, request, 'one');
    f.harness.handles.get(s.id)!.emit({ type: 'activity.changed', payload: { activity } });
    await f.drain();
    await vi.advanceTimersByTimeAsync(10000);
    await f.drain();
    expect(f.store.events.some((e) => e.type === 'explain.note')).toBe(false);
    await f.core.shutdown();
  },
);
test('next user message reaches a pending question during the current turn; ordinary queued messages still wait', async () => {
  const f = fixture();
  const p = await f.add();
  const s = await f.core.createSession(p.id, request, 'one');
  const handle = f.harness.handles.get(s.id)!;
  handle.emit({
    type: 'chat.item',
    payload: { item: { kind: 'question', prompt: 'Which color?' } },
  });
  handle.emit({ type: 'activity.changed', payload: { activity: 'waiting_input' } });
  await f.drain();
  await f.core.sendMessage(s.id, { text: 'Blue', mode: 'queue' });
  expect(handle.send).toHaveBeenLastCalledWith('Blue', 'queue');
  handle.emit({ type: 'activity.changed', payload: { activity: 'active' } });
  await f.drain();
  await f.core.sendMessage(s.id, { text: 'Next task', mode: 'queue' });
  expect(handle.send).toHaveBeenCalledTimes(2);
  await f.core.shutdown();
});
test.each([
  [
    [
      { agent: 'claude-code', installed: true, signedIn: true },
      { agent: 'codex', installed: true, signedIn: true },
    ],
    'codex',
  ],
  [
    [
      { agent: 'codex', installed: true, signedIn: false },
      { agent: 'claude-code', installed: true, signedIn: true },
    ],
    'claude-code',
  ],
  [
    [
      { agent: 'codex', installed: false, signedIn: true },
      { agent: 'claude-code', installed: true, signedIn: true },
    ],
    'claude-code',
  ],
] as [HarnessInfo[], string][])(
  'project defaults select installed and signed-in harnesses',
  async (detected, expected) => {
    const f = fixture({ detectHarnesses: () => Promise.resolve(detected) });
    expect((await f.add()).defaultAgent).toBe(expected);
  },
);
test('no signed-in harness fails clearly instead of storing an unusable default', async () => {
  const f = fixture({
    detectHarnesses: () =>
      Promise.resolve([{ agent: 'codex', installed: true, signedIn: 'unknown' }]),
  });
  await expect(f.add()).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE' });
  expect(f.store.events).toEqual([]);
});
test('repoPath retains user casing while Windows lookup remains case-insensitive', async () => {
  const f = fixture();
  const original = path.resolve('UserRepo', 'MixedCase');
  const p = await f.core.addProject({ repoPath: original });
  expect(p.repoPath).toBe(original);
  expect(p.name).toBe('MixedCase');
  expect(f.git.isGitRepo).toHaveBeenCalledWith(original);
  if (process.platform === 'win32') {
    expect(await f.core.addProject({ repoPath: original.toLowerCase() })).toEqual(p);
    expect(f.store.events).toHaveLength(1);
  }
});
