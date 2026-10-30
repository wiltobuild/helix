import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PullRequestFacts, ScmObserver, Session } from '@helix/contracts';
import { fixture, green } from './test-support.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function setup() {
  const f = fixture();
  const p = await f.add();
  f.git.ahead = 1;
  const workers: Session[] = [];
  for (const title of ['A', 'B', 'C']) {
    const s = await f.core.createSession(
      p.id,
      {
        title,
        prompt: title,
        agent: 'codex',
        interface: 'chat',
      },
      title,
    );
    f.harness.handles.get(s.id)!.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
    await f.drain();
    workers.push(s);
  }
  const [a, b, c] = workers;
  const pr = (id: typeof a) => f.state(p.id).sessions[id!.id]!.pr!;
  const update = (worker: typeof a, patch: Partial<PullRequestFacts>) => {
    const facts = { ...pr(worker), ...patch };
    f.scm.emit(p.id, facts.number, { type: 'pr.updated', payload: { pr: facts } });
  };
  const merge = (worker = a) =>
    f.scm.emit(p.id, pr(worker).number, {
      type: 'pr.merged',
      payload: { prNumber: pr(worker).number, mergeSha: 'merged' },
    });
  const refresh = vi.fn<NonNullable<ScmObserver['refresh']>>((_project, number) => {
    const worker = workers.find((s) => pr(s).number === number)!;
    update(worker, { mergeable: 'mergeable' });
    return Promise.resolve();
  });
  f.deps.scm!.refresh = refresh;
  const tick = async (ms = 250) => {
    await vi.advanceTimersByTimeAsync(ms);
    await f.drain();
  };
  return { ...f, p, a: a!, b: b!, c: c!, pr, update, merge, refresh, tick };
}

test('unknown then conflicting refresh routes to B with the full merge causal chain', async () => {
  const f = await setup();
  let attempts = 0;
  f.refresh.mockImplementation((_p, number) => {
    if (number === f.pr(f.b).number)
      f.update(f.b, { mergeable: ++attempts === 1 ? 'unknown' : 'conflicting' });
    else f.update(f.c, { mergeable: 'mergeable' });
    return Promise.resolve();
  });
  f.merge();
  await f.drain();
  const merged = f.store.events.find((e) => e.type === 'pr.merged')!;
  await f.tick();
  expect(f.refresh).toHaveBeenCalledWith(f.p, f.pr(f.b).number);
  expect(f.store.events.filter((e) => e.type === 'feedback.routed')).toHaveLength(0);
  await f.tick(20_000);
  const routed = f.store.events.find((e) => e.type === 'feedback.routed')!;
  expect(routed).toMatchObject({
    sessionId: f.b.id,
    payload: { reason: 'merge_conflict', toSessionId: f.b.id },
  });
  const observation = f.store.events.find((e) => e.seq === routed.causedBy)!;
  const note = f.store.events.find((e) => e.seq === observation.causedBy)!;
  expect(observation.type).toBe('pr.updated');
  expect(note).toMatchObject({ type: 'explain.note', causedBy: merged.seq });
  expect(f.harness.handles.get(f.b.id)!.send).toHaveBeenLastCalledWith(
    expect.stringContaining('Repair merge_conflict'),
    'queue',
  );
  await f.tick(80_000);
  expect(attempts).toBe(2);
  expect(f.state(f.p.id).anomalies).toEqual([]);
  await f.core.shutdown();
});

test('an older clean observation cannot cancel a newer unknown refresh', async () => {
  const f = await setup();
  let count = 0;
  f.refresh.mockImplementation((_p, number) => {
    if (number === f.pr(f.b).number) {
      count++;
      f.update(f.b, { mergeable: 'mergeable' });
      f.update(f.b, { mergeable: count === 1 ? 'unknown' : 'conflicting' });
    } else f.update(f.c, { mergeable: 'mergeable' });
    return Promise.resolve();
  });
  f.merge();
  await f.drain();
  await f.tick();
  await f.tick(20_000);
  expect(count).toBe(2);
  expect(f.store.events.filter((e) => e.type === 'feedback.routed')).toHaveLength(1);
  expect(f.state(f.p.id).anomalies).toEqual([]);
  await f.core.shutdown();
});

