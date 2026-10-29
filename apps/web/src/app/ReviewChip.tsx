import { AgentBadge } from '@helix/ui';
import type { CrossReview } from '../data/crossReview';
import s from './Review.module.css';

export function ReviewChip({ review, onOpen }: { review: CrossReview; onOpen?: () => void }) {
  const content = (
    <>
      <AgentBadge agent={review.agent} variant="glyph" />
      <span>{review.label}</span>
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className={s.chip}
      data-review={review.status}
      onClick={onOpen}
      aria-label={`Open Review: ${review.label}`}
    >
      {content}
    </button>
  ) : (
    <span className={s.chip} data-review={review.status}>
      {content}
    </span>
  );
}
