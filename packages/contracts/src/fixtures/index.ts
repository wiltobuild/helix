import {
  approvalSchema,
  planSchema,
  projectSchema,
  pullRequestFactsSchema,
  sessionSchema,
  type CheckSummary,
  type Session,
} from '../entities.js';
import { helixEventSchema, type EventType, type HelixEvent, type PayloadFor } from '../events.js';
import { planNodeIdSchema, sessionIdSchema, type PlanNodeId, type SessionId } from '../ids.js';

const time = (minute: number) => `2026-10-01T09:${String(minute).padStart(2, '0')}:00.000Z`;
export const passwordResetProject = projectSchema.parse({
  id: 'proj_demo_portal',
  name: 'Acme customer portal',
  repoPath: '/demo/acme/portal',
  defaultBranch: 'main',
  github: { owner: 'acme-demo', repo: 'portal' },
  defaultAgent: 'claude-code',
  createdAt: time(0),
});
export const passwordResetIds = {
  orchestrator: sessionIdSchema.parse('sess_reset_orchestrator'),
  api: sessionIdSchema.parse('sess_reset_api'),
  ui: sessionIdSchema.parse('sess_reset_ui'),
  e2e: sessionIdSchema.parse('sess_reset_e2e'),
  apiNode: planNodeIdSchema.parse('node_reset_api'),
  uiNode: planNodeIdSchema.parse('node_reset_ui'),
  e2eNode: planNodeIdSchema.parse('node_reset_e2e'),
};
const ids = passwordResetIds;
function worker(id: SessionId, title: string, agent: string, planNodeId?: PlanNodeId): Session {
  return sessionSchema.parse({
    id,
    projectId: passwordResetProject.id,
    role: planNodeId ? 'worker' : 'orchestrator',
    agent,
    title,
    prompt: title,
    interface: 'chat',
    createdAt: time(planNodeId ? 4 : 0),
    ...(planNodeId ? { planNodeId, parentSessionId: ids.orchestrator } : {}),
  });
}
export const passwordResetPlan = planSchema.parse({
  id: 'plan_password_reset',
  projectId: passwordResetProject.id,
  orchestratorSessionId: ids.orchestrator,
  goal: 'Add password reset',
  createdAt: time(2),
  nodes: [
    {
      id: ids.apiNode,
      title: 'Password reset API',
      files: ['src/api/password-reset/**'],
      description: 'Issue single-use, expiring tokens and accept a new password.',
      acceptance: [
        'Never reveal whether an email exists',
        'Expire reset tokens after 30 minutes',
        'Consume tokens atomically',
      ],
      dependsOn: [],
      agent: 'codex',
      rationale: 'Build and test the token lifecycle independently of the form.',
      sessionId: ids.api,
    },
    {
      id: ids.uiNode,
      title: 'Password reset form',
      files: ['src/ui/password-reset/**', 'src/emails/password-reset/**'],
      description: 'Add accessible request and reset forms plus localized email copy.',
      acceptance: [
        'Keyboard-accessible forms',
        'Neutral confirmation for every email',
        'Explain expired links',
      ],
      dependsOn: [],
      agent: 'claude-code',
      rationale: 'The UI can proceed against the agreed API while token logic is implemented.',
      sessionId: ids.ui,
    },
    {
      id: ids.e2eNode,
      title: 'Password reset E2E tests',
      files: ['tests/password-reset.spec.ts'],
      description: 'Exercise email delivery, token consumption and expired links in Playwright.',
      acceptance: ['Complete a reset through the test mailbox', 'Reject reused and expired tokens'],
      dependsOn: [ids.apiNode, ids.uiNode],
      agent: 'codex',
      rationale:
        'Start browser tests after both API and UI merge so the test covers the integrated flow.',
      sessionId: ids.e2e,
    },
  ],
});
const passing: CheckSummary = { total: 3, passed: 3, failed: 0, pending: 0, failingNames: [] };
const pending: CheckSummary = { total: 3, passed: 0, failed: 0, pending: 3, failingNames: [] };
const failing: CheckSummary = {
  total: 3,
  passed: 2,
  failed: 1,
  pending: 0,
  failingNames: ['unit / token.test.ts'],
};
const apiPr = pullRequestFactsSchema.parse({
  number: 142,
  url: 'https://github.com/acme-demo/portal/pull/142',
  state: 'open',
  draft: false,
  headSha: '17b8f3d24d3ec9f3f8bb4d520be628602b63a9a4',
  mergeable: 'mergeable',
  checks: pending,
  review: { decision: 'review_required', unresolvedThreads: 0 },
  updatedAt: time(14),
});
const uiPr = pullRequestFactsSchema.parse({
  ...apiPr,
  number: 143,
  url: 'https://github.com/acme-demo/portal/pull/143',
  headSha: '2bb8f3d24d3ec9f3f8bb4d520be628602b63a9a4',
  updatedAt: time(28),
});
const approval = approvalSchema.parse({
  id: 'approval_reset_email_copy',
  sessionId: ids.ui,
  kind: 'migration',
  summary: 'Add password-reset email templates to the localized content table',
  detail:
    'Apply 20261001_reset_email_templates.sql to the local development database. Adds two template rows; no destructive changes.',
  scope: 'once',
  requestedAt: time(10),
});
const run: HelixEvent[] = [];
function add<T extends EventType>(
  type: T,
  payload: PayloadFor<T>,
  minute: number,
  causedBy?: number,
  sessionId?: SessionId,
  planNodeId?: PlanNodeId,
): void {
  run.push(
    helixEventSchema.parse({
      seq: run.length + 1,
      ts: time(minute),
      projectId: passwordResetProject.id,
      type,
      payload,
      v: 1,
      ...(causedBy === undefined ? {} : { causedBy }),
      ...(sessionId ? { sessionId } : {}),
      ...(planNodeId ? { planNodeId } : {}),
    }),
  );
}
add('project.added', { project: passwordResetProject }, 0); // 1
add(
  'session.created',
  { session: worker(ids.orchestrator, 'Add password reset', 'claude-code') },
  0,
  1,
  ids.orchestrator,
);
add('session.started', {}, 1, 2, ids.orchestrator);
add('activity.changed', { activity: 'active' }, 1, 3, ids.orchestrator);
add('plan.submitted', { plan: passwordResetPlan }, 2, 4, ids.orchestrator); // 5
add('plan.approved', { planId: passwordResetPlan.id, approvedBy: 'human' }, 3, 5, ids.orchestrator); // 6
add(
  'session.created',
  { session: worker(ids.api, 'Implement secure password reset endpoints', 'codex', ids.apiNode) },
  4,
  6,
  ids.api,
  ids.apiNode,
);
add(
  'session.created',
  { session: worker(ids.ui, 'Build accessible password reset forms', 'claude-code', ids.uiNode) },
  4,
  6,
  ids.ui,
  ids.uiNode,
);
add(
  'session.created',
  {
    session: worker(
      ids.e2e,
      'Cover the password reset journey in Playwright',
      'codex',
      ids.e2eNode,
    ),
  },
  4,
  6,
  ids.e2e,
  ids.e2eNode,
);
add(
  'worktree.created',
  {
    branch: 'helix/reset-api',
    path: '/demo/worktrees/reset-api',
    baseSha: 'a881c62659462bfa98fdcfa5e2605613b701d742',
  },
  5,
  7,
  ids.api,
  ids.apiNode,
);
add(
  'worktree.created',
  {
    branch: 'helix/reset-ui',
    path: '/demo/worktrees/reset-ui',
    baseSha: 'a881c62659462bfa98fdcfa5e2605613b701d742',
  },
  5,
  8,
  ids.ui,
  ids.uiNode,
);
add('session.started', {}, 6, 10, ids.api, ids.apiNode);
add('session.started', {}, 6, 11, ids.ui, ids.uiNode);
add('activity.changed', { activity: 'active' }, 7, 12, ids.api, ids.apiNode);
add('activity.changed', { activity: 'active' }, 7, 13, ids.ui, ids.uiNode);
add(
  'chat.item',
  {
    item: {
      kind: 'message',
      role: 'assistant',
      text: 'The reset endpoint hashes tokens at rest and returns the same response for unknown email addresses.',
    },
  },
  8,
  14,
  ids.api,
  ids.apiNode,
);
add('approval.requested', { approval }, 10, 15, ids.ui, ids.uiNode); // 17
add('activity.changed', { activity: 'waiting_input' }, 10, 17, ids.ui, ids.uiNode);
add(
  'worktree.diff_updated',
  { filesChanged: 6, insertions: 248, deletions: 12 },
  12,
  16,
  ids.api,
  ids.apiNode,
);
add('pr.opened', { pr: apiPr }, 14, 19, ids.api, ids.apiNode); // 20
add('activity.changed', { activity: 'idle' }, 14, 20, ids.api, ids.apiNode);
add('ci.updated', { prNumber: apiPr.number, checks: failing }, 16, 20, ids.api, ids.apiNode); // 22
add(
  'feedback.routed',
  {
    prNumber: apiPr.number,
    reason: 'ci_failed',
    summary:
      'unit / token.test.ts failed: an expired token was accepted at the exact 30-minute boundary. Compare expiry with <= and add the boundary regression.',
    toSessionId: ids.api,
  },
  16,
  22,
  ids.api,
  ids.apiNode,
);
add('activity.changed', { activity: 'active' }, 17, 23, ids.api, ids.apiNode); // 24: fix begins
add(
  'chat.item',
  {
    item: {
      kind: 'tool_call',
      tool: 'shell',
      inputSummary: 'pnpm vitest run token.test.ts',
      outputSummary: '12 tests passed, including expiry boundary and token reuse.',
      status: 'succeeded',
    },
  },
  19,
  24,
  ids.api,
  ids.apiNode,
);
add(
  'approval.decided',
  { approvalId: approval.id, decision: 'approved' },
  20,
  17,
  ids.ui,
  ids.uiNode,
);
add('activity.changed', { activity: 'active' }, 20, 26, ids.ui, ids.uiNode);
add(
  'reasoning.summary',
  {
    text: 'The approved migration seeds email copy. Both forms now announce validation errors and use neutral confirmation text.',
    source: 'agent',
  },
  22,
  27,
  ids.ui,
  ids.uiNode,
);
add(
  'pr.updated',
  { pr: { ...apiPr, headSha: '3cb8f3d24d3ec9f3f8bb4d520be628602b63a9a4', updatedAt: time(24) } },
  24,
  25,
  ids.api,
  ids.apiNode,
);
add('ci.updated', { prNumber: apiPr.number, checks: passing }, 25, 29, ids.api, ids.apiNode);
add('activity.changed', { activity: 'idle' }, 25, 30, ids.api, ids.apiNode);
add(
  'review.updated',
  { prNumber: apiPr.number, review: { decision: 'approved', unresolvedThreads: 0 } },
  26,
  30,
  ids.api,
  ids.apiNode,
);
add(
  'worktree.diff_updated',
  { filesChanged: 8, insertions: 316, deletions: 21 },
  27,
  28,
  ids.ui,
  ids.uiNode,
);
add('pr.opened', { pr: uiPr }, 28, 33, ids.ui, ids.uiNode);
add('activity.changed', { activity: 'idle' }, 28, 34, ids.ui, ids.uiNode);
add('ci.updated', { prNumber: uiPr.number, checks: passing }, 30, 34, ids.ui, ids.uiNode);
add(
  'review.updated',
  { prNumber: uiPr.number, review: { decision: 'approved', unresolvedThreads: 0 } },
  31,
  36,
  ids.ui,
  ids.uiNode,
);
add(
  'pr.merged',
  { prNumber: apiPr.number, mergeSha: '4db8f3d24d3ec9f3f8bb4d520be628602b63a9a4' },
  33,
  32,
  ids.api,
  ids.apiNode,
);
add(
  'pr.merged',
  { prNumber: uiPr.number, mergeSha: '5eb8f3d24d3ec9f3f8bb4d520be628602b63a9a4' },
  35,
  37,
  ids.ui,
  ids.uiNode,
);
add(
  'plan.node_updated',
  {
    nodeId: ids.e2eNode,
    sessionId: ids.e2e,
    note: 'API #142 and UI #143 have merged; start browser coverage from the updated main branch.',
  },
  36,
  39,
  ids.orchestrator,
  ids.e2eNode,
);
add(
  'worktree.created',
  {
    branch: 'helix/reset-e2e',
    path: '/demo/worktrees/reset-e2e',
    baseSha: '5eb8f3d24d3ec9f3f8bb4d520be628602b63a9a4',
  },
  37,
  40,
  ids.e2e,
  ids.e2eNode,
);
add('session.started', {}, 38, 41, ids.e2e, ids.e2eNode);
add('activity.changed', { activity: 'active' }, 39, 42, ids.e2e, ids.e2eNode);
add(
  'explain.note',
  {
    text: 'Both prerequisite PRs are merged. The E2E worker can now verify a real reset email, an expired link, and single-use tokens against the integrated application.',
  },
  40,
  43,
  ids.orchestrator,
  ids.e2eNode,
);

/** 44 events over 40 minutes; every event after genesis links to a prior cause. */
export const passwordResetRun: readonly HelixEvent[] = run;
export const passwordResetMilestones = {
  awaitingApproval: 5,
  planApproved: 6,
  plan: 9,
  ciFailure: 22,
  fix: 24,
  approved: 26,
  ready: 37,
  final: 44,
} as const;
export * from './cross-review.js';
