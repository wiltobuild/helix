import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  apiErrorSchema,
  HelixError,
  isHelixError,
  routes,
  type HelixCore,
  type ErrorCode,
} from '@helix/contracts';
import { createDispatch } from './dispatch.js';
import { openEventStream, openTerminal } from './streams.js';

export type ServerOptions = { core: HelixCore; port?: number; webDist?: string };
export const DEFAULT_PORT = 4317;
export function parsePort(value: string | number | undefined): number {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (
    (typeof value === 'string' && !/^\d+$/.test(value)) ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new HelixError('INVALID_REQUEST', 'Invalid HELIX_PORT');
  return port;
}

const errorStatus: Partial<Record<ErrorCode, number>> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  DIRTY_WORKTREE: 409,
  MERGE_BLOCKED: 409,
  HARNESS_UNAVAILABLE: 503,
};
const empty = z.strictObject({});
function loopbackHost(host: string | undefined) {
  return host !== undefined && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host);
}
function parseRequest<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new HelixError('INVALID_REQUEST', 'Request does not match the route schema');
  return parsed.data;
}

export async function createServer(options: ServerOptions) {
  const port = parsePort(options.port ?? process.env.HELIX_PORT);
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  const streams = new Set<() => void>();
  const dispatch = createDispatch(options.core);
  app.setErrorHandler((error, _request, reply) => {
    const badRequest =
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500;
    const domain = isHelixError(error)
      ? error
      : badRequest
        ? new HelixError('INVALID_REQUEST', 'Invalid request')
        : new HelixError('INTERNAL_ERROR', 'Internal server error');
    const status = errorStatus[domain.code] ?? 500;
    // Error details are untrusted and can contain stacks, paths or process output.
    const body = apiErrorSchema.parse({
      error: {
        code: domain.code,
        message: status === 500 ? 'Internal server error' : domain.message,
      },
    });
    void reply.code(status).send(body);
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!loopbackHost(request.headers.host))
      throw new HelixError('INVALID_REQUEST', 'Host must be loopback');
    const address = app.server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (
        ![
          `http://127.0.0.1:${actualPort}`,
          `http://localhost:${actualPort}`,
          'http://localhost:5317',
        ].includes(origin)
      )
        throw new HelixError('INVALID_REQUEST', 'Origin is not allowed');
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, Last-Event-ID');
      if (request.method === 'OPTIONS') return reply.code(204).send();
    }
  });
  app.addContentTypeParser(
    'application/x-helixlog',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024 },
    preClose(done) {
      for (const socket of app.websocketServer.clients) socket.terminate();
      app.websocketServer.close(done);
    },
  });
  for (const [name, route] of Object.entries(routes)) {
    if ('transport' in route && route.transport === 'websocket') {
      app.get(
        route.path,
        {
          websocket: true,
          preValidation(request, _reply, done) {
            parseRequest(route.query, request.query);
            done();
          },
        },
        (socket, request) => openTerminal(options.core, socket, request),
      );
      continue;
    }
    app.route({
      method: route.method,
      url: route.path,
      handler: async (request, reply) => {
        const params = parseRequest('params' in route ? route.params : empty, request.params ?? {});
        const query = parseRequest('query' in route ? route.query : empty, request.query ?? {});
        const headers = 'headers' in route ? parseRequest(route.headers, request.headers) : {};
        const body = parseRequest(route.request, request.body ?? {});
        if ('transport' in route) {
          openEventStream(options.core, request, reply, streams);
          return reply;
        }
        // Each field was validated using this route's schema; the dispatch map checks each core call.
        const result: unknown = await dispatch(
          name as Parameters<typeof dispatch>[0],
          { params, query, headers, body } as Parameters<typeof dispatch>[1],
        );
        if (process.env.NODE_ENV !== 'production' && !route.response.safeParse(result).success)
          throw new HelixError('INTERNAL_ERROR', 'Invalid core response');
        if (name === 'exportRecording') reply.type('application/x-helixlog; charset=utf-8');
        return reply.code(route.status).send(result);
      },
    });
  }
  const webDist = resolve(
    options.webDist ??
      process.env.HELIX_WEB_DIST ??
      fileURLToPath(new URL('../../web/dist', import.meta.url)),
  );
  const hasUi = await stat(resolve(webDist, 'index.html'))
    .then((s) => s.isFile())
    .catch(() => false);
  if (hasUi) await app.register(staticFiles, { root: webDist, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? '';
    if (
      hasUi &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !/^\/api(?:\/|$)/.test(pathname) &&
      pathname !== '/mux'
    )
      return reply.sendFile('index.html');
    throw new HelixError('NOT_FOUND', 'Route not found');
  });
  app.addHook('preClose', (done) => {
    for (const close of streams) close();
    for (const socket of app.websocketServer.clients) socket.terminate();
    done();
  });
  app.addHook('onClose', () => options.core.shutdown());
  return app;
}
