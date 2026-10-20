import type { FeedbackMessageBuilder } from '@helix/contracts';

const compact = (text: string) => text.replace(/\s+/g, ' ').trim();
const trim = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** One paragraph, at most 1,500 UTF-16 characters. `details` is a caller-supplied
 * annotation/log excerpt and/or formatted unresolved comments (author, path:line,
 * body). Only its first 900 characters are retained; never pass full raw logs.
 */
export const buildFeedbackMessage: FeedbackMessageBuilder = ({ reason, pr, details }) => {
  const action = {
    ci_failed: 'Fix the failing checks',
    changes_requested: 'Address the requested review changes',
    merge_conflict: 'Resolve the merge conflicts',
  }[reason];
  const parts = [`PR #${pr.number}: ${action}.`];
  if (pr.checks.failingNames.length)
    parts.push(`Failing checks: ${trim(pr.checks.failingNames.map(compact).join(', '), 400)}.`);
  if (pr.review.unresolvedThreads)
    parts.push(`Unresolved review threads: ${pr.review.unresolvedThreads}.`);
  if (details?.trim()) parts.push(`Details: ${trim(compact(details), 900)}`);
  return trim(parts.join(' '), 1500);
};
