import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createHelixClient } from '@helix/api-client';
import { fixtures, helixEventSchema, projectUpTo, type HelixEvent } from '@helix/contracts';
import { runCli } from './index.js';

const { projectId, orchestratorSessionId, goal, nodes: recordedNodes } = fixtures.passwordResetPlan;
const nodes = structuredClone(recordedNodes);
for (const node of nodes) delete node.sessionId;
const validPlan = { projectId, orchestratorSessionId, goal, nodes };
const project = fixtures.passwordResetProject;
const submitted = { ...fixtures.passwordResetPlan, nodes };
const initialEvents = fixtures.passwordResetRun.filter((event) => event.seq <= 2);
const submissionEvent = helixEventSchema.parse({
  v: 1,
  seq: 3,
  ts: submitted.createdAt,
  projectId,
  sessionId: orchestratorSessionId,
  type: 'plan.submitted',
  payload: { plan: submitted },
});

function fixture(
  env: NodeJS.ProcessEnv = {},
  events: readonly HelixEvent[] = [...initialEvents, submissionEvent],
) {
  const fetcher = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === '/api/projects') return Promise.resolve(Response.json([project]));
    if (url.pathname.endsWith('/events')) {
      const since = Number(url.searchParams.get('since'));
      const page = events.filter((event) => event.seq > since).slice(0, 2);
      return Promise.resolve(Response.json({ events: page, lastSeq: page.at(-1)?.seq ?? since }));
    }
    if (url.pathname === '/api/plans')
      return Promise.resolve(Response.json(submitted, { status: 201 }));
    if (url.pathname === '/api/explain')
      return Promise.resolve(
        Response.json(
          fixtures.passwordResetRun.find((event) => event.type === 'explain.note'),
          { status: 201 },
        ),
      );
    throw new Error(`Unexpected request ${init?.method} ${url.pathname}`);
  });
  const stdout = vi.fn<(text: string) => void>();
  const stderr = vi.fn<(text: string) => void>();
  const options = {
    env,
    stdout,
    stderr,
    client: createHelixClient({ baseUrl: 'http://127.0.0.1:4317', fetch: fetcher }),
  };
  return { fetcher, stdout, stderr, run: (args: string[]) => runCli(args, options) };
}

