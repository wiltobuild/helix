import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { get, type IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import type { Socket } from 'node:net';
import {
  fixtures,
  HelixError,
  projectIdSchema,
  terminalOutputSchema,
  type TerminalAttachment,
  type TerminalOutput,
} from '@helix/contracts';
import { subscribeEvents, type EventStreamStatus } from '@helix/api-client';
import { createServer } from './server.js';
import { createFakeCore, project, session } from './testing/fake-core.js';

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function setup() {
  const fake = createFakeCore();
  const app = await createServer({ core: fake.core, port: 0 });
  const sockets = new Set<Socket>();
  app.server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => app.close());
  return { ...fake, app, sockets, baseUrl };
}
const event = fixtures.passwordResetRun[0];
if (!event) throw new Error('Missing fixture event');

it('SSE emits heartbeat comments on the contract interval', async () => {
  const { baseUrl } = await setup();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = get(`${baseUrl}/api/events`, resolve);
    request.once('error', reject);
    cleanups.push(() => {
      request.destroy();
    });
  });
  const heartbeat = once(response, 'data');
  await vi.advanceTimersByTimeAsync(15_000);
  const [chunk] = (await heartbeat) as [Buffer];
  expect(chunk.toString('utf8')).toBe(': heartbeat\n\n');
  response.destroy();
});

it('SSE catches up, reconnects after a broken socket and resumes without gaps or duplicates', async () => {
  const { core, sockets, baseUrl } = await setup();
  await core.events.append([event, event]);
  const received: number[] = [];
  const statuses: EventStreamStatus[] = [];
  const subscription = subscribeEvents({
    baseUrl,
    onEvent: (e) => received.push(e.seq),
    onStatus: (s) => statuses.push(s),
  });
  cleanups.push(() => subscription.close());
  await vi.waitFor(() => expect(received).toEqual([1, 2]));
  for (const socket of sockets) socket.destroy();
  await vi.waitFor(() => expect(statuses).toContain('reconnecting'));
  await core.events.append([event, event]);
  await vi.waitFor(() => expect(received).toEqual([1, 2, 3, 4]), { timeout: 3000 });
  await core.events.append([event]);
  await vi.waitFor(() => expect(received).toEqual([1, 2, 3, 4, 5]));
  expect(core.events.cursors).toEqual([0, 2]);
  subscription.close();
  await vi.waitFor(() => expect(core.events.subscribers.size).toBe(0));
  expect(statuses.at(-1)).toBe('closed');
});

it('SSE gives Last-Event-ID precedence, filters projects, rejects invalid cursors', async () => {
  const { core, baseUrl, app } = await setup();
  await core.events.append([
    event,
    event,
    { ...event, projectId: projectIdSchema.parse('other') },
    event,
  ]);
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  const response = await fetch(`${baseUrl}/api/events?since=0&projectId=${project.id}`, {
    headers: { 'Last-Event-ID': '2' },
    signal: controller.signal,
  });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No stream');
  const first = new TextDecoder().decode((await reader.read()).value as Uint8Array);
  expect(first).toContain('id: 4\nevent: helix\n');
  expect(first).not.toContain('id: 3');
  expect(core.events.cursors).toEqual([2]);
  await reader.cancel();
  await vi.waitFor(() => expect(core.events.subscribers.size).toBe(0));
  expect((await app.inject('/api/events?since=-1')).statusCode).toBe(400);
  expect(
    (await app.inject({ url: '/api/events', headers: { 'last-event-id': 'bad' } })).statusCode,
  ).toBe(400);
});

it('SSE shuts down synchronously replaying slow clients and unsubscribes', async () => {
  const { core, baseUrl } = await setup();
  const huge = {
    ...event,
    type: 'explain.note' as const,
    payload: { text: 'x'.repeat(2 * 1024 * 1024) },
  };
  await core.events.append([huge]);
  const response = await fetch(`${baseUrl}/api/events`).catch(() => undefined);
  await response?.body?.cancel();
  await vi.waitFor(() => expect(core.events.subscribers.size).toBe(0));
});

it('WS replays scrollback, accepts input/resize, sends out/exit and detaches', async () => {
  const { core, attachment, outputs, baseUrl } = await setup();
  const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/mux?sessionId=${session.id}`);
  cleanups.push(() => socket.terminate());
  const received: TerminalOutput[] = [];
  socket.on('message', (data) => {
    if (!Buffer.isBuffer(data)) throw new Error('Expected UTF-8 terminal frame');
    received.push(terminalOutputSchema.parse(JSON.parse(data.toString()) as unknown));
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({ t: 'in', data: 'echo hello\r' }));
  socket.send(JSON.stringify({ t: 'resize', cols: 100, rows: 40 }));
  await vi.waitFor(() => expect(attachment.write).toHaveBeenCalledWith('echo hello\r'));
  expect(attachment.resize).toHaveBeenCalledWith(100, 40);
  expect(core.terminals.attach).toHaveBeenCalledWith(session.id, expect.any(Function));
  for (const output of outputs) {
    output({ t: 'out', data: 'hello\r\n' });
    output({ t: 'exit', code: 0 });
  }
  await vi.waitFor(() =>
    expect(received).toEqual([
      { t: 'out', data: 'scrollback\r\n' },
      { t: 'out', data: 'hello\r\n' },
      { t: 'exit', code: 0 },
    ]),
  );
  socket.close();
  await once(socket, 'close');
  await vi.waitFor(() => expect(attachment.detach).toHaveBeenCalledOnce());
});

it('WS rejects malformed input and invalid query before attaching', async () => {
  const { core, attachment, baseUrl, app } = await setup();
  expect((await app.inject('/mux?sessionId=')).statusCode).toBe(400);
  expect(core.terminals.attach).not.toHaveBeenCalled();
  const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/mux?sessionId=${session.id}`);
  cleanups.push(() => socket.terminate());
  await once(socket, 'open');
  socket.send('{bad json');
  const [code] = (await once(socket, 'close')) as unknown[];
  expect(code).toBe(1008);
  expect(attachment.detach).toHaveBeenCalledOnce();
});

it('WS closes safely on attach failure and detaches an attachment that resolves after close', async () => {
  const { core, baseUrl, attachment } = await setup();
  core.terminals.attach.mockRejectedValueOnce(new HelixError('NOT_FOUND', 'Secret path'));
  const failed = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/mux?sessionId=${session.id}`);
  const [code, reason] = (await once(failed, 'close')) as unknown[];
  expect(code).toBe(1011);
  expect(String(reason)).not.toContain('Secret');
  let complete: ((value: TerminalAttachment) => void) | undefined;
  core.terminals.attach.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const delayed = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/mux?sessionId=${session.id}`);
  cleanups.push(() => delayed.terminate());
  await once(delayed, 'open');
  delayed.close();
  await once(delayed, 'close');
  complete?.(attachment);
  await vi.waitFor(() => expect(attachment.detach).toHaveBeenCalledOnce());
});
