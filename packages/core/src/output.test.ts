import { afterEach, expect, test, vi } from 'vitest';
import { outputRequestSchema, type SessionId } from '@helix/contracts';
import { fixture } from './test-support.js';
import { createHelixCore } from './core.js';
import type { OutputHost } from './output.js';

const head = 'a'.repeat(40);
const hash = 'b'.repeat(64);
const lease = { artifactHash: hash, url: `http://127.0.0.1:54321/${'c'.repeat(48)}/` };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup(start?: OutputHost['start']) {
  const leases = new Map<SessionId, typeof lease>();
  const host = {
    start: vi.fn(
      start ??
        ((input: Parameters<OutputHost['start']>[0]) => {
          leases.set(input.workerSessionId, lease);
          return Promise.resolve(lease);
        }),
    ),
    stop: vi.fn((id: SessionId) => {
      leases.delete(id);
      return Promise.resolve();
    }),
    lease: (id: SessionId) => leases.get(id),
  };
  const f = fixture({ outputHost: host });
  f.git.headSha.mockResolvedValue(head);
  const p = await f.add();
  const worker = await f.core.createSession(
    p.id,
    { title: 'Worker', prompt: 'Implement feature', agent: 'codex', interface: 'chat' },
    'worker',
  );
  cleanups.push(() => f.core.shutdown());
  const output = () => f.state(p.id).sessions[worker.id]!.output!;
  const startPreview = async () => {
    await f.core.changeOutput!(worker.id, { requestId: 'start', revision: 0, action: 'start' });
    await f.drain();
  };
  return { ...f, p, worker, host, output, startPreview };
}

test('repeated start/stop, idempotency and revision-bound feedback never duplicate work', async () => {
  const f = await setup();
  await f.startPreview();
  expect(f.output().status).toBe('running');
  await f.core.changeOutput!(f.worker.id, { requestId: 'start', revision: 0, action: 'start' });
  expect(f.host.start).toHaveBeenCalledTimes(1);
  const req = {
    requestId: 'feedback',
    revision: 1,
    action: 'feedback' as const,
    headSha: head,
    text: 'Move the heading above the image.',
  };
  const handle = f.harness.handles.get(f.worker.id)!;
  handle.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await f.drain();
  const before = handle.send.mock.calls.length;
  await f.core.changeOutput!(f.worker.id, req);
  await f.core.changeOutput!(f.worker.id, req);
  expect(handle.send.mock.calls.length).toBe(before + 1);
  expect(f.output().feedback[0]!.status).toBe('routed');
  expect(
    f.store.events.filter((e) => e.type === 'plan.approved' || e.type === 'pr.merged'),
  ).toHaveLength(0);
  await expect(
    f.core.changeOutput!(f.worker.id, { ...req, text: 'Different' }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  f.git.headSha.mockResolvedValue('d'.repeat(40));
  expect((await f.core.outputLease!(f.worker.id)).lease?.stale).toBe(true);
  await expect(
    f.core.changeOutput!(f.worker.id, { ...req, requestId: 'stale' }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  await f.core.changeOutput!(f.worker.id, { requestId: 'stop', revision: 1, action: 'stop' });
  await f.core.changeOutput!(f.worker.id, { requestId: 'stop', revision: 1, action: 'stop' });
  expect((await f.core.outputLease!(f.worker.id)).lease).toBeNull();
});

test('pending edits disable feedback and late canceled startup cannot revive a preview', async () => {
  let finish!: (result: typeof lease) => void;
  const f = await setup(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.startPreview();
  expect(f.output().status).toBe('starting');
  // Core commands and unrelated scheduling stay usable while artifact startup is outstanding.
  expect((await f.core.health()).status).toBe('ok');
  await f.core.changeOutput!(f.worker.id, { requestId: 'cancel', revision: 1, action: 'stop' });
  finish(lease);
  await f.drain();
  expect(f.output().status).toBe('stopped');
  const live = await setup();
  await live.startPreview();
  live.git.dirty = true;
  expect((await live.core.outputLease!(live.worker.id)).lease?.pendingChanges).toBe(true);
  await expect(
    live.core.changeOutput!(live.worker.id, {
      requestId: 'dirty',
      revision: 1,
      action: 'feedback',
      headSha: head,
      text: 'Change layout',
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('restart invalidates saved live state without launching listeners or replaying feedback', async () => {
  const f = await setup();
  await f.startPreview();
  const core = createHelixCore(f.deps);
  await core.health();
  expect(f.host.start).toHaveBeenCalledTimes(1);
  expect((await core.outputLease!(f.worker.id)).lease).toBeNull();
  expect(f.output().status).toBe('stopped');
});

test('missing artifact fails visibly; request schema rejects commands, paths, URLs and ports', async () => {
  const f = await setup(() => {
    return Promise.reject(new Error('No committed export'));
  });
  await f.startPreview();
  expect(f.output()).toMatchObject({ status: 'unavailable', message: 'No committed export' });
  for (const property of ['command', 'path', 'url', 'port'])
    expect(
      outputRequestSchema.safeParse({
        requestId: 'bad',
        revision: 0,
        action: 'start',
        [property]: 'evil',
      }).success,
    ).toBe(false);
});

test('an uncertain Output send is never automatically delivered by generic chat recovery', async () => {
  const f = await setup();
  await f.startPreview();
  const handle = f.harness.handles.get(f.worker.id)!;
  handle.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await f.drain();
  handle.send.mockRejectedValueOnce(new Error('Transport failed after send may have happened'));
  const request = {
    requestId: 'uncertain',
    revision: 1,
    action: 'feedback' as const,
    headSha: head,
    text: 'Increase heading spacing',
  };
  await f.core.changeOutput!(f.worker.id, request);
  expect(f.output().feedback[0]!.status).toBe('blocked');
  const count = handle.send.mock.calls.length;
  await f.core.changeOutput!(f.worker.id, request);
  await f.drain();
  expect(handle.send.mock.calls.length).toBe(count);
  const recovered = createHelixCore(f.deps);
  await recovered.start();
  expect(
    f.harness.handles
      .get(f.worker.id)!
      .send.mock.calls.some(([text]) => text.includes('Increase heading spacing')),
  ).toBe(false);
  await recovered.shutdown();
});

test('queued feedback becomes blocked when its later delivery fails', async () => {
  const f = await setup();
  await f.startPreview();
  await f.core.changeOutput!(f.worker.id, {
    requestId: 'later',
    revision: 1,
    action: 'feedback',
    headSha: head,
    text: 'Move the button',
  });
  expect(f.output().feedback[0]!.status).toBe('routed');
  const handle = f.harness.handles.get(f.worker.id)!;
  handle.send.mockRejectedValueOnce(new Error('later send failed'));
  handle.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  await f.drain();
  expect(f.output().feedback[0]!.status).toBe('blocked');
  expect(f.output().feedback[0]!.disposition).toContain('no automatic resend');
});
