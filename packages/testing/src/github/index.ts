import { createHash } from 'node:crypto';

export interface FakeCheck {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
}
export interface FakeStatus {
  id: number;
  context: string;
  state: string;
  created_at?: string;
}
export interface FakeReview {
  id: number;
  user: { login: string } | null;
  state: string;
  submitted_at?: string | null;
}
export interface FakeThread {
  isResolved: boolean;
  comments?: { author: string; path: string; line: number | null; body: string }[];
}
export interface FakePull {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  mergeable: boolean | null;
  head: { sha: string; ref: string };
  updated_at: string;
  requested_reviewers: { login: string }[];
  requested_teams: { slug: string }[];
}
export interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
  ifNoneMatch: string | null;
  status: number;
}
export interface FakeRateLimit {
  path?: string;
  status?: 403 | 429;
  headers?: Record<string, string>;
}
interface PullState {
  pull: FakePull;
  checks: Map<string, FakeCheck[]>;
  statuses: Map<string, FakeStatus[]>;
  reviews: FakeReview[];
  threads: FakeThread[];
  decision: string | null;
  scripts: Map<string, FakeCheck[][]>;
  mergeBlock?: { status: 405 | 409; message: string };
}

/** No sockets, auth, timers, or network. Implements the REST/GraphQL wire
 * endpoints used by SCM, including pagination, conditional reads and merge guards.
 * A scripted check snapshot is consumed per page-one check request, then held.
 */
