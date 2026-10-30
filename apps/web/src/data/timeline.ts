import type { HelixEvent } from '@helix/contracts';

/** Last event at or before the requested time; duplicate timestamps keep log order. */
export function eventIndexAtTime(events: readonly HelixEvent[], time: number): number {
  let low = 0,
    high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (Date.parse(events[mid]!.ts) <= time) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low - 1);
}

export function timelineMilestones(events: readonly HelixEvent[]): number[] {
  const types = new Set([
    'plan.submitted',
    'plan.approved',
    'plan.rejected',
    'session.started',
    'pr.opened',
    'ci.updated',
    'feedback.routed',
    'pr.merged',
    'agent_review.requested',
    'agent_review.submitted',
    'session.exited',
  ]);
  return events.flatMap((event, index) =>
    index === 0 || index === events.length - 1 || types.has(event.type) ? [index] : [],
  );
}