test('a later merge waits for an older refresh then requests a fresh read', async () => {
  const f = await setup();
  let release!: () => void;
  let reads = 0;
  f.refresh.mockImplementation((_p, number) => {
    if (number !== f.pr(f.b).number) {
      f.update(f.c, { mergeable: 'mergeable' });
      return Promise.resolve();
    }
    if (++reads === 1)
      return new Promise<void>((resolve) => {
        release = () => {
          f.update(f.b, { mergeable: 'mergeable' });
          resolve();
        };
      });
    f.update(f.b, { mergeable: 'conflicting' });
    return Promise.resolve();
  });
  f.merge();
  await f.drain();
  await f.tick();
  f.merge(f.c);
  await f.drain();
  await f.tick();
  expect(reads).toBe(1);
  release();
  await f.tick(0);
  expect(reads).toBe(2);
  const routed = f.store.events.find((e) => e.type === 'feedback.routed')!;
  const update = f.store.events.find((e) => e.seq === routed.causedBy)!;
  const note = f.store.events.find((e) => e.seq === update.causedBy)!;
  expect(note.causedBy).toBe(f.store.events.filter((e) => e.type === 'pr.merged').at(-1)!.seq);
  expect(f.state(f.p.id).anomalies).toEqual([]);
  await f.core.shutdown();
});

test('clean PRs refresh once and route no feedback', async () => {
  const f = await setup();
  f.merge();
  await f.drain();
  await f.tick();
  await f.tick(80_000);
  expect(f.refresh).toHaveBeenCalledTimes(2);
  expect(f.store.events.some((e) => e.type === 'feedback.routed')).toBe(false);
  expect(f.state(f.p.id).anomalies).toEqual([]);
  await f.core.shutdown();
});

test('archived and closed PRs are excluded even when closed during the coalescing window', async () => {
  const f = await setup();
  f.merge();
  await f.drain();
  await f.core.archiveSession(f.b.id);
  f.update(f.c, { state: 'closed' });
  await f.drain();
  await f.tick();
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.state(f.p.id).anomalies).toEqual([]);
  await f.core.shutdown();
});

test('two quick merges coalesce, and duplicate merge observations do not restart checks', async () => {
  const f = await setup();
  f.merge();
  f.merge(f.c);
  f.merge();
  await f.drain();
  await f.tick();
  expect(f.refresh).toHaveBeenCalledExactlyOnceWith(f.p, f.pr(f.b).number);
  const note = f.store.events.find((e) => e.type === 'explain.note' && e.sessionId === f.b.id)!;
  expect(note).toMatchObject({
    causedBy: f.store.events.filter((e) => e.type === 'pr.merged').at(-1)!.seq,
  });
  expect(f.state(f.p.id).anomalies).toEqual([]);
  await f.core.shutdown();
});

test('unknown responses stop after four attempts and shutdown cancels pending retries', async () => {
  const f = await setup();
  f.refresh.mockImplementation((_p, number) => {
    f.update(number === f.pr(f.b).number ? f.b : f.c, { mergeable: 'unknown' });
    return Promise.resolve();
  });
  f.merge();
  await f.drain();
  await f.tick();
  await f.tick(100_000);
  expect(f.refresh).toHaveBeenCalledTimes(8);
  await f.core.shutdown();
  await vi.advanceTimersByTimeAsync(100_000);
  expect(f.refresh).toHaveBeenCalledTimes(8);
});

test('shutdown cancels the initial batch and does not wait on an in-flight refresh', async () => {
  const f = await setup();
  f.merge();
  await f.drain();
  await f.core.shutdown();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.refresh).not.toHaveBeenCalled();
  const g = await setup();
  let finish!: () => void;
  g.refresh.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  g.merge();
  await g.drain();
  await g.tick();
  await g.core.shutdown();
  finish();
  await vi.advanceTimersByTimeAsync(100_000);
  expect(g.refresh).toHaveBeenCalledTimes(2);
});

test('a local merge uses the same re-check path', async () => {
  const f = await setup();
  f.update(f.a, { checks: green, review: { decision: 'approved', unresolvedThreads: 0 } });
  await f.drain();
  await f.core.merge(f.a.id);
  await f.tick();
  expect(f.refresh).toHaveBeenCalledTimes(2);
  expect(f.state(f.p.id).anomalies).toEqual([]);
  await f.core.shutdown();
});
