import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  routes,
  HelixError,
  errorCodeSchema,
  apiErrorSchema,
  type HelixCore,
} from '@helix/contracts';
import { createHelixClient, HelixApiError } from '@helix/api-client';
import { createServer, parsePort } from './server.js';
import { startDaemon } from './lifecycle.js';
import { createFakeCore, project, session, approval, plan } from './testing/fake-core.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const sessionBody = { title: 'Task', prompt: 'Do it', agent: 'codex', interface: 'chat' } as const;

it('validates configured ports including ephemeral listeners', () => {
  expect(parsePort(undefined)).toBe(4317);
  expect(parsePort('0')).toBe(0);
  expect(parsePort('65535')).toBe(65535);
  for (const input of ['', 'NaN', '4317junk', '-1', '65536', 1.5])
    expect(() => parsePort(input)).toThrow(HelixError);
});
const planBody = {
  projectId: project.id,
  orchestratorSessionId: session.id,
  goal: plan.goal,
  nodes: plan.nodes,
};
const cases = [
  { name: 'health', method: 'health' },
  { name: 'harnesses', method: 'harnesses' },
  { name: 'projects', method: 'listProjects' },
  { name: 'createProject', method: 'addProject', payload: { repoPath: 'repo' } },
  { name: 'projectEvents', method: 'projectEvents' },
  {
    name: 'createSession',
    method: 'createSession',
    payload: sessionBody,
    headers: { 'idempotency-key': 'key' },
  },
  { name: 'sendMessage', method: 'sendMessage', payload: { text: 'Hi', mode: 'queue' } },
  { name: 'stopSession', method: 'stopSession' },
  { name: 'archiveSession', method: 'archiveSession' },
  { name: 'decideApproval', method: 'decideApproval', payload: { decision: 'approved' } },
  { name: 'sessionDiff', method: 'diff', query: '?scope=workspace' },
  { name: 'mergeSession', method: 'merge' },
  { name: 'submitPlan', method: 'submitPlan', payload: planBody },
  { name: 'explain', method: 'explain', payload: { sessionId: session.id, text: 'Because' } },
  { name: 'exportRecording', method: 'exportRecording' },
  {
    name: 'importRecording',
    method: 'importRecording',
    payload: '{"recording":true}\n',
    headers: { 'content-type': 'application/x-helixlog' },
  },
] as const satisfies readonly {
  name: keyof typeof routes;
  method: keyof HelixCore;
  payload?: unknown;
  headers?: Record<string, string>;
  query?: string;
}[];

async function setup() {
  const fake = createFakeCore();
  const app = await createServer({ core: fake.core, webDist: join(tmpdir(), 'helix-no-ui') });
  cleanup.push(() => app.close());
  return { ...fake, app };
}
describe('contract routes', () => {
  for (const item of cases) {
    const route = routes[item.name];
    const url =
      route.path
        .replace(':projectId', project.id)
        .replace(
          ':id',
          item.name === 'decideApproval'
            ? approval.id
            : item.name === 'projectEvents' || item.name === 'createSession'
              ? project.id
              : session.id,
        ) + ('query' in item ? item.query : '');
    const request = {
      method: route.method,
      url,
      ...('payload' in item ? { payload: item.payload } : {}),
      ...('headers' in item ? { headers: item.headers } : {}),
    };
    it(`${item.name}: happy path, validation and domain error`, async () => {
      const { app, core } = await setup();
      const response = await app.inject(request);
      expect(response.statusCode).toBe(route.status);
      expect(
        route.response.safeParse(item.name === 'exportRecording' ? response.body : response.json())
          .success,
      ).toBe(true);
      expect(core[item.method]).toHaveBeenCalledOnce();
      const invalid = await app.inject({
        ...request,
        url: `${url}${url.includes('?') ? '&' : '?'}unexpected=true`,
      });
      expect(invalid.statusCode).toBe(400);
      expect(apiErrorSchema.parse(invalid.json()).error.code).toBe('INVALID_REQUEST');
      expect(core[item.method]).toHaveBeenCalledOnce();
      core[item.method].mockRejectedValueOnce(new HelixError('NOT_FOUND', 'Missing entity'));
      const missing = await app.inject(request);
      expect(missing.statusCode).toBe(404);
      expect(apiErrorSchema.parse(missing.json()).error.message).toBe('Missing entity');
    });
  }
  it('covers every ordinary route', () => {
    expect(cases.map(({ name }) => name).sort()).toEqual(
      Object.entries(routes)
        .filter(([, route]) => !('transport' in route))
        .map(([name]) => name)
        .sort(),
    );
  });
});

it('requires idempotency and forwards validated arguments and numeric defaults', async () => {
  const { app, core } = await setup();
  const url = `/api/projects/${project.id}/sessions`;
  expect((await app.inject({ method: 'POST', url, payload: sessionBody })).statusCode).toBe(400);
  expect(core.createSession).not.toHaveBeenCalled();
  await app.inject({
    method: 'POST',
    url,
    payload: sessionBody,
    headers: { 'Idempotency-Key': 'opaque' },
  });
  expect(core.createSession).toHaveBeenCalledWith(project.id, sessionBody, 'opaque');
  await app.inject(`/api/projects/${project.id}/events`);
  expect(core.projectEvents).toHaveBeenLastCalledWith(project.id, 0, 100);
  await app.inject(`/api/projects/${project.id}/events?since=42&limit=17`);
  expect(core.projectEvents).toHaveBeenLastCalledWith(project.id, 42, 17);
  expect(
    (await app.inject(`/api/projects/${project.id}/events?since=9007199254740992`)).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { 'content-type': 'application/json' },
        payload: '{',
      })
    ).statusCode,
  ).toBe(400);
});

