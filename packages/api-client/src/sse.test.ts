import { afterEach, expect, it, vi } from 'vitest';
import { fixtures } from '@helix/contracts';
import { createSseParser, subscribeEvents, type SseFrame, type EventStreamStatus } from './sse.js';

afterEach(() => vi.useRealTimers());
it('parses multiline data, comments, unknown fields, BOM and partial CRLF chunks', () => {
  const frames: SseFrame[] = [];
  const parser = createSseParser((frame) => frames.push(frame));
  for (const chunk of [
    '\uFEFF: heartbeat\r',
    '\n\r',
    '\nid: 12\r\neve',
    'nt: helix\r\ndata: first\r',
    '\ndata:  second\r\nretry: 250\r\n\r',
    '\nid: 13\nevent: helix\ndata: third\n\n',
  ])
    parser.push(chunk);
  expect(frames).toEqual([
    { id: '12', event: 'helix', data: 'first\n second' },
    { id: '13', event: 'helix', data: 'third' },
  ]);
});
it('supports CR-only lines, empty data, persistent IDs, NUL rejection and discards unfinished frames', () => {
  const frames: SseFrame[] = [];
  const parser = createSseParser((frame) => frames.push(frame));
  parser.push('id: 1\rdata\r\rid: bad\0id\rdata: next\r\rdata: incomplete');
  expect(frames).toEqual([
    { id: '1', event: 'message', data: '' },
    { id: '1', event: 'message', data: 'next' },
  ]);
});
it('every possible two-chunk split has the same framing', () => {
  const source = ': heartbeat\r\nid: 7\r\nevent: helix\r\ndata: {"text":"日本語"}\r\n\r\n';
  for (let index = 0; index <= source.length; index++) {
    const frames: SseFrame[] = [];
    const parser = createSseParser((frame) => frames.push(frame));
    parser.push(source.slice(0, index));
    parser.push(source.slice(index));
    expect(frames).toEqual([{ id: '7', event: 'helix', data: '{"text":"日本語"}' }]);
  }
});

const event = fixtures.passwordResetRun[0];
if (!event) throw new Error('No fixture');
function frame(seq: number) {
  return `id: ${seq}\nevent: helix\ndata: ${JSON.stringify({ ...event, seq })}\n\n`;
}
function stream(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
it('resumes with headers, ignores duplicate sequences, and close cancels reconnect', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(stream(frame(1) + frame(1) + frame(2)))
    .mockResolvedValueOnce(stream(frame(2) + frame(4)));
  const values: number[] = [];
  const statuses: EventStreamStatus[] = [];
  const subscription = subscribeEvents({
    baseUrl: 'http://localhost:4317',
    fetch: fetcher,
    onEvent: (e) => values.push(e.seq),
    onStatus: (s) => statuses.push(s),
  });
  await vi.advanceTimersByTimeAsync(350);
  expect(values).toEqual([1, 2, 4]);
  expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ 'Last-Event-ID': '2' });
  subscription.close();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(statuses.at(-1)).toBe('closed');
});
it('uses bounded exponential backoff for unsuccessful connections', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Offline'));
  const subscription = subscribeEvents({
    baseUrl: 'http://localhost:4317',
    fetch: fetcher,
    onEvent: () => undefined,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (const [index, delay] of [250, 500, 1000, 2000, 4000, 8000, 10000, 10000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(fetcher).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(index + 2);
  }
  subscription.close();
  vi.restoreAllMocks();
});
it('does not advance past an invalid frame and can close immediately', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(stream(frame(1) + 'id: 2\nevent: helix\ndata: {}\n\n'))
    .mockResolvedValueOnce(stream(frame(2)));
  const values: number[] = [];
  const subscription = subscribeEvents({
    baseUrl: 'http://localhost:4317',
    fetch: fetcher,
    onEvent: (e) => values.push(e.seq),
  });
  await vi.advanceTimersByTimeAsync(350);
  expect(values).toEqual([1, 2]);
  expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ 'Last-Event-ID': '1' });
  subscription.close();
  const statuses: EventStreamStatus[] = [];
  subscribeEvents({
    baseUrl: 'http://localhost:4317',
    fetch: fetcher,
    onEvent: () => undefined,
    onStatus: (status) => statuses.push(status),
  }).close();
  await vi.advanceTimersByTimeAsync(0);
  expect(statuses).toEqual(['closed']);
});
