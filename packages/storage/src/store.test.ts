import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import {
  backfill,
  fixtures,
  HelixError,
  isHelixError,
  parseHelixlog,
  projectIdSchema,
  projectUpTo,
  recordingImportResponseSchema,
  serializeHelixlog,
  type HelixEvent,
  type HelixStore,
  type ProjectId,
  type UnsequencedEvent,
} from '@helix/contracts';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createEventStore,
  EventValidationError,
  IdempotencyConflictError,
  openStore,
  ProjectConflictError,
  RecordingValidationError,
  StorageError,
  type StorageStore,
} from './index.js';

const project = fixtures.passwordResetProject;
const otherId = projectIdSchema.parse('another-project');
const timestamp = '2026-01-02T03:04:05.000Z';
const stores: StorageStore[] = [];
const directories: string[] = [];
function memory(): StorageStore {
  const store = openStore({ memory: true });
  stores.push(store);
  return store;
}
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'helix-storage-'));
  directories.push(path);
  return path;
}
function note(projectId: ProjectId = project.id, text = 'explanation'): UnsequencedEvent {
  return { projectId, type: 'explain.note', ts: timestamp, v: 1, payload: { text } };
}
function batch(count: number): UnsequencedEvent[] {
  return Array.from({ length: count }, () => note());
}
function unsequence(events: readonly HelixEvent[]): UnsequencedEvent[] {
  return events.map((event) => {
    const { seq, ...input } = event;
    void seq;
    return input;
  });
}
function fixtureRecording(): string {
  return serializeHelixlog({
    header: { format: 'helixlog', version: 1, project, recordedAt: timestamp, redactions: [] },
    events: [...fixtures.passwordResetRun],
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('event log', () => {
  test('implements HelixStore and the createEventStore alias', async () => {
    expect(createEventStore).toBe(openStore);
    const store: HelixStore = memory();
    expect(await store.append([])).toEqual([]);
    expect(await store.read(project.id, 0, 10)).toEqual([]);
  });

  test('assigns daemon-global sequences, retains caller timestamps and envelope fields', async () => {
    const store = memory();
    const inputs = unsequence(fixtures.passwordResetRun);
    const original = structuredClone(inputs);
    const first = await store.append(inputs);
    expect(first.map((event) => event.seq)).toEqual(
      Array.from({ length: inputs.length }, (_, i) => i + 1),
    );
    expect(inputs).toEqual(original);
    expect(first).toEqual(fixtures.passwordResetRun);
    const second = await store.append([note(otherId), note()]);
    expect(second.map((event) => event.seq)).toEqual([first.length + 1, first.length + 2]);
    expect(second.map((event) => event.ts)).toEqual([timestamp, timestamp]);
    expect(await store.read(otherId, 0, 10)).toEqual([second[0]]);
    expect(await store.read(project.id, first.length, 10)).toEqual([second[1]]);
    expect(await store.read(project.id, 0, backfill.maxLimit)).toEqual([...first, second[1]]);
  });

  test('rolls back an entire invalid batch, notifies nobody, and reuses the uncommitted sequence', async () => {
    const store = memory();
    await store.append([note()]);
    const seen: number[] = [];
    store.subscribe(1, (event) => seen.push(event.seq));
    const invalid = { ...note(), payload: { text: 42 } } as unknown as UnsequencedEvent;
    const error: unknown = await store
      .append([note(), invalid, note()])
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EventValidationError);
    expect(error).toMatchObject({ code: 'INVALID_REQUEST', index: 1 });
    expect(isHelixError(error)).toBe(true);
    await setImmediate();
    expect(seen).toEqual([]);
    expect((await store.read(project.id, 0, 100)).map((event) => event.seq)).toEqual([1]);
    expect((await store.append([note()]))[0]?.seq).toBe(2);
    await setImmediate();
    expect(seen).toEqual([2]);
  });

  test('uses exclusive cursors and caps pages', async () => {
    const store = memory();
    await store.append(batch(backfill.maxLimit + 10));
    const page = await store.read(project.id, 0, backfill.maxLimit + 100);
    expect(page).toHaveLength(backfill.maxLimit);
    const rest = await store.read(project.id, page.at(-1)!.seq, 100);
    expect(rest.map((event) => event.seq)).toEqual(
      Array.from({ length: 10 }, (_, i) => backfill.maxLimit + i + 1),
    );
    expect(await store.read(project.id, rest.at(-1)!.seq, 100)).toEqual([]);
  });

  test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid cursor %s',
    async (cursor) => {
      const store = memory();
      await expect(store.read(project.id, cursor, 10)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      expect(() => store.subscribe(cursor, () => undefined)).toThrow(HelixError);
    },
  );

  test.each([0, -1, 1.5, NaN, Infinity])('rejects invalid page limit %s', async (limit) => {
    await expect(memory().read(project.id, 0, limit)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});

describe('subscriptions', () => {
  test('catches up before live delivery and supports immediate unsubscribe', async () => {
    const store = memory();
    await store.append(batch(5));
    const seen: number[] = [];
    const unsubscribe = store.subscribe(2, (event) => seen.push(event.seq));
    await setImmediate();
    expect(seen).toEqual([3, 4, 5]);
    await store.append([note(otherId), note()]);
    await setImmediate();
    expect(seen).toEqual([3, 4, 5, 6, 7]);
    unsubscribe();
    unsubscribe();
    const cancelled = vi.fn();
    store.subscribe(0, cancelled)();
    await store.append([note()]);
    await setImmediate();
    expect(cancelled).not.toHaveBeenCalled();
    expect(seen).toEqual([3, 4, 5, 6, 7]);
  });

  test('delivers exactly N+1..end while 1,000 events are appended in interleaved batches', async () => {
    const store = memory();
    const n = 23;
    await store.append(batch(n + 37));
    const seen: number[] = [];
    let nested: Promise<HelixEvent[]> | undefined;
    store.subscribe(n, (event) => {
      seen.push(event.seq);
      if (event.seq === n + 1) nested = store.append(batch(20));
    });
    // Writes before the catch-up microtask, reentrant writes inside catch-up,
    // and two interleaved writers cover the handoff in different schedules.
    const early = store.append(batch(20));
    async function writer(): Promise<void> {
      for (let i = 0; i < 24; i++) {
        await store.append(batch(20));
        await setImmediate();
      }
    }
    await Promise.all([early, writer(), writer()]);
    await nested;
    await setImmediate();
    expect(seen).toEqual(Array.from({ length: 1037 }, (_, i) => n + i + 1));
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('revisits earlier subscribers when a later subscriber appends', async () => {
    const store = memory();
    const first: number[] = [];
    const second: number[] = [];
    let nested: Promise<HelixEvent[]> | undefined;
    store.subscribe(0, (event) => first.push(event.seq));
    store.subscribe(0, (event) => {
      second.push(event.seq);
      if (event.seq === 1) nested = store.append(batch(3));
    });
    await store.append([note()]);
    await setImmediate();
    await nested;
    expect(first).toEqual([1, 2, 3, 4]);
    expect(second).toEqual(first);
  });

  test('isolates throwing, rejecting, and mutating subscribers', async () => {
    const store = memory();
    const seen: HelixEvent[] = [];
    store.subscribe(0, (event) => {
      if (event.type === 'explain.note') event.payload.text = 'mutated';
      throw new Error('observer failed');
    });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Exercise accidental async observers.
    store.subscribe(0, () => Promise.reject(new Error('async observer failed')));
    store.subscribe(0, (event) => seen.push(event));
    const stored = await store.append(batch(3));
    await setImmediate();
    expect(seen).toEqual(stored);
    expect(await store.read(project.id, 0, 10)).toEqual(stored);
  });

  test('honors future cursors and unsubscribe from a callback', async () => {
    const store = memory();
    const seen: number[] = [];
    const stop = store.subscribe(3, (event) => {
      seen.push(event.seq);
      stop();
    });
    await store.append(batch(2));
    await setImmediate();
    expect(seen).toEqual([]);
    await store.append(batch(4));
    await setImmediate();
    expect(seen).toEqual([4]);
  });
});

describe('durable auxiliary state', () => {
  test('saves and updates projects with a unique repo path and independent event log', async () => {
    const store = memory();
    expect(await store.getProject(project.id)).toBeUndefined();
    expect(await store.findProjectByRepoPath(project.repoPath)).toBeUndefined();
    await store.saveProject(project);
    const updated = { ...project, name: 'Renamed', repoPath: join('workspace', 'renamed') };
    await store.saveProject(updated);
    expect(await store.getProject(project.id)).toEqual(updated);
    expect(await store.findProjectByRepoPath(project.repoPath)).toBeUndefined();
    expect(await store.findProjectByRepoPath(updated.repoPath)).toEqual(updated);
    expect(await store.listProjects()).toEqual([updated]);
    await expect(store.saveProject({ ...updated, id: otherId })).rejects.toBeInstanceOf(
      ProjectConflictError,
    );
    expect(await store.listProjects()).toEqual([updated]);
    await expect(store.saveProject({ ...updated, name: '' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(await store.read(project.id, 0, 100)).toEqual([]);
  });

  test('scopes idempotency, preserves the first response, and checks hashes on remember and recall', async () => {
    const store = memory();
    expect(await store.recall('spawn', 'key', 'hash')).toBeUndefined();
    await store.remember('spawn', 'key', 'hash', { sessionId: 'one' });
    await store.remember('spawn', 'key', 'hash', { sessionId: 'two' });
    expect(await store.recall('spawn', 'key', 'hash')).toEqual({ sessionId: 'one' });
    await expect(store.remember('spawn', 'key', 'different', {})).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await expect(store.recall('spawn', 'key', 'different')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await store.remember('other-scope', 'key', 'different', null);
    expect(await store.recall('other-scope', 'key', 'different')).toBeNull();
    await expect(store.remember('spawn', 'invalid', 'hash', undefined)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(store.remember('spawn', 'invalid', 'hash', 1n)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(await store.recall('spawn', 'invalid', 'hash')).toBeUndefined();
  });

  test('reopens file-backed data, resumes sequences, and runs migrations idempotently', async () => {
    const dataDir = await directory();
    let store = openStore({ dataDir });
    stores.push(store);
    await store.append(unsequence(fixtures.passwordResetRun));
    await store.saveProject(project);
    await store.remember('scope', 'key', 'hash', { accepted: true });
    await store.importRecording(fixtureRecording());
    const recording = (await store.listRecordings())[0]!;
    await store.close();
    for (let i = 0; i < 2; i++) {
      store = openStore({ dataDir });
      stores.push(store);
      expect(await store.read(project.id, 0, 1000)).toEqual(fixtures.passwordResetRun);
      expect(await store.getProject(project.id)).toEqual(project);
      expect(await store.recall('scope', 'key', 'hash')).toEqual({ accepted: true });
      expect((await store.readRecording(recording.id))?.events).toEqual(fixtures.passwordResetRun);
      expect(await store.listRecordings()).toEqual([recording]);
      await store.close();
    }
    store = openStore({ dataDir });
    stores.push(store);
    expect((await store.append([note()]))[0]?.seq).toBe(fixtures.passwordResetRun.length + 1);
    const db = new DatabaseSync(join(dataDir, 'helix.db'));
    try {
      expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      const indexes = db
        .prepare('PRAGMA index_list(events)')
        .all()
        .map((row) => row.name);
      expect(indexes).toEqual(expect.arrayContaining(['events_project_seq', 'events_session_seq']));
    } finally {
      db.close();
    }
  }, 20_000);

  test('uses HELIX_DATA_DIR and allows an explicit dataDir to override it', async () => {
    const envDir = await directory();
    const explicitDir = await directory();
    vi.stubEnv('HELIX_DATA_DIR', envDir);
    const byEnv = openStore();
    stores.push(byEnv);
    await byEnv.append([note()]);
    const explicit = openStore({ dataDir: explicitDir });
    stores.push(explicit);
    expect(await explicit.read(project.id, 0, 10)).toEqual([]);
    await byEnv.close();
    const reopened = openStore({ dataDir: envDir });
    stores.push(reopened);
    expect(await reopened.read(project.id, 0, 10)).toHaveLength(1);
  });

  test('close is idempotent, cancels pending delivery, and rejects later operations', async () => {
    const store = memory();
    const callback = vi.fn();
    store.subscribe(0, callback);
    const pending = store.append([note()]);
    await store.close();
    await pending;
    await setImmediate();
    expect(callback).not.toHaveBeenCalled();
    await store.close();
    await expect(store.append([])).rejects.toBeInstanceOf(StorageError);
    await expect(store.read(project.id, 0, 10)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(() => store.subscribe(0, callback)).toThrow(StorageError);
  });
});

describe('recordings', () => {
  test('round-trips fixture history and final projection through export and replay import', async () => {
    const store = memory();
    await store.append(unsequence(fixtures.passwordResetRun));
    // Export must use genesis, even if the independent lookup index was updated.
    await store.saveProject({ ...project, name: 'Changed lookup' });
    const text = await store.exportProject(project.id);
    const parsed = parseHelixlog(text);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.data.events).toEqual(fixtures.passwordResetRun);
    expect(projectUpTo(parsed.data.events, Number.MAX_SAFE_INTEGER)).toEqual(
      projectUpTo(fixtures.passwordResetRun, Number.MAX_SAFE_INTEGER),
    );
    expect(parsed.data.header.project).toEqual(project);
    const result = await store.importRecording(text);
    expect(recordingImportResponseSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual({
      project,
      eventCount: fixtures.passwordResetRun.length,
      lastSeq: fixtures.passwordResetRun.at(-1)!.seq,
    });
    const [info] = await store.listRecordings();
    expect(info).toBeDefined();
    expect(await store.readRecording(info!.id)).toEqual(parsed.data);
    expect(await store.readRecording('missing')).toBeUndefined();
  });

  test('keeps recordings with overlapping IDs separate and never publishes imported events', async () => {
    const store = memory();
    const callback = vi.fn();
    store.subscribe(0, callback);
    const text = fixtureRecording();
    await store.importRecording(text);
    await store.importRecording('\uFEFF' + text.replaceAll('\n', '\r\n'));
    expect(await store.listRecordings()).toHaveLength(1);
    const parsed = parseHelixlog(text);
    if (!parsed.success) throw new Error(parsed.error.message);
    const variant = { ...parsed.data, header: { ...parsed.data.header, redactions: ['paths'] } };
    await store.importRecording(serializeHelixlog(variant));
    const recordings = await store.listRecordings();
    expect(recordings).toHaveLength(2);
    expect(recordings[0]?.id).not.toBe(recordings[1]?.id);
    for (const info of recordings)
      expect((await store.readRecording(info.id))?.events).toEqual(fixtures.passwordResetRun);
    expect(await store.read(project.id, 0, 1000)).toEqual([]);
    expect(await store.listProjects()).toEqual([]);
    await setImmediate();
    expect(callback).not.toHaveBeenCalled();
    expect((await store.append([note()]))[0]?.seq).toBe(1);
  });

  test('preserves original sequence gaps and causal links in the replay namespace', async () => {
    const store = memory();
    const parsed = parseHelixlog(fixtureRecording());
    if (!parsed.success) throw new Error(parsed.error.message);
    const events = parsed.data.events.map((event) => ({
      ...event,
      seq: (event.seq * 10) as HelixEvent['seq'],
      ...(event.causedBy === undefined
        ? {}
        : { causedBy: (event.causedBy * 10) as HelixEvent['seq'] }),
    }));
    await store.importRecording(serializeHelixlog({ ...parsed.data, events }));
    const [info] = await store.listRecordings();
    expect((await store.readRecording(info!.id))?.events).toEqual(events);
  });

  test('rejects malformed recordings atomically and reports missing or incomplete export history', async () => {
    const store = memory();
    await expect(store.importRecording(fixtureRecording() + '{bad json}\n')).rejects.toBeInstanceOf(
      RecordingValidationError,
    );
    expect(await store.listRecordings()).toEqual([]);
    await expect(store.exportProject(project.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await store.append([note()]);
    await expect(store.exportProject(project.id)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});

test('file-backed performance: 10,000 events in batches of 50; read 1,000', async () => {
  const store = openStore({ dataDir: await directory() });
  stores.push(store);
  const events = batch(50);
  const start = performance.now();
  for (let i = 0; i < 200; i++) await store.append(events);
  const appendMs = performance.now() - start;
  const readStart = performance.now();
  const page = await store.read(project.id, 0, 1000);
  const readMs = performance.now() - readStart;
  process.stdout.write(
    `storage perf: append 10000=${appendMs.toFixed(2)}ms; read 1000=${readMs.toFixed(2)}ms\n`,
  );
  expect(page).toHaveLength(1000);
  // Generous CI guards; compare reported timings with the 3000ms / 50ms targets.
  expect(appendMs).toBeLessThan(10_000);
  expect(readMs).toBeLessThan(500);
}, 20_000);
