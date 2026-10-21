import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createHelixClient } from '@helix/api-client';
import { fixtures } from '@helix/contracts';
import { runCli, resolveBaseUrl } from './index.js';

const project = fixtures.passwordResetProject;
const session = fixtures.passwordResetRun.find((e) => e.type === 'session.created')!.payload
  .session;
const requestUrl = (input: Parameters<typeof fetch>[0]) =>
  input instanceof Request ? input.url : input.toString();
function requestBody(body: unknown): unknown {
  if (typeof body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(body) as unknown;
}
function fixture() {
  const fetcher = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(requestUrl(input));
    let body: unknown;
    let status = 200;
    if (url.pathname === '/api/projects') {
      body = init?.method === 'POST' ? project : [project];
      if (init?.method === 'POST') status = 201;
    } else if (url.pathname.endsWith('/events')) {
      // Deliberately small pages prove status follows cursors rather than page length.
      const events = fixtures.passwordResetRun
        .filter((e) => e.seq > Number(url.searchParams.get('since')))
        .slice(0, 7);
      body = { events, lastSeq: events.at(-1)?.seq ?? Number(url.searchParams.get('since')) };
    } else if (url.pathname.endsWith('/sessions')) {
      body = session;
      status = 201;
    } else if (url.pathname.endsWith('/messages')) {
      body = { accepted: true };
      status = 202;
    } else if (url.pathname === '/api/plans') {
      body = fixtures.passwordResetPlan;
      status = 201;
    } else if (url.pathname === '/api/explain') {
      body = fixtures.passwordResetRun.find((e) => e.type === 'explain.note');
      status = 201;
    } else throw new Error(`Unexpected URL ${url.pathname}`);
    return Promise.resolve(Response.json(body, { status }));
  });
  const stdout = vi.fn();
  const stderr = vi.fn();
  const options = {
    client: createHelixClient({ baseUrl: 'http://127.0.0.1:4317', fetch: fetcher }),
    stdout,
    stderr,
    cwd: resolve('.'),
  };
  return { fetcher, stdout, stderr, run: (args: string[]) => runCli(args, options) };
}

test('status paginates project history and derives machine and human status', async () => {
  const f = fixture();
  expect(await f.run(['status', '--json'])).toBe(0);
  const result = JSON.parse(String(f.stdout.mock.calls[0]?.[0])) as {
    projects: { sessions: { status: string; column: string }[] }[];
  };
  expect(
    result.projects[0]?.sessions.some((s) => s.status === 'merged' && s.column === 'archive'),
  ).toBe(true);
  expect(f.fetcher.mock.calls.length).toBeGreaterThan(2);
  expect(await f.run(['status'])).toBe(0);
  expect(f.stdout.mock.calls.at(-1)?.[0]).toContain(project.name);
});

test('project, task, interrupt and explain use validated API requests', async () => {
  const f = fixture();
  expect(await f.run(['project', 'add', '.'])).toBe(0);
  expect(
    await f.run([
      'task',
      'A task',
      '--agent',
      'codex',
      '--prompt',
      'Implement it',
      '--project',
      project.id,
      '--json',
    ]),
  ).toBe(0);
  const create = f.fetcher.mock.calls.find(([url]) => requestUrl(url).endsWith('/sessions'))!;
  expect(requestBody(create[1]?.body)).toMatchObject({
    title: 'A task',
    prompt: 'Implement it',
    agent: 'codex',
    interface: 'chat',
  });
  expect(new Headers(create[1]?.headers).get('Idempotency-Key')).toBeTruthy();
  expect(await f.run(['send', session.id, 'Change it', '--interrupt'])).toBe(0);
  expect(requestBody(f.fetcher.mock.calls.at(-1)?.[1]?.body)).toEqual({
    text: 'Change it',
    mode: 'interrupt',
  });
  expect(
    await f.run([
      'explain',
      'Reason',
      '--session',
      session.id,
      '--node',
      fixtures.passwordResetPlan.nodes[0]!.id,
    ]),
  ).toBe(0);
});

test('plan files and run.json discovery work independently of repository root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-cli-'));
  try {
    await writeFile(join(directory, 'run.json'), JSON.stringify({ port: 54321 }));
    expect(await resolveBaseUrl({ HELIX_DATA_DIR: directory })).toBe('http://127.0.0.1:54321');
    expect(
      await resolveBaseUrl({ HELIX_DATA_DIR: directory, HELIX_URL: 'http://localhost:1234/' }),
    ).toBe('http://localhost:1234');
    const { projectId, orchestratorSessionId, goal, nodes } = fixtures.passwordResetPlan;
    const file = join(directory, 'plan.json');
    await writeFile(file, JSON.stringify({ projectId, orchestratorSessionId, goal, nodes }));
    const f = fixture();
    expect(await f.run(['plan', 'submit', file])).toBe(0);
    await writeFile(file, '{}');
    expect(await f.run(['plan', 'submit', file])).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  [],
  ['task', 'title', '--agent', 'unknown', '--prompt', 'text'],
  ['send', 'session'],
  ['status', '--interrupt'],
  ['explain', 'why'],
  ['status', '--wat'],
])('usage errors do not contact daemon: %j', async (...args: string[]) => {
  const f = fixture();
  expect(await f.run(args)).toBe(1);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test('API and transport failures return 2 and include ErrorCode', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(
    Response.json({ error: { code: 'FORBIDDEN', message: 'Denied' } }, { status: 403 }),
  );
  expect(await f.run(['status', '--json'])).toBe(2);
  expect(JSON.parse(String(f.stderr.mock.calls[0]?.[0]))).toEqual({
    error: { code: 'FORBIDDEN', message: 'Denied' },
  });
  f.fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
  expect(await f.run(['status'])).toBe(2);
  expect(f.stderr.mock.calls.at(-1)?.[0]).toContain('INTERNAL_ERROR');
});
