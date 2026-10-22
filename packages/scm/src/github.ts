import {
  HelixError,
  isHelixError,
  pullRequestFactsSchema,
  type Project,
  type PullRequestFacts,
  type PullRequestNumber,
  type ScmEmission,
  type ScmObserver,
} from '@helix/contracts';
import { resolveGitHubToken } from './auth.js';
import {
  normalizeChecks,
  normalizeMergeable,
  normalizeReviews,
  type GitHubCheck,
  type GitHubReview,
  type GitHubStatus,
} from './normalize.js';

export interface GitHubScmOptions {
  token?: string;
  fetch?: typeof globalThis.fetch;
  pollMs?: number;
  /** CONTRACT-REQUEST: ScmObserver.watch has no asynchronous error channel. */
  onError?: (error: HelixError) => void;
}
interface Pull {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  mergeable: boolean | null;
  head: { sha: string };
  updated_at: string;
  requested_reviewers?: unknown[];
  requested_teams?: unknown[];
}
interface ThreadPage {
  errors?: { type?: string; message: string }[];
  data?: {
    repository: {
      pullRequest: {
        reviewDecision: string | null;
        reviewThreads: {
          nodes: { isResolved: boolean }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    } | null;
  };
}
interface Cached {
  etag?: string;
  body: unknown;
  next?: string;
}
interface Subscriber {
  cb?: (event: ScmEmission) => void;
  previous?: PullRequestFacts;
  mergedSha?: string;
}
interface Watcher {
  project: Project;
  number: PullRequestNumber;
  subscribers: Set<Subscriber>;
  cache: Map<string, Cached>;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  facts?: PullRequestFacts;
  mergeSha?: string;
  generation: number;
}
class RateLimited extends HelixError {
  constructor(readonly retryAt: number) {
    super(
      'FORBIDDEN',
      'GitHub rate limit reached; polling will retry after the server-requested delay.',
      { retryAt },
    );
  }
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const api = 'https://api.github.com';
const threadQuery = `query HelixReviewThreads($owner:String!,$repo:String!,$number:Int!,$cursor:String) {
  repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
    reviewDecision
    reviewThreads(first:100,after:$cursor) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
  } }
}`;

function repository(project: Project) {
  if (!project.github)
    throw new HelixError('INVALID_REQUEST', 'Project has no GitHub owner/repository configured.');
  return project.github;
}
function repoPath(project: Project) {
  const { owner, repo } = repository(project);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
function watcherKey(project: Project, number: PullRequestNumber) {
  return `${repoPath(project).toLowerCase()}/pulls/${number}`;
}
function retryTime(headers: Headers): number {
  const now = Date.now();
  const retry = headers.get('retry-after');
  const reset = headers.get('x-ratelimit-reset');
  const seconds = retry === null ? NaN : Number(retry);
  const after =
    retry === null ? NaN : Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retry);
  const resetAt = reset === null ? NaN : Number(reset) * 1000;
  const times = [after, resetAt].filter((n) => Number.isFinite(n) && n > now);
  return times.length ? Math.max(...times) : now + 60_000;
}

/** REST conditional reads plus paginated GraphQL review threads. One shared,
 * nonoverlapping poll loop per repository/PR; each subscriber gets its own baseline.
 */
export function createGitHubScm(options: GitHubScmOptions = {}): ScmObserver {
  const fetcher = options.fetch ?? globalThis.fetch;
  const pollMs = options.pollMs ?? 15_000;
  if (!Number.isFinite(pollMs) || pollMs <= 0)
    throw new HelixError('INVALID_REQUEST', 'pollMs must be a positive finite number.');
  const watchers = new Map<string, Watcher>();
  let tokenPromise: Promise<string> | undefined;
  let cooldown = 0;
  const token = () =>
    (tokenPromise ??= resolveGitHubToken(options.token).catch((error: unknown) => {
      tokenPromise = undefined;
      throw error;
    }));
  const report = (error: unknown) => {
    const domainError = isHelixError(error)
      ? error
      : new HelixError('INTERNAL_ERROR', 'GitHub observation failed.');
    try {
      options.onError?.(domainError);
    } catch {
      /* Error handlers must not break polling. */
    }
  };

  async function request<T>(
    path: string,
    init: RequestInit = {},
    cache?: Map<string, Cached>,
  ): Promise<{ body: T; next?: string }> {
    if (Date.now() < cooldown) throw new RateLimited(cooldown);
    const credential = await token();
    init.signal?.throwIfAborted();
    const cached = cache?.get(path);
    const headers = new Headers({
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${credential}`,
      'X-GitHub-Api-Version': '2022-11-28',
    });
    if (init.body) headers.set('Content-Type', 'application/json');
    if (cached?.etag) headers.set('If-None-Match', cached.etag);
    let response: Response;
    try {
      response = await fetcher(`${api}${path}`, {
        ...init,
        headers,
        redirect: 'error',
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch {
      throw new HelixError('INTERNAL_ERROR', 'GitHub request failed or timed out.');
    }
    if (response.status === 304 && cached) return cached as { body: T; next?: string };
    if (response.status === 403 || response.status === 429) {
      cooldown = retryTime(response.headers);
      throw new RateLimited(cooldown);
    }
    if (response.status === 401) {
      tokenPromise = undefined;
      throw new HelixError(
        'UNAUTHORIZED',
        'GitHub rejected the credentials; update GH_TOKEN/GITHUB_TOKEN or run `gh auth login`.',
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const reason =
        body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
          ? body.message.replaceAll(credential, '[redacted]').slice(0, 1000)
          : `HTTP ${response.status}`;
      const mergeBlocked = path.endsWith('/merge') && [405, 409].includes(response.status);
      throw new HelixError(
        mergeBlocked
          ? 'MERGE_BLOCKED'
          : response.status === 404
            ? 'NOT_FOUND'
            : response.status === 409
              ? 'CONFLICT'
              : response.status === 422 || response.status === 400
                ? 'INVALID_REQUEST'
                : 'INTERNAL_ERROR',
        `GitHub: ${reason}`,
      );
    }
    const nextUrl = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    let next: string | undefined;
    if (nextUrl) {
      const url = new URL(nextUrl, api);
      if (url.origin !== api)
        throw new HelixError('INTERNAL_ERROR', 'GitHub returned an unexpected pagination origin.');
      next = url.pathname + url.search;
    }
    const entry: Cached = {
      body,
      ...(next ? { next } : {}),
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
    };
    cache?.set(path, entry);
    return entry as { body: T; next?: string };
  }

  async function pages<T>(
    path: string,
    cache: Map<string, Cached>,
    signal: AbortSignal,
    field?: string,
  ): Promise<T[]> {
    const rows: T[] = [];
    const seen = new Set<string>();
    let next: string | undefined = path;
    while (next) {
      if (seen.has(next))
        throw new HelixError('INTERNAL_ERROR', 'GitHub pagination repeated a page.');
      seen.add(next);
      const page: { body: T[] | Record<string, T[]>; next?: string } = await request(
        next,
        { signal },
        cache,
      );
      const values = field ? (page.body as Record<string, T[]>)[field] : page.body;
      if (!Array.isArray(values))
        throw new HelixError('INTERNAL_ERROR', 'GitHub returned invalid list data.');
      rows.push(...values);
      next = page.next;
    }
    return rows;
  }

  async function readFacts(
    project: Project,
    number: PullRequestNumber,
    cache: Map<string, Cached>,
    signal: AbortSignal,
    initial?: Pull,
  ) {
    const root = repoPath(project);
    const pull =
      initial ?? (await request<Pull>(`${root}/pulls/${number}`, { signal }, cache)).body;
    const shaPath = `${root}/commits/${encodeURIComponent(pull.head.sha)}`;
    // Release obsolete head caches while keeping current-head pagination and PR/review ETags.
    for (const key of cache.keys())
      if (key.startsWith(`${root}/commits/`) && !key.startsWith(`${shaPath}/`)) cache.delete(key);
    const checks = await pages<GitHubCheck>(
      `${shaPath}/check-runs?per_page=100&filter=all`,
      cache,
      signal,
      'check_runs',
    );
    const statuses = await pages<GitHubStatus>(`${shaPath}/statuses?per_page=100`, cache, signal);
    const reviews = await pages<GitHubReview>(
      `${root}/pulls/${number}/reviews?per_page=100`,
      cache,
      signal,
    );
    let unresolved = 0;
    let cursor: string | null = null;
    let decision: string | null = null;
    const cursors = new Set<string>();
    do {
      const page: ThreadPage = (
        await request<ThreadPage>('/graphql', {
          method: 'POST',
          signal,
          body: JSON.stringify({
            query: threadQuery,
            variables: { ...repository(project), number, cursor },
          }),
        })
      ).body;
      if (page.errors?.length) {
        if (page.errors.some((e) => e.type === 'RATE_LIMITED')) {
          cooldown = Date.now() + 60_000;
          throw new RateLimited(cooldown);
        }
        throw new HelixError(
          page.errors.some((e) => e.type === 'FORBIDDEN') ? 'FORBIDDEN' : 'INTERNAL_ERROR',
          'GitHub could not read review threads; check repository permissions.',
        );
      }
      const pr = page.data?.repository?.pullRequest;
      if (!pr)
        throw new HelixError(
          'NOT_FOUND',
          'GitHub pull request was not found while reading review threads.',
        );
      decision = pr.reviewDecision;
      unresolved += pr.reviewThreads.nodes.filter((t) => !t.isResolved).length;
      cursor = pr.reviewThreads.pageInfo.hasNextPage ? pr.reviewThreads.pageInfo.endCursor : null;
      if (pr.reviewThreads.pageInfo.hasNextPage && (!cursor || cursors.has(cursor)))
        throw new HelixError('INTERNAL_ERROR', 'GitHub review-thread pagination did not advance.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const parsed = pullRequestFactsSchema.safeParse({
      number: pull.number,
      url: pull.html_url,
      state: pull.merged || pull.merged_at ? 'merged' : pull.state,
      draft: pull.draft,
      headSha: pull.head.sha,
      mergeable: normalizeMergeable(pull.mergeable),
      checks: normalizeChecks(checks, statuses),
      review: normalizeReviews(
        reviews,
        unresolved,
        Boolean(pull.requested_reviewers?.length || pull.requested_teams?.length),
        decision,
      ),
      updatedAt: pull.updated_at,
    });
    if (!parsed.success)
      throw new HelixError('INTERNAL_ERROR', 'GitHub returned invalid pull request facts.');
    return { facts: parsed.data, mergeSha: pull.merge_commit_sha };
  }

  function deliver(subscriber: Subscriber, event: ScmEmission) {
    try {
      subscriber.cb?.(structuredClone(event));
    } catch (error) {
      report(error);
    }
  }
  function publish(watcher: Watcher, subscriber: Subscriber) {
    const facts = watcher.facts;
    if (!facts) return;
    const previous = subscriber.previous;
    subscriber.previous = structuredClone(facts);
    if (!equal(previous, facts))
      deliver(subscriber, { type: 'pr.updated', payload: { pr: facts } });
    if (!watcher.subscribers.has(subscriber)) return;
    if (!equal(previous?.checks, facts.checks) || previous?.headSha !== facts.headSha)
      deliver(subscriber, {
        type: 'ci.updated',
        payload: { prNumber: facts.number, checks: facts.checks },
      });
    if (!watcher.subscribers.has(subscriber)) return;
    if (!equal(previous?.review, facts.review) || previous?.headSha !== facts.headSha)
      deliver(subscriber, {
        type: 'review.updated',
        payload: { prNumber: facts.number, review: facts.review },
      });
    if (watcher.subscribers.has(subscriber) && facts.state === 'merged' && watcher.mergeSha)
      publishMerge(watcher, subscriber, watcher.mergeSha);
  }
  function publishMerge(watcher: Watcher, subscriber: Subscriber, mergeSha: string) {
    if (subscriber.mergedSha === mergeSha) return;
    subscriber.mergedSha = mergeSha;
    deliver(subscriber, { type: 'pr.merged', payload: { prNumber: watcher.number, mergeSha } });
  }
  async function poll(watcher: Watcher) {
    if (watcher.controller.signal.aborted) return;
    let delay = pollMs;
    const generation = watcher.generation;
    try {
      const result = await readFacts(
        watcher.project,
        watcher.number,
        watcher.cache,
        watcher.controller.signal,
      );
      if (watcher.controller.signal.aborted || generation !== watcher.generation) return;
      watcher.facts = result.facts;
      if (result.facts.state === 'merged' && result.mergeSha) watcher.mergeSha = result.mergeSha;
      delay = result.facts.checks.pending ? Math.min(pollMs, 5000) : pollMs;
      for (const subscriber of watcher.subscribers) publish(watcher, subscriber);
    } catch (error) {
      if (!watcher.controller.signal.aborted) report(error);
      delay =
        error instanceof RateLimited
          ? Math.max(pollMs, error.retryAt - Date.now())
          : Math.max(pollMs, 15_000);
    } finally {
      if (!watcher.controller.signal.aborted) {
        watcher.timer = setTimeout(
          () => {
            void poll(watcher);
          },
          Math.min(Math.max(delay, cooldown - Date.now()), 2_147_483_647),
        );
        watcher.timer.unref();
      }
    }
  }

  return {
    watch(project, number, cb) {
      const key = watcherKey(project, number);
      let watcher = watchers.get(key);
      if (!watcher) {
        watcher = {
          project: structuredClone(project),
          number,
          subscribers: new Set(),
          cache: new Map(),
          controller: new AbortController(),
          generation: 0,
        };
        watchers.set(key, watcher);
        const created = watcher;
        queueMicrotask(() => {
          void poll(created);
        });
      }
      const active = watcher;
      const subscriber: Subscriber = cb ? { cb } : {};
      active.subscribers.add(subscriber);
      if (active.facts)
        queueMicrotask(() => {
          if (active.subscribers.has(subscriber)) publish(active, subscriber);
        });
      return () => {
        active.subscribers.delete(subscriber);
        if (!active.subscribers.size) {
          clearTimeout(active.timer);
          active.controller.abort();
          active.cache.clear();
          if (watchers.get(key) === active) watchers.delete(key);
        }
      };
    },
    async openPr({ project, head, base, title, body, draft }) {
      const pull = (
        await request<Pull>(`${repoPath(project)}/pulls`, {
          method: 'POST',
          body: JSON.stringify({ head, base, title, body, draft }),
        })
      ).body;
      // Creation response has no CI/review summaries. Hydrate the exact contract facts.
      const number = pullRequestFactsSchema.shape.number.parse(pull.number);
      return (await readFacts(project, number, new Map(), new AbortController().signal, pull))
        .facts;
    },
    async merge({ project, prNumber, expectedHeadSha, method }) {
      const result = (
        await request<{ merged: boolean; sha: string; message?: string }>(
          `${repoPath(project)}/pulls/${prNumber}/merge`,
          { method: 'PUT', body: JSON.stringify({ sha: expectedHeadSha, merge_method: method }) },
        )
      ).body;
      if (!result.merged || !result.sha)
        throw new HelixError('MERGE_BLOCKED', 'GitHub did not merge the pull request.');
      const watcher = watchers.get(watcherKey(project, prNumber));
      if (watcher) {
        watcher.generation++;
        watcher.mergeSha = result.sha;
        if (watcher.facts) watcher.facts = { ...watcher.facts, state: 'merged' };
        watcher.cache.clear();
        for (const subscriber of watcher.subscribers) publishMerge(watcher, subscriber, result.sha);
      }
      return { mergeSha: result.sha };
    },
  };
}
