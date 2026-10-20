import { expect, it } from 'vitest';
import { approvalIdSchema, boardColumn, deriveStatus, displayStatusSchema, fixtures, projectUpTo, pullRequestFactsSchema, type AgentActivity, type BoardColumn, type DisplayStatus, type PullRequestFacts, type SessionState } from '../src/index.js';

type Facts = { activity?: AgentActivity; archived?: boolean; approval?: boolean; pr?: PullRequestFacts['state']; checks?: 'failed' | 'pending' | 'empty' | 'passed'; review?: PullRequestFacts['review']['decision']; mergeable?: PullRequestFacts['mergeable']; draft?: boolean; threads?: number };
function state(f: Facts): SessionState {
  const s = projectUpTo(fixtures.passwordResetRun, 9).sessions[fixtures.passwordResetIds.api]!;
  s.activity = f.activity ?? 'idle';
  if (f.archived) s.session.archivedAt = '2026-10-01T10:00:00Z';
  if (f.approval) s.pendingApprovalIds = [approvalIdSchema.parse('approval')];
  if (f.pr) s.pr = pullRequestFactsSchema.parse({ number: 142, url: 'https://example.com/pr/142', state: f.pr,
    headSha: 'sha', draft: f.draft ?? false, mergeable: f.mergeable ?? 'mergeable', updatedAt: '2026-10-01T09:00:00Z',
    checks: f.checks === 'empty' ? { total: 0, passed: 0, failed: 0, pending: 0, failingNames: [] } :
      f.checks === 'failed' ? { total: 3, passed: 1, failed: 1, pending: 1, failingNames: ['unit'] } :
      f.checks === 'pending' ? { total: 3, passed: 2, failed: 0, pending: 1, failingNames: [] } :
      { total: 3, passed: 3, failed: 0, pending: 0, failingNames: [] },
    review: { decision: f.review ?? 'approved', unresolvedThreads: f.threads ?? 0 },
  });
  return s;
}
const rows: [string, Facts, DisplayStatus][] = [
  ['archived beats merged and every intervention', { archived: true, pr: 'merged', approval: true, activity: 'active' }, 'archived'],
  ['archived beats open failures', { archived: true, pr: 'open', checks: 'failed', review: 'changes_requested' }, 'archived'],
  ['archived beats exited', { archived: true, activity: 'exited' }, 'archived'],
  ['merged beats approval', { pr: 'merged', approval: true }, 'merged'],
  ['merged beats blocked', { pr: 'merged', activity: 'blocked' }, 'merged'],
  ['merged beats active', { pr: 'merged', activity: 'active', checks: 'failed' }, 'merged'],
  ['merged beats starting', { pr: 'merged', activity: 'starting' }, 'merged'],
  ['merged beats failed checks and review', { pr: 'merged', checks: 'failed', review: 'changes_requested' }, 'merged'],
  ['approval beats active', { approval: true, activity: 'active' }, 'needs_you'],
  ['approval beats starting', { approval: true, activity: 'starting' }, 'needs_you'],
  ['approval beats failure and review', { approval: true, pr: 'open', checks: 'failed', review: 'changes_requested' }, 'needs_you'],
  ['approval beats ready', { approval: true, pr: 'open' }, 'needs_you'],
  ['approval beats exited', { approval: true, activity: 'exited' }, 'needs_you'],
  ['waiting input alone', { activity: 'waiting_input' }, 'needs_you'],
  ['waiting input beats failure', { activity: 'waiting_input', pr: 'open', checks: 'failed' }, 'needs_you'],
  ['blocked alone', { activity: 'blocked' }, 'needs_you'],
  ['blocked beats review', { activity: 'blocked', pr: 'open', review: 'changes_requested' }, 'needs_you'],
  ['active alone', { activity: 'active' }, 'working'],
  ['starting alone', { activity: 'starting' }, 'working'],
  ['active fixes failing CI and review', { activity: 'active', pr: 'open', checks: 'failed', review: 'changes_requested' }, 'working'],
  ['starting fixes failing CI', { activity: 'starting', pr: 'open', checks: 'failed' }, 'working'],
  ['active fixes requested changes', { activity: 'active', pr: 'open', review: 'changes_requested' }, 'working'],
  ['starting fixes requested changes', { activity: 'starting', pr: 'open', review: 'changes_requested' }, 'working'],
  ['active beats ready', { activity: 'active', pr: 'open' }, 'working'],
  ['starting beats pending checks', { activity: 'starting', pr: 'open', checks: 'pending' }, 'working'],
  ['CI failure beats changes requested', { pr: 'open', checks: 'failed', review: 'changes_requested' }, 'ci_failed'],
  ['CI failure beats approved review', { pr: 'open', checks: 'failed' }, 'ci_failed'],
  ['CI failure beats exited', { pr: 'open', checks: 'failed', activity: 'exited' }, 'ci_failed'],
  ['changes requested beats green CI', { pr: 'open', review: 'changes_requested' }, 'changes_requested'],
  ['changes requested beats pending checks', { pr: 'open', review: 'changes_requested', checks: 'pending' }, 'changes_requested'],
  ['changes requested beats exited', { pr: 'open', review: 'changes_requested', activity: 'exited' }, 'changes_requested'],
  ['green and approved', { pr: 'open' }, 'ready_to_merge'],
  ['green and no required review', { pr: 'open', review: 'none' }, 'ready_to_merge'],
  ['ready beats exited', { pr: 'open', activity: 'exited' }, 'ready_to_merge'],
  ['zero checks is not ready', { pr: 'open', checks: 'empty' }, 'in_review'],
  ['pending checks is not ready', { pr: 'open', checks: 'pending' }, 'in_review'],
  ['review required is not ready', { pr: 'open', review: 'review_required' }, 'in_review'],
  ['unknown mergeability is not ready', { pr: 'open', mergeable: 'unknown' }, 'in_review'],
  ['conflicting is not ready', { pr: 'open', mergeable: 'conflicting' }, 'in_review'],
  ['open PR beats exited', { pr: 'open', activity: 'exited', checks: 'pending' }, 'in_review'],
  ['closed failed PR and exited', { pr: 'closed', checks: 'failed', review: 'changes_requested', activity: 'exited' }, 'exited'],
  ['exited without PR', { activity: 'exited' }, 'exited'],
  ['idle without PR', { activity: 'idle' }, 'pending'],
  ['closed PR does not mean merged', { pr: 'closed' }, 'pending'],
  ['unknown without PR is not death', { activity: 'unknown' }, 'pending'],
  ['unknown with closed PR', { activity: 'unknown', pr: 'closed', checks: 'failed' }, 'pending'],
  ['unknown with approval', { activity: 'unknown', approval: true }, 'needs_you'],
  ['unknown with CI failure', { activity: 'unknown', pr: 'open', checks: 'failed' }, 'ci_failed'],
  ['unknown with changes requested', { activity: 'unknown', pr: 'open', review: 'changes_requested' }, 'changes_requested'],
  ['unknown with ready PR', { activity: 'unknown', pr: 'open' }, 'ready_to_merge'],
  ['unknown with pending PR', { activity: 'unknown', pr: 'open', checks: 'pending' }, 'in_review'],
  ['draft uses specified v1 precedence', { pr: 'open', draft: true }, 'ready_to_merge'],
  ['thread count uses specified v1 precedence', { pr: 'open', threads: 1 }, 'ready_to_merge'],
];
it.each(rows)('%s', (_name, facts, expected) => expect(deriveStatus(state(facts))).toBe(expected));
const mapping: Record<DisplayStatus, BoardColumn> = { pending: 'pending', working: 'working', needs_you: 'needs_you', ci_failed: 'in_review', changes_requested: 'in_review', in_review: 'in_review', ready_to_merge: 'ready_to_merge', merged: 'archive', exited: 'archive', archived: 'archive' };
it.each(displayStatusSchema.options)('maps %s to its board column', (status) => expect(boardColumn(status)).toBe(mapping[status]));