async function withPlanFile(input: unknown, run: (file: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'helix-plan-'));
  try {
    const file = join(directory, 'plan.json');
    await writeFile(file, JSON.stringify(input));
    await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function bodyOf(call: Parameters<typeof fetch> | undefined): unknown {
  const body = call?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Expected JSON request body');
  return JSON.parse(body) as unknown;
}

test('local errors include every JSON path and empty files, exit 1 without contacting daemon', async () => {
  const input = {
    ...validPlan,
    goal: '',
    nodes: [
      { ...nodes[0], title: 42, files: [] },
      { ...nodes[1], files: ['../outside'] },
      { ...nodes[2], files: undefined },
    ],
  };
  await withPlanFile(input, async (file) => {
    const f = fixture();
    expect(await f.run(['plan', 'submit', file])).toBe(1);
    expect(f.fetcher).not.toHaveBeenCalled();
    const errors = f.stderr.mock.calls.flat().join('\n');
    for (const path of [
      'goal:',
      'nodes[0].title:',
      'nodes[0].files: must not be empty',
      'nodes[1].files[0]:',
      'nodes[2].files:',
    ])
      expect(errors.split('\n').some((line) => line.includes(path))).toBe(true);
    const stderr = vi.fn();
    expect(await runCli(['plan', 'submit', file], { env: { HELIX_URL: 'bad URL' }, stderr })).toBe(
      1,
    );
    expect(stderr.mock.calls[0]?.[0]).toContain('nodes[0].files: must not be empty');
  });
});

test('JSON validation errors preserve paths in the error envelope', async () => {
  await withPlanFile(
    {
      ...validPlan,
      nodes: [
        { ...nodes[0], files: [] },
        { ...nodes[1], files: [] },
      ],
    },
    async (file) => {
      const f = fixture();
      expect(await f.run(['plan', 'submit', file, '--json'])).toBe(1);
      expect(JSON.parse(f.stderr.mock.calls[0]![0])).toEqual({
        error: {
          code: 'INVALID_REQUEST',
          message: 'nodes[0].files: must not be empty\nnodes[1].files: must not be empty',
        },
      });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
});

test.each(['duplicate', 'unknown', 'cycle'] as const)(
  'rejects %s graph locally with nodes path',
  async (kind) => {
    const graph = nodes.map((node) => ({ ...node, dependsOn: [...node.dependsOn] }));
    if (kind === 'duplicate') graph[1]!.id = graph[0]!.id;
    if (kind === 'unknown') graph[0]!.dependsOn = ['missing' as (typeof graph)[0]['id']];
    if (kind === 'cycle') {
      graph[0]!.dependsOn = [graph[1]!.id];
      graph[1]!.dependsOn = [graph[0]!.id];
    }
    await withPlanFile({ ...validPlan, nodes: graph }, async (file) => {
      const f = fixture();
      expect(await f.run(['plan', 'submit', file])).toBe(1);
      expect(f.stderr.mock.calls[0]?.[0]).toContain('nodes:');
      expect(f.fetcher).not.toHaveBeenCalled();
    });
  },
);

test.each(['both', 'project', 'session'] as const)(
  'fills omitted %s ids from environment',
  async (missing) => {
    await withPlanFile(
      {
        ...validPlan,
        ...(missing !== 'session' ? { projectId: undefined } : {}),
        ...(missing !== 'project' ? { orchestratorSessionId: undefined } : {}),
      },
      async (file) => {
        const f = fixture({ HELIX_PROJECT_ID: projectId, HELIX_SESSION_ID: orchestratorSessionId });
        expect(await f.run(['plan', 'submit', file])).toBe(0);
        expect(bodyOf(f.fetcher.mock.calls[0])).toEqual(validPlan);
      },
    );
  },
);

test('explicit plan ids override environment defaults', async () => {
  await withPlanFile(validPlan, async (file) => {
    const f = fixture({ HELIX_PROJECT_ID: 'other-project', HELIX_SESSION_ID: 'other-session' });
    expect(await f.run(['plan', 'submit', file])).toBe(0);
    expect(bodyOf(f.fetcher.mock.calls[0])).toEqual(validPlan);
  });
});

test.each([null, ''])('invalid explicit id %j does not fall back to environment', async (id) => {
  await withPlanFile({ ...validPlan, projectId: id }, async (file) => {
    const f = fixture({ HELIX_PROJECT_ID: projectId });
    expect(await f.run(['plan', 'submit', file])).toBe(1);
    expect(f.stderr.mock.calls[0]?.[0]).toContain('projectId:');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

test('missing ids without environment report both paths', async () => {
  await withPlanFile({ goal, nodes }, async (file) => {
    const f = fixture();
    expect(await f.run(['plan', 'submit', file])).toBe(1);
    expect(f.stderr.mock.calls[0]?.[0]).toContain('projectId:');
    expect(f.stderr.mock.calls[0]?.[0]).toContain('orchestratorSessionId:');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

test('overlap validation is delegated to daemon and its rejection exits 2', async () => {
  await withPlanFile(
    { ...validPlan, nodes: nodes.map((node) => ({ ...node, files: ['src/**'] })) },
    async (file) => {
      const f = fixture();
      f.fetcher.mockResolvedValueOnce(
        Response.json(
          { error: { code: 'INVALID_REQUEST', message: 'Parallel file claims overlap' } },
          { status: 400 },
        ),
      );
      expect(await f.run(['plan', 'submit', file])).toBe(2);
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(f.stderr.mock.calls[0]?.[0]).toContain('Parallel file claims overlap');
    },
  );
});

test.each(['awaiting_approval', 'approved', 'rejected'] as const)(
  'plan show replays %s and node status in human and JSON output',
  async (status) => {
    const events = [...initialEvents, submissionEvent];
    if (status !== 'awaiting_approval')
      events.push(
        helixEventSchema.parse({
          v: 1,
          seq: 4,
          ts: submitted.createdAt,
          projectId,
          sessionId: orchestratorSessionId,
          causedBy: 3,
          type: status === 'approved' ? 'plan.approved' : 'plan.rejected',
          payload:
            status === 'approved'
              ? { planId: submitted.id, approvedBy: 'human' }
              : { planId: submitted.id, reason: 'Revise scope' },
        }),
      );
    const f = fixture({}, events);
    expect(await f.run(['plan', 'show', submitted.id])).toBe(0);
    const human = f.stdout.mock.calls[0]![0];
    expect(human).toContain(goal);
    expect(human).toContain(status);
    for (const node of nodes) {
      expect(human).toContain(`${node.id}  ${node.agent}  pending`);
      expect(human).toContain(`dependsOn: ${node.dependsOn.join(', ') || '(none)'}`);
      expect(human).toContain(`files: ${node.files.join(', ')}`);
    }
    expect(await f.run(['plan', 'show', submitted.id, '--json'])).toBe(0);
    expect(JSON.parse(f.stdout.mock.calls.at(-1)![0])).toEqual(
      projectUpTo(events, events.at(-1)!.seq).plans[submitted.id],
    );
    expect(f.fetcher.mock.calls.length).toBeGreaterThan(4);
  },
);

test('plan show derives live node statuses from complete worker history', async () => {
  const f = fixture({}, fixtures.passwordResetRun);
  expect(await f.run(['plan', 'show', submitted.id, '--json'])).toBe(0);
  const result: unknown = JSON.parse(f.stdout.mock.calls[0]![0]);
  expect(result).toMatchObject({
    nodeStatus: { [nodes[0]!.id]: 'merged', [nodes[1]!.id]: 'merged' },
  });
});

test('plan show searches later projects, including after empty histories', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(Response.json([{ ...project, id: 'other-project' }, project]));
  f.fetcher.mockResolvedValueOnce(Response.json({ events: [], lastSeq: 0 }));
  expect(await f.run(['plan', 'show', submitted.id])).toBe(0);
  expect(f.stdout.mock.calls[0]?.[0]).toContain(goal);
});

test('unknown plan is a NOT_FOUND API error', async () => {
  const f = fixture();
  expect(await f.run(['plan', 'show', 'missing', '--json'])).toBe(2);
  expect(JSON.parse(f.stderr.mock.calls[0]![0])).toEqual({
    error: { code: 'NOT_FOUND', message: 'Unknown plan: missing' },
  });
});

test('explain defaults to HELIX_SESSION_ID, allows no node, and respects explicit session', async () => {
  const f = fixture({ HELIX_SESSION_ID: orchestratorSessionId });
  expect(await f.run(['explain', 'Keep this reason'])).toBe(0);
  expect(bodyOf(f.fetcher.mock.calls.at(-1))).toEqual({
    sessionId: orchestratorSessionId,
    text: 'Keep this reason',
  });
  expect(
    await f.run([
      'explain',
      'Node reason',
      '--node',
      nodes[0]!.id,
      '--session',
      'explicit-session',
    ]),
  ).toBe(0);
  expect(bodyOf(f.fetcher.mock.calls.at(-1))).toEqual({
    sessionId: 'explicit-session',
    planNodeId: nodes[0]!.id,
    text: 'Node reason',
  });
});

test('explain clearly errors without a session flag or environment', async () => {
  const f = fixture();
  expect(await f.run(['explain', 'why'])).toBe(1);
  expect(f.stderr.mock.calls[0]?.[0]).toContain(
    'explain requires --session <id> or HELIX_SESSION_ID',
  );
  expect(f.fetcher).not.toHaveBeenCalled();
});