export function createFakeGitHub(options: { owner?: string; repo?: string } = {}) {
  const owner = options.owner ?? 'acme';
  const repo = options.repo ?? 'demo';
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const pulls = new Map<number, PullState>();
  const requests: FakeRequest[] = [];
  const limits: FakeRateLimit[] = [];
  let sequence = 0;
  const timestamp = () => new Date(Date.UTC(2026, 0, 1) + sequence++ * 1000).toISOString();
  const state = (number: number) => {
    const value = pulls.get(number);
    if (!value) throw new Error(`Unknown fake PR #${number}`);
    return value;
  };
  function seedPr(patch: Partial<FakePull> = {}): FakePull {
    const number = patch.number ?? Math.max(0, ...pulls.keys()) + 1;
    const pull: FakePull = {
      number,
      html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
      state: 'open',
      draft: false,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      mergeable: true,
      head: { sha: `head-${number}`, ref: `feature-${number}` },
      updated_at: timestamp(),
      requested_reviewers: [],
      requested_teams: [],
      ...structuredClone(patch),
    };
    pulls.set(number, {
      pull,
      checks: new Map(),
      statuses: new Map(),
      reviews: [],
      threads: [],
      decision: null,
      scripts: new Map(),
    });
    return structuredClone(pull);
  }
  function setPr(number: number, patch: Partial<FakePull>) {
    Object.assign(state(number).pull, { updated_at: timestamp() }, structuredClone(patch));
  }
  function setChecks(
    number: number,
    checks: FakeCheck[],
    statuses: FakeStatus[] = [],
    sha = state(number).pull.head.sha,
  ) {
    state(number).checks.set(sha, structuredClone(checks));
    state(number).statuses.set(sha, structuredClone(statuses));
    state(number).scripts.delete(sha);
  }
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    if (url.origin !== 'https://api.github.com')
      throw new Error('Fake GitHub refuses external network requests.');
    const body: unknown = request.method === 'GET' ? null : await request.json();
    const record: FakeRequest = {
      method: request.method,
      path: url.pathname + url.search,
      body,
      ifNoneMatch: request.headers.get('if-none-match'),
      status: 0,
    };
    requests.push(record);
    const respond = (data: unknown, status = 200, extra: Record<string, string> = {}) => {
      const json = JSON.stringify(data);
      const headers = new Headers({ 'Content-Type': 'application/json', ...extra });
      if (request.method === 'GET' && status === 200) {
        const etag = `"${createHash('sha256').update(json).digest('hex')}"`;
        headers.set('ETag', etag);
        if (record.ifNoneMatch === etag) status = 304;
      }
      record.status = status;
      return new Response(status === 304 ? null : json, { status, headers });
    };
    const rateIndex = limits.findIndex((limit) => !limit.path || record.path.includes(limit.path));
    if (rateIndex !== -1) {
      const limit = limits.splice(rateIndex, 1)[0]!;
      return respond(
        { message: 'API rate limit exceeded' },
        limit.status ?? 429,
        limit.headers ?? { 'Retry-After': '60' },
      );
    }
    if (url.pathname === '/graphql' && request.method === 'POST') {
      const { variables } = body as {
        variables: { owner: string; repo: string; number: number; cursor: string | null };
      };
      const entry = pulls.get(variables.number);
      if (!entry || variables.owner !== owner || variables.repo !== repo)
        return respond({ data: { repository: { pullRequest: null } } });
      const start = Number(variables.cursor ?? 0);
      const nodes = entry.threads.slice(start, start + 100);
      const hasNextPage = start + 100 < entry.threads.length;
      return respond({
        data: {
          repository: {
            pullRequest: {
              reviewDecision: entry.decision,
              reviewThreads: {
                nodes,
                pageInfo: { hasNextPage, endCursor: hasNextPage ? String(start + 100) : null },
              },
            },
          },
        },
      });
    }
    if (!url.pathname.startsWith(`${prefix}/`)) return respond({ message: 'Not Found' }, 404);
    const path = url.pathname.slice(prefix.length);
    if (path === '/pulls' && request.method === 'POST') {
      const options = body as { head: string; draft: boolean };
      const pull = seedPr({ draft: options.draft });
      setPr(pull.number, { head: { sha: pull.head.sha, ref: options.head } });
      return respond(state(pull.number).pull, 201);
    }
    const paginate = (rows: unknown[], field?: string) => {
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
      const size = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 30)));
      const slice = rows.slice((page - 1) * size, page * size);
      const headers: Record<string, string> = {};
      if (page * size < rows.length) {
        const next = new URL(url);
        next.searchParams.set('page', String(page + 1));
        headers.Link = `<${next.href}>; rel="next"`;
      }
      return respond(field ? { total_count: rows.length, [field]: slice } : slice, 200, headers);
    };
    const pullMatch = path.match(/^\/pulls\/(\d+)(?:\/(reviews|merge))?$/);
    if (pullMatch) {
      const entry = pulls.get(Number(pullMatch[1]));
      if (!entry) return respond({ message: 'Not Found' }, 404);
      if (!pullMatch[2] && request.method === 'GET') return respond(entry.pull);
      if (pullMatch[2] === 'reviews' && request.method === 'GET') return paginate(entry.reviews);
      if (pullMatch[2] === 'merge' && request.method === 'PUT') {
        const { sha } = body as { sha: string };
        if (sha !== entry.pull.head.sha)
          return respond(
            { message: 'Head branch was modified. Review and try the merge again.' },
            409,
          );
        if (entry.mergeBlock)
          return respond({ message: entry.mergeBlock.message }, entry.mergeBlock.status);
        if (entry.pull.draft || entry.pull.mergeable === false || entry.pull.state !== 'open')
          return respond({ message: 'Pull request is not mergeable' }, 405);
        const mergeSha = `merge-${sha}`;
        setPr(entry.pull.number, {
          merged: true,
          state: 'closed',
          merged_at: timestamp(),
          merge_commit_sha: mergeSha,
        });
        return respond({
          merged: true,
          sha: mergeSha,
          message: 'Pull Request successfully merged',
        });
      }
    }
    const commitMatch = path.match(/^\/commits\/([^/]+)\/(check-runs|statuses)$/);
    if (commitMatch && request.method === 'GET') {
      const sha = decodeURIComponent(commitMatch[1]!);
      const entry = [...pulls.values()].find(
        (entry) => entry.pull.head.sha === sha || entry.checks.has(sha) || entry.statuses.has(sha),
      );
      if (!entry) return respond({ message: 'Commit not found' }, 404);
      if (commitMatch[2] === 'check-runs') {
        const script = entry.scripts.get(sha);
        if (
          script?.length &&
          (!url.searchParams.has('page') || url.searchParams.get('page') === '1')
        )
          entry.checks.set(sha, script.shift()!);
        return paginate(entry.checks.get(sha) ?? [], 'check_runs');
      }
      return paginate(entry.statuses.get(sha) ?? []);
    }
    return respond({ message: 'Endpoint not implemented by fake GitHub' }, 404);
  };
  return {
    fetch: fetcher,
    requests,
    owner,
    repo,
    seedPr,
    setPr,
    setChecks,
    getPr: (number: number) => structuredClone(state(number).pull),
    setReviews(number: number, reviews: FakeReview[], decision: string | null = null) {
      state(number).reviews = structuredClone(reviews);
      state(number).decision = decision;
    },
    setThreads(number: number, threads: FakeThread[]) {
      state(number).threads = structuredClone(threads);
    },
    scriptChecks(number: number, snapshots: FakeCheck[][], sha = state(number).pull.head.sha) {
      state(number).scripts.set(sha, structuredClone(snapshots));
    },
    rateLimitNext(limit: FakeRateLimit = {}) {
      limits.push(structuredClone(limit));
    },
    blockMerge(number: number, message: string, status: 405 | 409 = 405) {
      state(number).mergeBlock = { message, status };
    },
  };
}
export type FakeGitHub = ReturnType<typeof createFakeGitHub>;
