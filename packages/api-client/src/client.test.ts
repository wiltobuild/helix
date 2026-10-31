import { expect, it, vi } from 'vitest';
import { fixtures, routes, sessionIdSchema } from '@helix/contracts';
import { createHelixClient, HelixApiError } from './client.js';

it('exposes every contract route without code generation', () => {
  expect(Object.keys(createHelixClient({ baseUrl: 'http://localhost:4317' })).sort()).toEqual(
    Object.keys(routes).sort(),
  );
});
it('validates response bodies and statuses', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ status: 'wrong' }))
    .mockResolvedValueOnce(Response.json({ status: 'ok', version: '1' }, { status: 201 }));
  const client = createHelixClient({ baseUrl: 'http://localhost:4317', fetch: fetcher });
  await expect(client.health()).rejects.toBeInstanceOf(HelixApiError);
  await expect(client.health()).rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 201 });
});
it('encodes IDs, query numbers and idempotency headers', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ events: [], lastSeq: 3 }));
  const client = createHelixClient({ baseUrl: 'http://localhost:4317/', fetch: fetcher });
  await client.projectEvents(fixtures.passwordResetProject.id, { since: 3, limit: 50 });
  expect((fetcher.mock.calls[0]?.[0] as URL).search).toBe('?since=3&limit=50');
  expect(client.terminal(sessionIdSchema.parse('session id'))).toBe(
    'ws://localhost:4317/mux?sessionId=session+id',
  );
  await expect(
    client.projectEvents(fixtures.passwordResetProject.id, { since: -1 }),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
});
it('returns typed API errors and sanitizes non-JSON failures', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 'DIRTY_WORKTREE', message: 'Dirty', details: { files: 2 } } },
        { status: 409 },
      ),
    )
    .mockResolvedValueOnce(new Response('SECRET STACK', { status: 500 }));
  const client = createHelixClient({ baseUrl: 'http://localhost:4317', fetch: fetcher });
  await expect(client.health()).rejects.toMatchObject({
    code: 'DIRTY_WORKTREE',
    message: 'Dirty',
    status: 409,
    details: { files: 2 },
  });
  await expect(client.health()).rejects.toMatchObject({
    code: 'INTERNAL_ERROR',
    message: 'Invalid daemon error response',
  });
});

it('routes repository-free discovery without a project parameter', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(Response.json({ draft: null })));
  const client = createHelixClient({ baseUrl: 'http://localhost:4317', fetch: fetcher });
  await client.discoveryIntake();
  await client.changeDiscovery({
    action: 'new',
    mode: 'interview',
    id: 'new',
    revision: 0,
    requestId: 'standalone',
  });
  expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('http://localhost:4317/api/discovery'));
  expect(fetcher.mock.calls[1]?.[0]).toEqual(new URL('http://localhost:4317/api/discovery'));
  expect(fetcher.mock.calls[1]?.[1]?.body).toContain('standalone');
});
