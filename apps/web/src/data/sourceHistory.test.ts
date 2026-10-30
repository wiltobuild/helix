import { expect, test, vi } from 'vitest';
import { fixtures, sse, type HelixEvent } from '@helix/contracts';
import { createHelixClient } from '@helix/api-client';
import { accountTime } from './activeTime';
import {
  emptyHistory,
  receiveEvent,
  receiveStatus,
  selectHistory,
  sourceIdentity,
} from './sourceHistory';
import { initialTimeline, transitionTimeline, cursorIndex } from './timelineState';

const events = fixtures.passwordResetRun;
const projectId = fixtures.passwordResetProject.id;

test('production ingestion keeps late decisions and conflicting variants while exact retries are idempotent', () => {
  let state = emptyHistory(projectId);
  for (const event of [...events].reverse()) state = receiveEvent(state, projectId, event);
  expect(accountTime(state.events)).toEqual(accountTime(events));
  expect(receiveEvent(state, projectId, events[0]!)).toBe(state);
  const conflict = { ...events[2]!, ts: events[0]!.ts };
  state = receiveEvent(state, projectId, conflict);
  expect(state.events.filter((event) => event.seq === conflict.seq)).toHaveLength(2);
  expect(state.events).toContain(conflict);
  expect(state.events).toContain(events[2]);
  expect(accountTime(state.events).conflicts).toEqual([conflict.seq]);
  expect(accountTime(state.events).human).toBe(0);
  expect(accountTime(state.events).warnings.join(' ')).toContain('all variants retained');
});

test('source identity survives earlier backfill/status changes, while explicit source changes reset navigation', () => {
  let history = emptyHistory(projectId);
  for (const event of events.slice(3)) history = receiveEvent(history, projectId, event);
  const id = sourceIdentity('live', projectId);
  let timing = accountTime(history.events);
  let navigation = transitionTimeline(initialTimeline(id), { type: 'seek', index: 2 }, timing);
  navigation = transitionTimeline(navigation, { type: 'mode', mode: 'active' }, timing);
  const selectedSeq = navigation.cursor;
  history = receiveStatus(history, projectId, 'reconnecting');
  for (const event of events.slice(0, 3)) history = receiveEvent(history, projectId, event);
  history = receiveStatus(history, projectId, 'live');
  timing = accountTime(history.events);
  expect(
    transitionTimeline(
      navigation,
      { type: 'source', sourceId: sourceIdentity('live', projectId) },
      timing,
    ),
  ).toBe(navigation);
  expect(timing.events[cursorIndex(timing.events, navigation.cursor)]?.seq).toBe(selectedSeq);
  expect(navigation.timeMode).toBe('active');
  expect(selectHistory(history, projectId)).toBe(history);
  const other = selectHistory(history, 'other');
  expect(other.events).toEqual([]);
  expect(receiveEvent(other, projectId, events[0]!)).toBe(other);
  expect(receiveStatus(other, projectId, 'live')).toBe(other);
  expect(receiveEvent(other, 'other', events[0]!)).toBe(other);
  const reset = transitionTimeline(
    navigation,
    { type: 'source', sourceId: sourceIdentity('demo', 'same-name', 1) },
    timing,
  );
  expect(reset).toMatchObject({
    cursor: null,
    timeMode: 'elapsed',
    playing: false,
    now: undefined,
  });
  expect(sourceIdentity('demo', 'same-name', 2)).not.toBe(reset.sourceId);
});

test('shared client delivers late/conflicting frames into production ingestion and resumes at high-water', async () => {
  vi.useFakeTimers();
  const requests: { url: string; headers: Headers }[] = [];
  let history = emptyHistory(projectId);
  const conflict = { ...events[2]!, ts: events[0]!.ts };
  const frames = (batch: typeof history.events) =>
    batch
      .map((event) => `event: ${sse.event}\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
      .join('');
  let count = 0;
  const fetcher: typeof fetch = (input, init) => {
    requests.push({
      url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      headers: new Headers(init?.headers),
    });
    const body =
      count++ === 0
        ? frames([events[0]!, events[2]!, events[1]!, events[1]!, conflict])
        : frames(events.slice(3));
    return Promise.resolve(new Response(body, { headers: { 'content-type': sse.contentType } }));
  };
  const client = createHelixClient({ baseUrl: 'http://localhost', fetch: fetcher });
  const delivered: HelixEvent[] = [];
  const sub = client.events({
    projectId,
    onEvent: (event) => {
      delivered.push(event);
      history = receiveEvent(history, projectId, event);
    },
    onStatus: (status) => {
      history = receiveStatus(history, projectId, status);
    },
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(history.events).toHaveLength(4);
    expect(history.events.map((event) => event.seq)).toEqual([1, 2, 3, 3]);
    expect(history.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(350);
    expect(history.events).toHaveLength(events.length + 1);
    expect(accountTime(history.events).conflicts).toEqual([3]);
    expect(requests).toHaveLength(2);
    for (const [index, request] of requests.entries()) {
      const highWater = index === 0 ? '0' : '3';
      expect(new URL(request.url).searchParams.get('since')).toBe(highWater);
      expect(request.headers.get(sse.resumeHeader)).toBe(highWater);
    }
    expect(delivered).toHaveLength(events.length + 1);
    for (const event of delivered) expect(history.events).toContain(event);
    expect(history.events.find((event) => event.seq === events[1]!.seq)?.ts).toBe(events[1]!.ts);
  } finally {
    sub.close();
    vi.useRealTimers();
  }
  expect(history.status).toBe('closed');
});
