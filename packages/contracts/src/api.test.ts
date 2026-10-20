import { expect, it } from 'vitest';
import {
  apiErrorSchema,
  backfill,
  eventSchemas,
  eventsQuerySchema,
  fixtures,
  idempotencyHeadersSchema,
  routeJsonSchemas,
  routes,
  sse,
  sseHeadersSchema,
  sseMessageSchema,
  terminalInputSchema,
  terminalOutputSchema,
  toJsonSchema,
} from './index.js';

it('exports JSON Schema for every route, event and HTTP error', () => {
  const schemas = routeJsonSchemas();
  expect(Object.keys(schemas)).toEqual(Object.keys(routes));
  for (const schema of Object.values(schemas)) {
    expect(schema.request.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.response.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.error).toHaveProperty('properties.error');
  }
  for (const schema of Object.values(eventSchemas))
    expect(toJsonSchema(schema)).toHaveProperty('properties.payload');
});
it('requires idempotency while allowing unrelated normalized headers', () => {
  expect(idempotencyHeadersSchema.safeParse({}).success).toBe(false);
  expect(idempotencyHeadersSchema.safeParse({ 'idempotency-key': '' }).success).toBe(false);
  expect(
    idempotencyHeadersSchema.safeParse({
      'idempotency-key': 'submit-1',
      accept: 'application/json',
    }).success,
  ).toBe(true);
});
it('validates wire query/header cursors and page limits', () => {
  expect(eventsQuerySchema.safeParse({ since: '0', limit: '1000' }).success).toBe(true);
  for (const since of ['-1', '1.5', '', '01', '9007199254740992'])
    expect(eventsQuerySchema.safeParse({ since }).success).toBe(false);
  expect(eventsQuerySchema.safeParse({ limit: '1001' }).success).toBe(false);
  expect(eventsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  expect(sseHeadersSchema.safeParse({ 'last-event-id': '42' }).success).toBe(true);
  expect(sse.heartbeatMs).toBe(15_000);
  expect(backfill.sinceExclusive).toBe(true);
});
it('links each SSE id to its data sequence', () => {
  const data = fixtures.passwordResetRun[0]!;
  expect(sseMessageSchema.safeParse({ id: '1', event: 'helix', data }).success).toBe(true);
  expect(sseMessageSchema.safeParse({ id: '2', event: 'helix', data }).success).toBe(false);
});
it('separates terminal client and server messages and rejects invalid dimensions', () => {
  expect(terminalInputSchema.safeParse({ t: 'in', data: '\u0003' }).success).toBe(true);
  expect(terminalInputSchema.safeParse({ t: 'resize', cols: 80, rows: 24 }).success).toBe(true);
  expect(terminalInputSchema.safeParse({ t: 'resize', cols: 0, rows: 24 }).success).toBe(false);
  expect(terminalOutputSchema.safeParse({ t: 'out', data: '\u001b[32mready' }).success).toBe(true);
  expect(terminalOutputSchema.safeParse({ t: 'exit', code: null }).success).toBe(true);
  expect(terminalInputSchema.safeParse({ t: 'out', data: 'x' }).success).toBe(false);
});
it('allows JSON error details and rejects non-JSON runtime values', () => {
  expect(
    apiErrorSchema.safeParse({
      error: { code: 'INVALID_REQUEST', message: 'Invalid title', details: { field: 'title' } },
    }).success,
  ).toBe(true);
  expect(
    apiErrorSchema.safeParse({
      error: { code: 'INTERNAL_ERROR', message: 'oops', details: () => 1 },
    }).success,
  ).toBe(false);
});
