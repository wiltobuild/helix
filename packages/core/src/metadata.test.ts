import { expect, test } from 'vitest';
import { createHelixCore } from './index.js';
import { fixture, red } from './test-support.js';

const RESUME = 'helix:core:resume:v1';
const DELIVERY = 'helix:core:delivered:v1';
const MESSAGE = 'helix:core:message:v1';
const request = { title: 'Worker', prompt: 'Do it', agent: 'codex', interface: 'chat' } as const;

test('resume metadata replaces the latest token per session without creating idempotency records', async () => {
  const f = fixture();
  const p = await f.add();
  const s = await f.core.createSession(p.id, request, 'worker');
  const handle = f.harness.handles.get(s.id)!;
  for (const token of ['token-2', 'token-3']) {
    handle.resumeToken = token;
    handle.emit({ type: 'reasoning.summary', payload: { text: 'Progress', source: 'agent' } });
    await f.drain();
  }
  expect(await f.store.getMeta(RESUME, s.id)).toBe('token-3');
  expect(
    [...f.store.metadata.keys()].filter((key) => (JSON.parse(key) as string[])[0] === RESUME),
  ).toHaveLength(1);
  expect(
    [...f.store.records.keys()].some((key) =>
      [RESUME, DELIVERY, MESSAGE].includes((JSON.parse(key) as [string, string])[0]),
    ),
  ).toBe(false);
  // New metadata wins even if an old event record still exists.
  await f.store.remember(RESUME, `${s.id}:${f.store.events.at(-1)!.seq}`, 'v1', 'old-token');
  const restarted = createHelixCore(f.deps);
  await restarted.start();
  expect(f.harness.start).toHaveBeenLastCalledWith(
    expect.objectContaining({ resumeToken: 'token-3' }),
  );
  expect(f.harness.handles.get(s.id)!.send).not.toHaveBeenCalled();
  await restarted.shutdown();
});

test('upgrade reads through legacy tokens, initial/user/feedback receipts and queued message modes', async () => {
  const f = fixture();
  const p = await f.add();
  const s = await f.core.createSession(p.id, request, 'worker');
  const handle = f.harness.handles.get(s.id)!;
  f.git.ahead = 1;
  handle.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await f.drain();
  await f.core.sendMessage(s.id, { text: 'Already delivered user message', mode: 'queue' });
  handle.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await f.drain();
  const pr = f.state(p.id).sessions[s.id]!.pr!;
  f.scm.emit(p.id, pr.number, {
    type: 'ci.updated',
    payload: { prNumber: pr.number, checks: red },
  });
  await f.drain();
  handle.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  handle.emit({ type: 'activity.changed', payload: { activity: 'blocked' } });
  await f.drain();
  await f.core.sendMessage(s.id, { text: 'Queued user message', mode: 'queue' });
  await f.core.sendMessage(s.id, { text: 'Interrupt first', mode: 'interrupt' });
  // Recreate the immutable metadata layout used by an old daemon mid-session.
  for (const [key, value] of f.store.metadata) {
    const [scope, id] = JSON.parse(key) as [string, string];
    if (scope !== RESUME) await f.store.remember(scope, id, 'v1', value);
  }
  const first = f.store.events.find((e) => e.type === 'session.started')!;
  const last = f.store.events.at(-1)!;
  await f.store.remember(RESUME, `${s.id}:${first.seq}`, 'v1', 'oldest-token');
  await f.store.remember(RESUME, `${s.id}:${last.seq}`, 'v1', 'latest-legacy-token');
  f.store.metadata.clear();
  const restarted = createHelixCore(f.deps);
  await restarted.start();
  const resumed = f.harness.handles.get(s.id)!;
  expect(f.harness.start).toHaveBeenLastCalledWith(
    expect.objectContaining({ resumeToken: 'latest-legacy-token' }),
  );
  expect(await f.store.getMeta(RESUME, s.id)).toBe('latest-legacy-token');
  expect(resumed.send).not.toHaveBeenCalled();
  const receiptEvents = f.store.events.filter(
    (e) =>
      e.type === 'session.started' ||
      e.type === 'feedback.routed' ||
      (e.type === 'chat.item' &&
        e.payload.item.kind === 'message' &&
        e.payload.item.text === 'Already delivered user message'),
  );
  expect(receiptEvents).toHaveLength(3);
  for (const e of receiptEvents) expect(await f.store.getMeta(DELIVERY, String(e.seq))).toBe(true);
  expect(await f.store.getMeta(MESSAGE, String(last.seq))).toBe('interrupt');
  resumed.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  for (let i = 0; i < 3; i++) await restarted.health();
  expect(resumed.send).toHaveBeenCalledExactlyOnceWith('Interrupt first', 'queue');
  resumed.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  for (let i = 0; i < 3; i++) await restarted.health();
  expect(resumed.send.mock.calls.map(([text]) => text)).toEqual([
    'Interrupt first',
    'Queued user message',
  ]);
  await restarted.shutdown();
});
