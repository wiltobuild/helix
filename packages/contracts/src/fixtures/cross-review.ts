import {
  agentReviewSchema,
  projectSchema,
  pullRequestFactsSchema,
  sessionSchema,
  type CheckSummary,
} from '../entities.js';
import { helixEventSchema, type EventType, type HelixEvent, type PayloadFor } from '../events.js';
import { sessionIdSchema, type SessionId } from '../ids.js';

/**
 * A Codex worker's PR reviewed by Claude Code: CI passes, the reviewer requests changes, the
 * findings go back to the worker, the fix passes CI, and the re-review approves. The worker ends
 * ready to merge. Reviewers are always the other agent kind.
 */
const time = (minute: number) => `2026-10-02T10:${String(minute).padStart(2, '0')}:00.000Z`;
export const crossReviewProject = projectSchema.parse({
  id: 'proj_demo_checkout',
  name: 'Checkout library',
  repoPath: '/demo/checkout',
  defaultBranch: 'main',
  github: { owner: 'acme-demo', repo: 'checkout' },
  defaultAgent: 'codex',
  createdAt: time(0),
});
export const crossReviewIds = {
  worker: sessionIdSchema.parse('sess_review_worker'),
  reviewer: sessionIdSchema.parse('sess_review_reviewer'),
};
const ids = crossReviewIds;
const firstSha = '3c1f0e9a7b6d5c4b3a291807f6e5d4c3b2a19080';
const fixSha = '4d2a1f0b8c7e6d5c4b3a2918070f6e5d4c3b2a19';
const passing: CheckSummary = { total: 1, passed: 1, failed: 0, pending: 0, failingNames: [] };
const pending: CheckSummary = { total: 1, passed: 0, failed: 0, pending: 1, failingNames: [] };
const pr = pullRequestFactsSchema.parse({
  number: 7,
  url: 'https://github.com/acme-demo/checkout/pull/7',
  state: 'open',
  draft: false,
  headSha: firstSha,
  mergeable: 'mergeable',
  checks: pending,
  review: { decision: 'none', unresolvedThreads: 0 },
  updatedAt: time(6),
});
export const crossReviewFindings = agentReviewSchema.parse({
  verdict: 'request_changes',
  summary: 'Rounding is right, but an unknown code is silently ignored instead of rejected.',
  findings: [
    {
      severity: 'major',
      title: 'Unknown discount codes are accepted',
      detail:
        'totals(cart, "SAVE99") returns undiscounted totals. The task says unknown codes throw.',
      file: 'src/cart.ts',
      line: 41,
    },
    {
      severity: 'nit',
      title: 'Test name says SAVE15',
      detail: 'The case exercises SAVE10.',
      file: 'src/cart.test.ts',
      line: 58,
    },
  ],
});

const run: HelixEvent[] = [];
function add<T extends EventType>(
  type: T,
  payload: PayloadFor<T>,
  minute: number,
  causedBy?: number,
  sessionId?: SessionId,
): number {
  run.push(
    helixEventSchema.parse({
      seq: run.length + 1,
      ts: time(minute),
      projectId: crossReviewProject.id,
      type,
      payload,
      v: 1,
      ...(causedBy === undefined ? {} : { causedBy }),
      ...(sessionId ? { sessionId } : {}),
    }),
  );
  return run.length;
}
add('project.added', { project: crossReviewProject }, 0);
const created = add(
  'session.created',
  {
    session: sessionSchema.parse({
      id: ids.worker,
      projectId: crossReviewProject.id,
      role: 'worker',
      agent: 'codex',
      title: 'Add discount codes',
      prompt: 'SAVE10 takes 10% off; unknown codes throw.',
      interface: 'chat',
      createdAt: time(1),
    }),
  },
  1,
  1,
  ids.worker,
);
add(
  'worktree.created',
  { branch: 'helix/add-discount-codes', path: '/demo/worktrees/review-worker', baseSha: 'b4se' },
  1,
  created,
  ids.worker,
);
add('session.started', {}, 1, created, ids.worker);
add('activity.changed', { activity: 'active' }, 2, created, ids.worker);
const opened = add('pr.opened', { pr }, 6, undefined, ids.worker);
add('activity.changed', { activity: 'idle' }, 6, opened, ids.worker);
const green = add('ci.updated', { prNumber: pr.number, checks: passing }, 8, opened, ids.worker);
const reviewer = add(
  'session.created',
  {
    session: sessionSchema.parse({
      id: ids.reviewer,
      projectId: crossReviewProject.id,
      role: 'reviewer',
      agent: 'claude-code',
      title: 'Review: Add discount codes',
      prompt: 'Review PR #7 against its task.',
      interface: 'chat',
      createdAt: time(8),
      parentSessionId: ids.worker,
    }),
  },
  8,
  green,
  ids.reviewer,
);
add('session.started', {}, 8, reviewer, ids.reviewer);
const requested = add(
  'agent_review.requested',
  { workerSessionId: ids.worker, prNumber: pr.number, headSha: firstSha },
  8,
  green,
  ids.reviewer,
);
add('activity.changed', { activity: 'active' }, 9, requested, ids.reviewer);
const changes = add(
  'agent_review.submitted',
  {
    workerSessionId: ids.worker,
    prNumber: pr.number,
    headSha: firstSha,
    review: structuredClone(crossReviewFindings),
  },
  11,
  requested,
  ids.reviewer,
);
add('activity.changed', { activity: 'idle' }, 11, changes, ids.reviewer);
const routed = add(
  'feedback.routed',
  {
    prNumber: pr.number,
    reason: 'review_findings',
    summary:
      'Claude Code reviewed PR #7 and requested changes:\n- [major] Unknown discount codes are accepted (src/cart.ts:41)\n- [nit] Test name says SAVE15 (src/cart.test.ts:58)',
    toSessionId: ids.worker,
  },
  11,
  changes,
  ids.worker,
);
add('activity.changed', { activity: 'active' }, 12, routed, ids.worker);
const pushed = add(
  'pr.updated',
  { pr: { ...pr, headSha: fixSha, checks: pending, updatedAt: time(15) } },
  15,
  routed,
  ids.worker,
);
add('activity.changed', { activity: 'idle' }, 15, pushed, ids.worker);
const greenAgain = add(
  'ci.updated',
  { prNumber: pr.number, checks: passing },
  17,
  pushed,
  ids.worker,
);
const rerequested = add(
  'agent_review.requested',
  { workerSessionId: ids.worker, prNumber: pr.number, headSha: fixSha },
  17,
  greenAgain,
  ids.reviewer,
);
add('activity.changed', { activity: 'active' }, 17, rerequested, ids.reviewer);
const approved = add(
  'agent_review.submitted',
  {
    workerSessionId: ids.worker,
    prNumber: pr.number,
    headSha: fixSha,
    review: {
      verdict: 'approve',
      summary: 'Unknown codes now throw, with a test. Ready to merge.',
      findings: [],
    },
  },
  19,
  rerequested,
  ids.reviewer,
);
add('activity.changed', { activity: 'idle' }, 19, approved, ids.reviewer);

export const crossReviewRun: readonly HelixEvent[] = run;
export const crossReviewMilestones = {
  changesRequested: changes,
  routed,
  approved,
} as const;
