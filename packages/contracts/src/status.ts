import { z } from 'zod';
import type { SessionState } from './projection.js';

export const displayStatusSchema = z.enum([
  'pending',
  'working',
  'needs_you',
  'ci_failed',
  'changes_requested',
  'in_review',
  'ready_to_merge',
  'merged',
  'exited',
  'archived',
]);
export type DisplayStatus = z.infer<typeof displayStatusSchema>;
export const boardColumnSchema = z.enum([
  'pending',
  'working',
  'needs_you',
  'in_review',
  'ready_to_merge',
  'archive',
]);
export type BoardColumn = z.infer<typeof boardColumnSchema>;

/** First match wins: archived > merged > needs_you > working > ci_failed >
 * changes_requested > ready_to_merge > in_review > exited > pending.
 * Active repair wins over failures; unknown activity alone never means exited.
 * Draft PRs and unresolved review threads block ready_to_merge (remain in_review).
 */
export function deriveStatus(s: SessionState): DisplayStatus {
  if (s.session.archivedAt !== undefined) return 'archived';
  if (s.pr?.state === 'merged') return 'merged';
  if (s.pendingApprovalIds.length || s.activity === 'waiting_input' || s.activity === 'blocked')
    return 'needs_you';
  if (s.activity === 'active' || s.activity === 'starting') return 'working';
  if (s.pr?.state === 'open') {
    if (s.pr.checks.failed > 0) return 'ci_failed';
    if (s.pr.review.decision === 'changes_requested') return 'changes_requested';
    if (
      s.pr.checks.total > 0 &&
      s.pr.checks.passed === s.pr.checks.total &&
      s.pr.checks.pending === 0 &&
      (s.pr.review.decision === 'approved' || s.pr.review.decision === 'none') &&
      s.pr.mergeable === 'mergeable' &&
      !s.pr.draft &&
      s.pr.review.unresolvedThreads === 0
    )
      return 'ready_to_merge';
    return 'in_review';
  }
  return s.activity === 'exited' ? 'exited' : 'pending';
}
const columns: Record<DisplayStatus, BoardColumn> = {
  pending: 'pending',
  working: 'working',
  needs_you: 'needs_you',
  ci_failed: 'in_review',
  changes_requested: 'in_review',
  in_review: 'in_review',
  ready_to_merge: 'ready_to_merge',
  merged: 'archive',
  exited: 'archive',
  archived: 'archive',
};
export function boardColumn(status: DisplayStatus): BoardColumn {
  return columns[status];
}
