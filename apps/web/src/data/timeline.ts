import type { HelixEvent } from '@helix/contracts';
import { timeMapping, type TimeAccounting } from './activeTime';

/** Shared fractional chart adapter. Its zero-width intervals stay zero; no fake work width. */
export function ganttTimeAxis(timing: TimeAccounting, mapping: ReturnType<typeof timeMapping>) {
  const span = Math.max(mapping.total, 1);
  return {
    eventAt: (index: number) => mapping.forward(timing.times[index] ?? timing.start) / span,
    tail: mapping.forward(timing.end) / span,
  };
}
export function pointerTime(clientX: number, left: number, width: number, total: number): number {
  if (![clientX, left, width, total].every(Number.isFinite) || width <= 0) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width)) * Math.max(0, total);
}

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