it.each(errorCodeSchema.options)('maps %s without leaking stacks or details', async (code) => {
  const { app, core } = await setup();
  core.health.mockRejectedValueOnce(
    new HelixError(code, 'Domain failure', { stack: 'SECRET_STACK' }),
  );
  const response = await app.inject('/api/health');
  const expected =
    code === 'INVALID_REQUEST'
      ? 400
      : code === 'NOT_FOUND'
        ? 404
        : ['CONFLICT', 'IDEMPOTENCY_CONFLICT', 'DIRTY_WORKTREE', 'MERGE_BLOCKED'].includes(code)
          ? 409
          : code === 'HARNESS_UNAVAILABLE'
            ? 503
            : 500;
  expect(response.statusCode).toBe(expected);
  expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
  expect(response.body).not.toContain('SECRET_STACK');
});

it('sanitizes unexpected failures and invalid core responses', async () => {
  const { app, core } = await setup();
  core.health.mockRejectedValueOnce(new Error('SECRET'));
  const failure = await app.inject('/api/health');
  expect(failure.statusCode).toBe(500);
  expect(failure.body).not.toContain('SECRET');
  core.health.mockResolvedValueOnce({ status: 'ok', version: '' });
  expect((await app.inject('/api/health')).statusCode).toBe(500);
});

it.each([
  'evil.test',
  '127.0.0.1.evil.test',
  'localhost.evil.test',
  'localhost@evil.test',
  '0.0.0.0',
  '127.1',
  '[::]',
])('rejects Host %s', async (host) => {
  const { app } = await setup();
  expect((await app.inject({ url: '/api/health', headers: { host } })).statusCode).toBe(400);
});
it('enforces Origin and supports the Vite preflight', async () => {
  const { app } = await setup();
  for (const origin of [
    'null',
    'https://localhost:4317',
    'http://evil.test',
    'http://localhost:4318',
  ]) {
    expect((await app.inject({ url: '/api/health', headers: { origin } })).statusCode).toBe(400);
  }
  for (const origin of [
    'http://localhost:4317',
    'http://127.0.0.1:4317',
    'http://localhost:5317',
  ]) {
    const response = await app.inject({ url: '/api/health', headers: { origin } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
  }
  expect(
    (
      await app.inject({
        method: 'OPTIONS',
        url: '/api/projects',
        headers: {
          origin: 'http://localhost:5317',
          'access-control-request-headers': 'content-type,idempotency-key',
        },
      })
    ).statusCode,
  ).toBe(204);
  expect((await app.inject('/api/unknown')).statusCode).toBe(404);
  expect((await app.inject('/unknown')).statusCode).toBe(404);
});

it('serves static assets and SPA routes while keeping API misses as JSON 404s', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-web-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'index.html'), '<html>Helix UI</html>');
  await writeFile(join(directory, 'asset.js'), 'const helix = true;');
  const app = await createServer({ core: createFakeCore().core, webDist: directory });
  cleanup.push(() => app.close());
  for (const url of ['/', '/projects/example'])
    expect((await app.inject(url)).body).toContain('Helix UI');
  expect((await app.inject('/asset.js')).body).toContain('const helix');
  for (const url of ['/api', '/api/missing', '/mux'])
    expect((await app.inject(url)).statusCode).not.toBe(200);
});

it('writes run.json, binds loopback and removes it on shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-run-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const { core } = createFakeCore();
  const daemon = await startDaemon({ core, dataDir: directory, version: 'test', port: 0 });
  cleanup.push(daemon.stop);
  expect(daemon.server.server.address()).toMatchObject({ address: '127.0.0.1', port: daemon.port });
  expect(JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'))).toMatchObject({
    pid: process.pid,
    port: daemon.port,
    version: 'test',
  });
  expect(core.start).toHaveBeenCalledOnce();
  await daemon.stop();
  await expect(readFile(join(directory, 'run.json'))).rejects.toThrow();
  expect(core.shutdown).toHaveBeenCalledOnce();
});

it('round trips typed client commands, raw recordings and typed errors', async () => {
  const { app, core } = await setup();
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = createHelixClient({ baseUrl });
  expect(await client.health()).toEqual({ status: 'ok', version: 'test' });
  expect(
    await client.createSession(project.id, sessionBody, { idempotencyKey: 'client-key' }),
  ).toEqual(session);
  await client.projectEvents(project.id, { since: 10, limit: 20 });
  expect(core.projectEvents).toHaveBeenLastCalledWith(project.id, 10, 20);
  expect(await client.exportRecording(project.id)).toBe('{"recording":true}\n');
  await client.importRecording('{"raw":true}\n');
  expect(core.importRecording).toHaveBeenCalledWith('{"raw":true}\n');
  core.merge.mockRejectedValueOnce(new HelixError('MERGE_BLOCKED', 'Check failed'));
  await expect(client.mergeSession(session.id)).rejects.toMatchObject({
    name: 'HelixApiError',
    code: 'MERGE_BLOCKED',
    status: 409,
  });
  core.health.mockRejectedValueOnce(new HelixError('NOT_FOUND', 'Gone'));
  await expect(client.health()).rejects.toBeInstanceOf(HelixApiError);
});
