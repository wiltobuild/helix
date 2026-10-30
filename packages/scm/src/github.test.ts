import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  eventSchemas,
  HelixError,
  projectSchema,
  pullRequestNumberSchema,
  sessionIdSchema,
  type ScmEmission,
  type Unsubscribe,
} from '@helix/contracts';
import { createFakeGitHub, type FakeCheck } from '@helix/testing';
import { buildFeedbackMessage, createGitHubScm } from './index.js';

const project = projectSchema.parse({
  id: 'project',
  name: 'Demo',
  repoPath: 'C:/demo',
  defaultBranch: 'main',
  github: { owner: 'acme', repo: 'demo' },
  defaultAgent: 'codex',
  createdAt: '2026-01-01T00:00:00.000Z',
});
const number = pullRequestNumberSchema.parse(1);
const openOptions = {
  project,
  sessionId: sessionIdSchema.parse('worker'),
  head: 'feature',
  base: 'main',
  title: 'Fix',
  body: 'Fix the tests',
  draft: false,
};
const check = (conclusion: string | null, id = 1): FakeCheck => ({
  id,
  name: 'unit',
  status: conclusion ? 'completed' : 'in_progress',
  conclusion,
});
const subscriptions: Unsubscribe[] = [];
const requestUrl = (input: Parameters<typeof fetch>[0]) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  for (const stop of subscriptions.splice(0)) stop();
  vi.useRealTimers();
});

