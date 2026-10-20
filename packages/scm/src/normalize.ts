import type { CheckSummary, PullRequestFacts, ReviewSummary } from '@helix/contracts';

/** Minimal GitHub wire records; these are not cross-package domain contracts. */
export interface GitHubCheck {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}
export interface GitHubStatus {
  id: number;
  context: string;
  state: string;
  created_at?: string;
}
export interface GitHubReview {
  id: number;
  user: { login: string } | null;
  state: string;
  submitted_at?: string | null;
}

/** Latest attempt per name wins (start/creation time, then numeric id); neutral
 * and skipped pass, terminal failures fail, and unfinished/unknown states pend.
 * Commit status `error` and check `stale` are also failures. Counts partition total.
 */
export function normalizeChecks(
  checks: GitHubCheck[],
  statuses: GitHubStatus[] = [],
): CheckSummary {
  const latest = new Map<string, { id: number; time: string; state: string }>();
  const candidates = [
    ...checks.map((c) => ({
      name: c.name,
      id: c.id,
      time: c.started_at ?? '',
      state: c.status === 'completed' ? (c.conclusion ?? 'pending') : c.status,
    })),
    ...statuses.map((s) => ({
      name: s.context,
      id: s.id,
      time: s.created_at ?? '',
      state: s.state,
    })),
  ];
  for (const c of candidates) {
    const old = latest.get(c.name);
    if (!old || (c.time && old.time && c.time !== old.time ? c.time > old.time : c.id > old.id))
      latest.set(c.name, c);
  }
  const result: CheckSummary = {
    total: latest.size,
    passed: 0,
    failed: 0,
    pending: 0,
    failingNames: [],
  };
  for (const [name, { state }] of latest) {
    if (['success', 'neutral', 'skipped'].includes(state)) result.passed++;
    else if (
      [
        'failure',
        'timed_out',
        'cancelled',
        'action_required',
        'startup_failure',
        'error',
        'stale',
      ].includes(state)
    ) {
      result.failed++;
      result.failingNames.push(name);
    } else result.pending++;
  }
  result.failingNames.sort();
  return result;
}

/** Latest submitted review per reviewer wins; pending drafts are not submitted
 * reviews. Changes requested wins over approval; outstanding required reviews
 * prevent approval. GraphQL reviewDecision accounts for branch protection rules.
 */
export function normalizeReviews(
  reviews: GitHubReview[],
  unresolvedThreads = 0,
  requiredPending = false,
  reviewDecision?: string | null,
): ReviewSummary {
  const latest = new Map<string, GitHubReview>();
  for (const review of reviews) {
    if (!review.user || review.state === 'PENDING') continue;
    const old = latest.get(review.user.login.toLowerCase());
    if (
      !old ||
      (review.submitted_at ?? '') > (old.submitted_at ?? '') ||
      ((review.submitted_at ?? '') === (old.submitted_at ?? '') && review.id > old.id)
    ) {
      latest.set(review.user.login.toLowerCase(), review);
    }
  }
  const states = [...latest.values()].map((r) => r.state);
  const decision =
    states.includes('CHANGES_REQUESTED') || reviewDecision === 'CHANGES_REQUESTED'
      ? 'changes_requested'
      : requiredPending || reviewDecision === 'REVIEW_REQUIRED'
        ? 'review_required'
        : states.includes('APPROVED') || reviewDecision === 'APPROVED'
          ? 'approved'
          : 'none';
  return { decision, unresolvedThreads };
}

/** GitHub true/false/null become mergeable/conflicting/unknown respectively. */
export function normalizeMergeable(value: boolean | null): PullRequestFacts['mergeable'] {
  return value === true ? 'mergeable' : value === false ? 'conflicting' : 'unknown';
}
