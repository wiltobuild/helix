import { afterEach, expect, test } from 'vitest';
import { fixture } from './test-support.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
});
async function setup(title = 'Implement task') {
  const f = fixture();
  cleanup.push(() => f.core.shutdown());
  const p = await f.add();
  const s = await f.core.createSession(
    p.id,
    { title, prompt: 'Edit files', agent: 'codex', interface: 'chat' },
    'task',
  );
  const handle = f.harness.handles.get(s.id)!;
  const finish = async (text?: string) => {
    if (text !== undefined)
      handle.emit({
        type: 'chat.item',
        payload: { item: { kind: 'message', role: 'assistant', text } },
      });
    handle.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
    await f.drain();
  };
  return { ...f, p, s, handle, finish };
}

test('Helix commits dirty edits before snapshots and shipping, with a bounded message and causal note', async () => {
  const title = 'A'.repeat(100);
  const f = await setup(title);
  f.git.dirty = true;
  f.handle.emit({
    type: 'chat.item',
    payload: { item: { kind: 'message', role: 'assistant', text: 'Old message' } },
  });
  await f.finish('Final summary\r\n' + 'x'.repeat(600));
  expect(f.git.commitAll).toHaveBeenCalledExactlyOnceWith(
    f.s.worktreePath,
    `${'A'.repeat(72)}\n\nTurn 1 by codex via Helix\n\n${('Final summary ' + 'x'.repeat(600)).slice(0, 500)}`,
  );
  expect(f.git.commitAll.mock.invocationCallOrder[0]).toBeLessThan(
    f.git.markTurn.mock.invocationCallOrder[0]!,
  );
  expect(f.git.markTurn.mock.invocationCallOrder[0]).toBeLessThan(
    f.git.diff.mock.invocationCallOrder[0]!,
  );
  expect(f.git.push).toHaveBeenCalledOnce();
  expect(f.scm.openPr).toHaveBeenCalledOnce();
  const note = f.store.events.find(
    (e) => e.type === 'explain.note' && e.payload.text.startsWith('Committed '),
  )!;
  expect(note).toMatchObject({
    type: 'explain.note',
    payload: { text: `Committed abcdef1: ${'A'.repeat(72)}`, source: 'helix' },
  });
  expect(f.store.events.find((e) => e.seq === note.causedBy)).toMatchObject({
    type: 'activity.changed',
    payload: { activity: 'idle' },
  });
  await f.finish();
  expect(f.git.commitAll).toHaveBeenCalledOnce();
});

test('clean turns do not commit but still count, and assistant summaries do not leak into later turns', async () => {
  const f = await setup();
  await f.finish('Nothing changed');
  expect(f.git.commitAll).not.toHaveBeenCalled();
  expect(f.git.markTurn).toHaveBeenCalledOnce();
  await f.core.sendMessage(f.s.id, { text: 'Now edit', mode: 'queue' });
  f.git.dirty = true;
  await f.finish();
  expect(f.git.commitAll).toHaveBeenCalledExactlyOnceWith(
    f.s.worktreePath,
    'Implement task\n\nTurn 2 by codex via Helix',
  );
});

test('a failed commit preserves dirty edits, blocks the session and skips snapshots and shipping', async () => {
  const f = await setup();
  f.git.dirty = true;
  f.git.commitAll.mockRejectedValueOnce(new Error('index.lock is locked'));
  await f.core.sendMessage(f.s.id, { text: 'Queued work', mode: 'queue' });
  await f.finish('Edited');
  expect(f.git.dirty).toBe(true);
  expect(f.git.markTurn).not.toHaveBeenCalled();
  expect(f.git.push).not.toHaveBeenCalled();
  expect(f.handle.send).toHaveBeenCalledTimes(1);
  expect(f.state(f.p.id).sessions[f.s.id]!.activity).toBe('blocked');
  expect(f.store.events).toContainEqual(
    expect.objectContaining({
      type: 'explain.note',
      payload: {
        text: 'Helix could not commit this turn: index.lock is locked',
        source: 'helix',
      },
    }),
  );
});

test('a concurrent clean result from commitAll never invents a committed SHA', async () => {
  const f = await setup();
  f.git.dirty = true;
  f.git.commitAll.mockResolvedValueOnce(undefined);
  await f.finish('Edited');
  expect(f.git.markTurn).toHaveBeenCalledOnce();
  expect(
    f.store.events.some(
      (e) => e.type === 'explain.note' && e.payload.text.startsWith('Committed '),
    ),
  ).toBe(false);
});