describe('GitHub SCM', () => {
  test('refresh publishes through watchers immediately, retains ETags and resets one poll timer', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    const events: ScmEmission[] = [];
    const scm = createGitHubScm({ token: 'test', fetch: fake.fetch });
    subscriptions.push(scm.watch(project, number, (e) => events.push(e)));
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    events.length = 0;
    fake.setPr(1, { mergeable: null });
    await scm.refresh!(project, number);
    expect(events.map((e) => e.type)).toEqual(['pr.updated']);
    expect(events[0]?.payload).toMatchObject({ pr: { mergeable: 'unknown' } });
    expect(fake.requests.filter((r) => r.ifNoneMatch)).toHaveLength(4);
    events.length = 0;
    await scm.refresh!(project, number);
    expect(events.map((e) => e.type)).toEqual(['pr.updated']);
    const count = fake.requests.length;
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fake.requests).toHaveLength(count);
    fake.setPr(1, { mergeable: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.requests).toHaveLength(count + 5);
    expect(events.at(-1)?.payload).toMatchObject({ pr: { mergeable: 'conflicting' } });
  });

  test('refresh waits for an older poll and coalesces concurrent refresh callers', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    let release!: () => void;
    let hold = true;
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      if (hold && requestUrl(input).endsWith('/pulls/1')) {
        hold = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return response;
    };
    const scm = createGitHubScm({ token: 'test', fetch: fetcher });
    const events: ScmEmission[] = [];
    subscriptions.push(scm.watch(project, number, (e) => events.push(e)));
    await flush();
    const one = scm.refresh!(project, number);
    const two = scm.refresh!(project, number);
    expect(one).toBe(two);
    expect(fake.requests).toHaveLength(1);
    fake.setPr(1, { mergeable: false });
    release();
    await Promise.all([one, two]);
    expect(fake.requests.filter((r) => r.path.endsWith('/pulls/1'))).toHaveLength(2);
    expect(events.at(-1)?.payload).toMatchObject({ pr: { mergeable: 'conflicting' } });
    const count = fake.requests.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.requests).toHaveLength(count + 5);
  });

  test('refresh respects rate-limit cooldown and last unsubscribe', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    const scm = createGitHubScm({ token: 'test', fetch: fake.fetch });
    await scm.refresh!(project, number);
    expect(fake.requests).toHaveLength(0);
    const stop = scm.watch(project, number);
    subscriptions.push(stop);
    await flush();
    fake.rateLimitNext({ headers: { 'Retry-After': '45' }, status: 429 });
    await scm.refresh!(project, number);
    const count = fake.requests.length;
    await scm.refresh!(project, number);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(fake.requests).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.requests.length).toBeGreaterThan(count);
    stop();
    const stopped = fake.requests.length;
    await scm.refresh!(project, number);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.requests).toHaveLength(stopped);
  });

  test('open PR preserves draft and sends REST creation parameters', async () => {
    const fake = createFakeGitHub();
    const scm = createGitHubScm({ token: 'test-token', fetch: fake.fetch });
    const pr = await scm.openPr({ ...openOptions, draft: true });
    expect(pr).toMatchObject({
      number: 1,
      draft: true,
      state: 'open',
      headSha: 'head-1',
      mergeable: 'mergeable',
    });
    expect(fake.requests[0]?.body).toEqual({
      head: 'feature',
      base: 'main',
      title: 'Fix',
      body: 'Fix the tests',
      draft: true,
    });
    expect(JSON.stringify(fake.requests)).not.toContain('test-token');
  });

  test('second poll sends ETags, gets 304s, and emits nothing', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    const events: ScmEmission[] = [];
    const scm = createGitHubScm({ token: 'test', fetch: fake.fetch });
    subscriptions.push(scm.watch(project, number, (event) => events.push(event)));
    await flush();
    expect(events.map((e) => e.type)).toEqual(['pr.updated', 'ci.updated', 'review.updated']);
    events.length = 0;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events).toEqual([]);
    const conditional = fake.requests.filter((r) => r.ifNoneMatch);
    expect(conditional).toHaveLength(4);
    expect(conditional.every((r) => r.status === 304)).toBe(true);
  });

  test('open -> pending -> failure -> new head -> success -> approval -> merge', async () => {
    const fake = createFakeGitHub();
    const events: ScmEmission[] = [];
    const scm = createGitHubScm({ token: 'test', fetch: fake.fetch });
    const pr = await scm.openPr(openOptions);
    fake.scriptChecks(pr.number, [[check(null)], [check('failure')]]);
    subscriptions.push(scm.watch(project, pr.number, (event) => events.push(event)));
    await flush();
    expect(events.find((e) => e.type === 'ci.updated')?.payload).toMatchObject({
      checks: { pending: 1 },
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.filter((e) => e.type === 'ci.updated').at(-1)?.payload).toMatchObject({
      checks: { failed: 1, failingNames: ['unit'] },
    });
    fake.setPr(pr.number, { head: { sha: 'head-2', ref: 'feature' } });
    fake.setChecks(pr.number, [check('success')]);
    fake.setThreads(pr.number, [
      {
        isResolved: false,
        comments: [{ author: 'Ada', path: 'src/a.ts', line: 4, body: 'Handle the error' }],
      },
    ]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events.filter((e) => e.type === 'ci.updated').at(-1)?.payload).toMatchObject({
      checks: { passed: 1, failingNames: [] },
    });
    expect(events.filter((e) => e.type === 'pr.updated').at(-1)?.payload).toMatchObject({
      pr: { headSha: 'head-2' },
    });
    fake.setReviews(pr.number, [{ id: 1, user: { login: 'Ada' }, state: 'APPROVED' }]);
    fake.setThreads(pr.number, [{ isResolved: true }]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events.filter((e) => e.type === 'review.updated').at(-1)?.payload).toMatchObject({
      review: { decision: 'approved', unresolvedThreads: 0 },
    });
    expect(
      await scm.merge({
        project,
        prNumber: pr.number,
        expectedHeadSha: 'head-2',
        method: 'squash',
      }),
    ).toEqual({ mergeSha: 'merge-head-2' });
    expect(events.at(-1)).toEqual({
      type: 'pr.merged',
      payload: { prNumber: 1, mergeSha: 'merge-head-2' },
    });
    expect(fake.requests.find((r) => r.method === 'PUT')?.body).toEqual({
      sha: 'head-2',
      merge_method: 'squash',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events.filter((e) => e.type === 'pr.merged')).toHaveLength(1);
    for (const event of events)
      expect(eventSchemas[event.type].shape.payload.safeParse(event.payload).success).toBe(true);
  });

  test('head changes emit CI and reviews even when normalized summaries match', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    fake.setChecks(1, [check('failure')]);
    const events: ScmEmission[] = [];
    subscriptions.push(
      createGitHubScm({ token: 'test', fetch: fake.fetch }).watch(project, number, (e) =>
        events.push(e),
      ),
    );
    await flush();
    events.length = 0;
    fake.setPr(1, { head: { sha: 'new', ref: 'feature' } });
    fake.setChecks(1, [check('failure')]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events.map((e) => e.type)).toEqual(['pr.updated', 'ci.updated', 'review.updated']);
  });

  test('poll interval returns to 15 seconds after pending checks finish', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    fake.scriptChecks(1, [[check(null)], [check('success')]]);
    subscriptions.push(
      createGitHubScm({ token: 'test', fetch: fake.fetch }).watch(project, number),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    const count = fake.requests.length;
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fake.requests).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.requests.length).toBeGreaterThan(count);
  });

  test('shares one poller; subscribers are independent and last unsubscribe stops it', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    const scm = createGitHubScm({ token: 'test', fetch: fake.fetch, pollMs: 1000 });
    const one = vi.fn();
    const two = vi.fn();
    const stopOne = scm.watch(project, number, one);
    subscriptions.push(stopOne);
    await flush();
    const count = fake.requests.length;
    const stopTwo = scm.watch(project, number, two);
    subscriptions.push(stopTwo);
    await flush();
    expect(two).toHaveBeenCalledTimes(3);
    expect(fake.requests).toHaveLength(count);
    stopOne();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.requests).toHaveLength(count * 2);
    stopTwo();
    stopTwo();
    const stopped = fake.requests.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.requests).toHaveLength(stopped);
  });

  test.each([
    [{ 'Retry-After': '45' }, 45_000, 429],
    [{ 'Retry-After': 'Thu, 01 Jan 2026 00:00:40 GMT' }, 40_000, 429],
    [{ 'X-RateLimit-Reset': String(Date.parse('2026-01-01T00:01:30Z') / 1000) }, 90_000, 403],
    [{}, 60_000, 403],
  ] as const)('honors rate-limit headers %j', async (headers, wait, status) => {
    const fake = createFakeGitHub();
    fake.seedPr();
    fake.rateLimitNext({ headers, status });
    const onError = vi.fn();
    subscriptions.push(
      createGitHubScm({ token: 'test', fetch: fake.fetch, onError }).watch(project, number),
    );
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.any(HelixError));
    expect(fake.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(fake.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.requests.length).toBeGreaterThan(1);
  });

  test('paginates checks, commit statuses, reviews, and GraphQL threads; cached page links survive 304', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    fake.setChecks(
      1,
      Array.from({ length: 101 }, (_, id) => ({ ...check('success', id), name: `check-${id}` })),
      Array.from({ length: 101 }, (_, id) => ({
        id,
        context: `status-${id}`,
        state: id === 100 ? 'failure' : 'success',
      })),
    );
    fake.setReviews(
      1,
      Array.from({ length: 101 }, (_, id) => ({
        id,
        user: { login: `reviewer-${id}` },
        state: id === 100 ? 'CHANGES_REQUESTED' : 'APPROVED',
      })),
    );
    fake.setThreads(
      1,
      Array.from({ length: 101 }, (_, id) => ({ isResolved: id !== 100 })),
    );
    const events: ScmEmission[] = [];
    subscriptions.push(
      createGitHubScm({ token: 'test', fetch: fake.fetch }).watch(project, number, (e) =>
        events.push(e),
      ),
    );
    await flush();
    expect(events[0]?.payload).toMatchObject({
      pr: {
        checks: { total: 202, failed: 1, failingNames: ['status-100'] },
        review: { decision: 'changes_requested', unresolvedThreads: 1 },
      },
    });
    events.length = 0;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events).toHaveLength(0);
    expect(fake.requests.filter((r) => r.status === 304 && r.path.includes('page=2'))).toHaveLength(
      3,
    );
  });

  test('head moved merge throws MERGE_BLOCKED with the server reason', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    fake.setPr(1, { head: { sha: 'moved', ref: 'feature' } });
    await expect(
      createGitHubScm({ token: 'test', fetch: fake.fetch }).merge({
        project,
        prNumber: number,
        expectedHeadSha: 'old',
        method: 'merge',
      }),
    ).rejects.toMatchObject({
      code: 'MERGE_BLOCKED',
      message: 'GitHub: Head branch was modified. Review and try the merge again.',
    });
  });
  test('405 merge failures retain the GitHub reason', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    fake.blockMerge(1, 'Required status check is expected.');
    await expect(
      createGitHubScm({ token: 'test', fetch: fake.fetch }).merge({
        project,
        prNumber: number,
        expectedHeadSha: 'head-1',
        method: 'rebase',
      }),
    ).rejects.toMatchObject({
      code: 'MERGE_BLOCKED',
      message: 'GitHub: Required status check is expected.',
    });
  });

  test('subscriber mutation or exceptions cannot corrupt other subscribers', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    const onError = vi.fn();
    const scm = createGitHubScm({ token: 'test', fetch: fake.fetch, onError });
    subscriptions.push(
      scm.watch(project, number, (e) => {
        if (e.type === 'pr.updated') e.payload.pr.headSha = 'corrupt';
        throw new Error('consumer failed');
      }),
    );
    const events: ScmEmission[] = [];
    subscriptions.push(scm.watch(project, number, (e) => events.push(e)));
    await flush();
    expect(events[0]?.payload).toMatchObject({ pr: { headSha: 'head-1' } });
    expect(onError).toHaveBeenCalled();
    events.length = 0;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events).toEqual([]);
  });

  test('unsubscribing aborts pending I/O and prevents late emissions', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    let release!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = (input, init) => {
      signal = init?.signal;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };
    const events = vi.fn();
    const stop = createGitHubScm({ token: 'test', fetch: fetcher }).watch(project, number, events);
    subscriptions.push(stop);
    await flush();
    stop();
    expect(signal?.aborted).toBe(true);
    release(new Response(JSON.stringify(fake.getPr(1))));
    await flush();
    expect(events).not.toHaveBeenCalled();
  });

  test('reports auth failure without exposing credentials', async () => {
    const onError = vi.fn();
    const fetcher: typeof fetch = () =>
      Promise.resolve(new Response('{"message":"bad token secret"}', { status: 401 }));
    subscriptions.push(
      createGitHubScm({ token: 'secret', fetch: fetcher, onError }).watch(project, number),
    );
    await flush();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(onError.mock.calls[0]?.[0]).toHaveProperty(
      'message',
      expect.stringContaining('gh auth login'),
    );
    expect(JSON.stringify(onError.mock.calls)).not.toContain('secret');
  });

  test('GraphQL errors do not publish false review readiness', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    const events = vi.fn();
    const onError = vi.fn();
    const fetcher: typeof fetch = (input, init) =>
      requestUrl(input).endsWith('/graphql')
        ? Promise.resolve(
            new Response(JSON.stringify({ errors: [{ type: 'FORBIDDEN', message: 'no access' }] })),
          )
        : fake.fetch(input, init);
    subscriptions.push(
      createGitHubScm({ token: 'test', fetch: fetcher, onError }).watch(project, number, events),
    );
    await flush();
    expect(events).not.toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'FORBIDDEN' });
  });

  test('a pre-merge poll cannot overwrite a successful local merge', async () => {
    const fake = createFakeGitHub();
    fake.seedPr();
    let hold = false;
    let release!: () => void;
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      if (hold && requestUrl(input).endsWith('/pulls/1')) {
        hold = false;
        return new Promise<Response>((resolve) => {
          release = () => resolve(response);
        });
      }
      return response;
    };
    const scm = createGitHubScm({ token: 'test', fetch: fetcher });
    const events: ScmEmission[] = [];
    subscriptions.push(scm.watch(project, number, (e) => events.push(e)));
    await flush();
    hold = true;
    await vi.advanceTimersByTimeAsync(15_000);
    events.length = 0;
    await scm.merge({ project, prNumber: number, expectedHeadSha: 'head-1', method: 'squash' });
    release();
    await flush();
    expect(events.map((e) => e.type)).toEqual(['pr.merged']);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events.filter((e) => e.type === 'pr.updated').at(-1)?.payload).toMatchObject({
      pr: { state: 'merged' },
    });
    expect(events.filter((e) => e.type === 'pr.merged')).toHaveLength(1);
  });

  test('validates project mapping and poll interval', () => {
    expect(() => createGitHubScm({ pollMs: 0 })).toThrow(HelixError);
    const local = { ...project };
    delete local.github;
    expect(() => createGitHubScm({ token: 'test' }).watch(local, number)).toThrow(HelixError);
  });

  test('feedback has check names, first excerpt, unresolved comment details, and a hard length cap', async () => {
    const fake = createFakeGitHub();
    const scm = createGitHubScm({ token: 'test', fetch: fake.fetch });
    const pr = await scm.openPr(openOptions);
    pr.checks = { total: 1, passed: 0, failed: 1, pending: 0, failingNames: ['unit'] };
    pr.review = { decision: 'changes_requested', unresolvedThreads: 1 };
    const text = buildFeedbackMessage({
      reason: 'ci_failed',
      pr,
      details: `Assertion failed\r\nAda, src/a.ts:4: Handle errors ${'x'.repeat(5000)} LOG_TAIL`,
    });
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text).toContain('unit');
    expect(text).toContain('Assertion failed');
    expect(text).toContain('Ada, src/a.ts:4: Handle errors');
    expect(text).toContain('Unresolved review threads: 1');
    expect(text).not.toContain('LOG_TAIL');
    expect(text).not.toContain('\n');
    pr.checks.failingNames = Array.from({ length: 200 }, () => 'x'.repeat(100));
    expect(
      buildFeedbackMessage({ reason: 'changes_requested', pr, details: 'x'.repeat(5000) }).length,
    ).toBeLessThanOrEqual(1500);
    expect(buildFeedbackMessage({ reason: 'merge_conflict', pr })).toContain(
      'Resolve the merge conflicts',
    );
  });
});
