import {
  apiErrorSchema,
  routes,
  type ApiError,
  type ErrorCode,
  type RouteName,
  type SessionId,
} from '@helix/contracts';
import type { z } from 'zod';
import { subscribeEvents, type EventSubscription, type SubscribeEventsOptions } from './sse.js';

type Routes = typeof routes;
export type HttpRouteName = {
  [K in RouteName]: Routes[K] extends { transport: string } ? never : K;
}[RouteName];
export type RouteResponse<K extends HttpRouteName> = z.output<Routes[K]['response']>;
type Params<R> = R extends { params: z.ZodType<infer P> }
  ? P extends { id: infer I }
    ? [id: I]
    : P extends { projectId: infer I }
      ? [projectId: I]
      : []
  : [];
type Query<R> = R extends { query: z.ZodType<infer Q> }
  ? { [K in keyof Q]: K extends 'since' | 'limit' ? number : Q[K] }
  : never;
type QueryArgs<R> = R extends { query: z.ZodType }
  ? Record<string, never> extends Query<R>
    ? [query?: Query<R>]
    : [query: Query<R>]
  : [];
type BodyArgs<R extends { request: z.ZodType }> =
  z.output<R['request']> extends Record<string, never> ? [] : [body: z.input<R['request']>];
type HeaderArgs<R> = R extends { headers: typeof routes.createSession.headers }
  ? [options: { idempotencyKey: string }]
  : [];
export type RouteArgs<K extends HttpRouteName> = [
  ...Params<Routes[K]>,
  ...BodyArgs<Routes[K]>,
  ...QueryArgs<Routes[K]>,
  ...HeaderArgs<Routes[K]>,
];
export type HelixClient = {
  [K in HttpRouteName]: (...args: RouteArgs<K>) => Promise<RouteResponse<K>>;
} & {
  events(options: Omit<SubscribeEventsOptions, 'baseUrl' | 'fetch'>): EventSubscription;
  /** Validated WebSocket URL; the caller owns its terminal UI and socket lifecycle. */
  terminal(sessionId: SessionId): string;
};

export class HelixApiError extends Error {
  override readonly name = 'HelixApiError';
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: ApiError['error']['details'],
  ) {
    super(message);
  }
}

export function createHelixClient(options: {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}): HelixClient {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const fetcher = options.fetch ?? globalThis.fetch;
  const methods: Record<string, unknown> = {};
  for (const [name, route] of Object.entries(routes)) {
    if ('transport' in route) continue;
    methods[name] = async (...args: unknown[]) => {
      let index = 0;
      let path: string = route.path;
      if ('params' in route) {
        const key = path.includes(':projectId') ? 'projectId' : 'id';
        const params = route.params.parse({ [key]: args[index++] });
        const value = 'id' in params ? params.id : params.projectId;
        path = path.replace(`:${key}`, encodeURIComponent(value));
      }
      // Empty object schemas identify no-body routes without maintaining a parallel route list.
      const hasBody = !route.request.safeParse({}).success;
      const body: unknown = route.request.parse(hasBody ? args[index++] : {});
      const url = new URL(`${baseUrl}${path}`);
      if ('query' in route) {
        const input = args[index++] ?? {};
        if (typeof input !== 'object' || input === null || Array.isArray(input))
          throw new TypeError('Invalid query');
        const query = route.query.parse(
          Object.fromEntries(
            Object.entries(input).map(([key, value]) => [
              key,
              value === undefined ? undefined : String(value),
            ]),
          ),
        );
        for (const [key, value] of Object.entries(query))
          if (value !== undefined) url.searchParams.set(key, value);
      }
      const headers: Record<string, string> = {
        Accept: name === 'exportRecording' ? 'application/x-helixlog' : 'application/json',
      };
      if ('headers' in route) {
        const input = args[index] as { idempotencyKey?: unknown } | undefined;
        const parsed = route.headers.parse({ 'idempotency-key': input?.idempotencyKey });
        headers['Idempotency-Key'] = parsed['idempotency-key'];
      }
      const init: RequestInit = { method: route.method, headers };
      if (hasBody) {
        headers['Content-Type'] = 'contentType' in route ? route.contentType : 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const response = await fetcher(url, init);
      if (!response.ok) {
        const parsed = apiErrorSchema.safeParse(await response.json().catch(() => undefined));
        if (parsed.success) {
          const { code, message, details } = parsed.data.error;
          throw new HelixApiError(code, message, response.status, details);
        }
        throw new HelixApiError('INTERNAL_ERROR', 'Invalid daemon error response', response.status);
      }
      const data: unknown = await (
        name === 'exportRecording' ? response.text() : response.json()
      ).catch(() => {
        throw new HelixApiError('INTERNAL_ERROR', 'Invalid daemon response', response.status);
      });
      const parsed = route.response.safeParse(data);
      if (!parsed.success || response.status !== route.status) {
        throw new HelixApiError('INTERNAL_ERROR', 'Invalid daemon response', response.status);
      }
      return parsed.data;
    };
  }
  methods.events = (input: Omit<SubscribeEventsOptions, 'baseUrl' | 'fetch'>) =>
    subscribeEvents({ ...input, baseUrl, fetch: fetcher });
  methods.terminal = (sessionId: SessionId) => {
    const query = routes.terminal.query.parse({ sessionId });
    const url = new URL(`${baseUrl}${routes.terminal.path}`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('sessionId', query.sessionId);
    return url.toString();
  };
  // The mapped type mirrors the same route schema decisions used in the loop above.
  return methods as HelixClient;
}
