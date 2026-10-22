import type { HelixEvent } from './events.js';
import type { PlanNodeId } from './ids.js';
import type { ProjectState } from './projection.js';

/** Target first, then its causes; stop at missing history, a cycle, or 50 events. */
export function whyChain(events: readonly HelixEvent[], seq: number): HelixEvent[] {
  const bySeq = new Map(events.map((e) => [Number(e.seq), e]));
  const seen = new Set<number>();
  const result: HelixEvent[] = [];
  let current = bySeq.get(seq);
  while (current && result.length < 50 && !seen.has(current.seq)) {
    result.push(current);
    seen.add(current.seq);
    current = current.causedBy === undefined ? undefined : bySeq.get(current.causedBy);
  }
  return result;
}
export function rationaleFor(state: ProjectState, planNodeId: PlanNodeId): string | undefined {
  for (const plan of Object.values(state.plans)) {
    const node = plan.nodes.find((n) => n.id === planNodeId);
    if (node) return node.rationale;
  }
  return undefined;
}
