import {
  routes,
  sse,
  terminalInputSchema,
  type HelixCore,
  type TerminalAttachment,
} from '@helix/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

const MAX_BUFFER = 1024 * 1024;

export function openEventStream(
  core: HelixCore,
  request: FastifyRequest,
  reply: FastifyReply,
  streams: Set<() => void>,
) {
  const query = routes.events.query.parse(request.query);
  const headers = routes.events.headers.parse(request.headers);
  const since = Number(headers['last-event-id'] ?? query.since ?? sse.defaultSince);
  reply.hijack();
  // Preserve security/CORS headers set by the common request hook.
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
  reply.raw.writeHead(routes.events.status, {
    'Content-Type': `${sse.contentType}; charset=utf-8`,
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.flushHeaders();
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    unsubscribe?.();
    streams.delete(close);
    reply.raw.destroy();
  };
  const write = (frame: string) => {
    if (stopped) return;
    if (
      reply.raw.writableLength > MAX_BUFFER ||
      (reply.raw.socket?.writableLength ?? 0) > MAX_BUFFER
    ) {
      close();
      return;
    }
    reply.raw.write(frame);
    if (
      reply.raw.writableLength > MAX_BUFFER ||
      (reply.raw.socket?.writableLength ?? 0) > MAX_BUFFER
    )
      close();
  };
  streams.add(close);
  reply.raw.once('close', close);
  reply.raw.once('error', close);
  try {
    unsubscribe = core.events.subscribe(since, (event) => {
      if (!query.projectId || event.projectId === query.projectId) {
        if (
          process.env.NODE_ENV !== 'production' &&
          !routes.events.response.safeParse({
            id: String(event.seq),
            event: sse.event,
            data: event,
          }).success
        ) {
          close();
          return;
        }
        write(`id: ${event.seq}\nevent: ${sse.event}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    });
    // A synchronous replay can hit backpressure before subscribe returns its cleanup.
    if (stopped) unsubscribe();
    else timer = setInterval(() => write(sse.heartbeat), sse.heartbeatMs);
  } catch {
    close();
  }
}

export function openTerminal(core: HelixCore, socket: WebSocket, request: FastifyRequest) {
  const { sessionId } = routes.terminal.query.parse(request.query);
  let closed = false;
  let attachment: TerminalAttachment | undefined;
  let queue: ReturnType<typeof terminalInputSchema.parse>[] = [];
  let queuedBytes = 0;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    queue = [];
    attachment?.detach();
  };
  const sendInput = (input: ReturnType<typeof terminalInputSchema.parse>) => {
    if (input.t === 'in') attachment?.write(input.data);
    else attachment?.resize(input.cols, input.rows);
  };
  // Install handlers synchronously: input may arrive while attach is replaying scrollback.
  socket.on('close', cleanup);
  socket.on('error', cleanup);
  socket.on('message', (data, binary) => {
    if (closed) return;
    try {
      if (binary) throw new Error('Binary terminal input');
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      const input = terminalInputSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
      if (attachment) sendInput(input);
      else {
        queuedBytes += bytes.byteLength;
        if (queuedBytes > MAX_BUFFER || queue.length >= 1024)
          throw new Error('Too much pending input');
        queue.push(input);
      }
    } catch {
      cleanup();
      socket.close(1008, 'Invalid terminal input');
    }
  });
  void core.terminals
    .attach(sessionId, (output) => {
      if (closed || socket.readyState !== socket.OPEN) return;
      try {
        if (process.env.NODE_ENV !== 'production') routes.terminal.response.parse(output);
        if (socket.bufferedAmount > MAX_BUFFER) {
          cleanup();
          socket.terminate();
          return;
        }
        socket.send(JSON.stringify(output));
      } catch {
        cleanup();
        socket.close(1011, 'Terminal output failed');
      }
    })
    .then((attached) => {
      attachment = attached;
      if (closed) {
        attached.detach();
        return;
      }
      for (const input of queue) sendInput(input);
      queue = [];
    })
    .catch(() => {
      cleanup();
      socket.close(1011, 'Terminal unavailable');
    });
}
