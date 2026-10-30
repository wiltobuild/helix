import type { AgentActivity, HelixEvent, VisualDesign } from '@helix/contracts';

export type TimeMode = 'active' | 'elapsed';
export interface Interval {
  start: number;
  end: number;
}
export interface AgentTime {
  sessionId: string;
  work: number;
  approvalWait: number;
  unknown: number;
}

/** Key order is not event identity. Retain conflicting payloads, never overwrite the log. */
export function eventFingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(eventFingerprint).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${eventFingerprint(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

export function mergeEventHistory(
  previous: readonly HelixEvent[],
  incoming: readonly HelixEvent[],
): readonly HelixEvent[] {
  const fingerprints = new Set(previous.map(eventFingerprint));
  const additions = incoming.filter((event) => {
    const fingerprint = eventFingerprint(event);
    if (fingerprints.has(fingerprint)) return false;
    fingerprints.add(fingerprint);
    return true;
  });
  if (!additions.length) return previous;
  return [...previous, ...additions].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    const left = eventFingerprint(a),
      right = eventFingerprint(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Projection needs one value per seq. Conflicts use a deterministic DISPLAY representative;
 * raw ingestion retains all variants and accounting disables compression with a visible warning. */
export function canonicalEvents(input: readonly HelixEvent[]): HelixEvent[] {
  const sorted = mergeEventHistory([], input);
  return sorted.filter((event, i) => i === 0 || event.seq !== sorted[i - 1]!.seq);
}

export function unionIntervals(input: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const interval of [...input]
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else result.push({ ...interval });
  }
  return result;
}
const duration = (intervals: readonly Interval[]) =>
  intervals.reduce((sum, i) => sum + i.end - i.start, 0);
interface Agent {
  activity: AgentActivity;
  ended: boolean;
  approvals: Set<string>;
  currentPlan: string | undefined;
  work: Interval[];
  wait: Interval[];
  observed: number;
}

/** Evidence only, based on contracts, harness/session.ts, core/core.ts and visual-design.ts.
 * Tool requests bypass autoApprove; plan submission alone does not stop its orchestrator.
 * Pending identities survive contradictory work; only current blocking evidence compresses.
 * This is PROJECT HISTORY, not inferred task/run boundaries. Gaps between tasks remain active.
 * `now` is optional and only for connected live data. Completion requires all known sessions
 * ended and no recorded outstanding workflow. Process exit alone cannot finish a review/job.
 */
export function accountTime(input: readonly HelixEvent[], now?: number) {
  const events = canonicalEvents(input);
  const warnings = new Set<string>();
  const seen = new Map<number, string>();
  const conflicts = new Set<number>();
  let unsafe = false;
  for (const event of input) {
    const encoded = eventFingerprint(event);
    if (seen.has(event.seq) && seen.get(event.seq) !== encoded) conflicts.add(event.seq);
    seen.set(event.seq, encoded);
    if (event.projectId !== input[0]?.projectId) unsafe = true;
  }
  if (conflicts.size) {
    unsafe = true;
    warnings.add(
      `Conflicting event identities #${[...conflicts].sort((a, b) => a - b).join(', #')}: all variants retained; deterministic display representative only. Compression disabled.`,
    );
  }
  const parsedTimes = events.map((event) => Date.parse(event.ts));
  const firstValid = parsedTimes.find(Number.isFinite);
  const durationKnown = events.length > 0 && parsedTimes.every(Number.isFinite);
  const times: number[] = [];
  for (const parsed of parsedTimes) {
    const previous = times.at(-1) ?? firstValid ?? 0;
    if (!Number.isFinite(parsed) || parsed < previous) unsafe = true;
    times.push(Number.isFinite(parsed) ? Math.max(previous, parsed) : previous);
  }
  if (unsafe)
    warnings.add(
      'Invalid/backward timestamps or conflicting history: compression and live extrapolation disabled.',
    );
  if (!durationKnown && events.length)
    warnings.add(
      'Duration is incomplete: only valid observed timestamp bounds are measured; missing time is unknown.',
    );
  const start = times[0] ?? 0;
  const tail = times.at(-1) ?? start;
  let end = tail;
  const agents = new Map<string, Agent>();
  const approvals = new Map<string, string>();
  const plans = new Map<string, HelixEvent<'plan.submitted'>['payload']['plan']>();
  const decidedApprovals = new Set<string>();
  const decidedPlans = new Set<string>();
  const pendingChecks = new Map<number, boolean>();
  const pendingExternalReviews = new Map<number, boolean>();
  const openPrs = new Set<number>();
  const heads = new Map<string, string>();
  const pendingReviews = new Set<string>();
  const queuedNodes = new Set<string>();
  const unassignedNodes = new Set<string>();
  const designs = new Map<string, VisualDesign>();
  const uncertainDesigns = new Set<string>();
  const waits: Interval[] = [];
  const getAgent = (id: string): Agent => {
    let agent = agents.get(id);
    if (!agent) {
      agent = {
        activity: 'unknown',
        ended: false,
        approvals: new Set(),
        currentPlan: undefined,
        work: [],
        wait: [],
        observed: 0,
      };
      agents.set(id, agent);
    }
    return agent;
  };
  const quiescent = (a: Agent) => ['idle', 'waiting_input', 'blocked'].includes(a.activity);
  const validDesignWait = (design: VisualDesign) => {
    if (
      uncertainDesigns.has(design.sessionId) ||
      design.status !== 'ready' ||
      design.decision ||
      design.blocker
    )
      return false;
    const checkpoint = design.checkpoint;
    if (checkpoint && heads.get(checkpoint.workerSessionId) !== checkpoint.headSha) return false;
    if (!checkpoint && !design.rounds.at(-1)?.concepts.length) return false;
    return true;
  };
  const designWait = (id: string) =>
    [...designs.values()].some(
      (design) =>
        validDesignWait(design) &&
        (design.sessionId === id || design.checkpoint?.workerSessionId === id),
    );
  const waiting = (id: string, a: Agent) =>
    !a.ended &&
    ((a.approvals.size > 0 && ['waiting_input', 'blocked'].includes(a.activity)) ||
      (quiescent(a) && (a.currentPlan !== undefined || designWait(id))));
  const nonHumanPending = () =>
    [...pendingChecks.values()].some(Boolean) ||
    [...pendingExternalReviews.values()].some(Boolean) ||
    pendingReviews.size > 0 ||
    queuedNodes.size > 0 ||
    unassignedNodes.size > 0 ||
    uncertainDesigns.size > 0 ||
    [...designs.values()].some(
      (design) =>
        ['pending', 'failed', 'unavailable'].includes(design.status) ||
        (design.status === 'ready' && !validDesignWait(design)) ||
        (design.status === 'approved' && !design.decision),
    );
  const completed = () =>
    agents.size > 0 &&
    [...agents.values()].every((a) => a.ended) &&
    !nonHumanPending() &&
    !openPrs.size &&
    ![...agents.values()].some((a) => a.currentPlan !== undefined) &&
    ![...designs.values()].some((design) => design.status === 'ready');
  const contradictWork = (agent: Agent | undefined) => {
    if (!agent) return;
    if (agent.approvals.size)
      warnings.add(
        'Useful work interrupted approval blocking evidence; unresolved requests are retained.',
      );
    if (agent.activity !== 'active') agent.activity = 'unknown';
  };
  const reviewKey = (
    event: HelixEvent<
      'agent_review.requested' | 'agent_review.submitted' | 'agent_review.abandoned'
    >,
  ) =>
    JSON.stringify([
      event.sessionId,
      event.payload.workerSessionId,
      event.payload.prNumber,
      event.payload.headSha,
    ]);

  for (const [index, event] of events.entries()) {
    const id = event.type === 'session.created' ? event.payload.session.id : event.sessionId;
    const agent = id ? getAgent(id) : undefined;
    switch (event.type) {
      case 'ci.updated':
        pendingChecks.set(event.payload.prNumber, event.payload.checks.pending > 0);
        break;
      case 'review.updated':
        pendingExternalReviews.set(
          event.payload.prNumber,
          ['review_required', 'changes_requested'].includes(event.payload.review.decision) ||
            event.payload.review.unresolvedThreads > 0,
        );
        break;
      case 'pr.opened':
      case 'pr.updated': {
        const pr = event.payload.pr;
        pendingChecks.set(pr.number, pr.state === 'open' && pr.checks.pending > 0);
        pendingExternalReviews.set(
          pr.number,
          pr.state === 'open' &&
            (['review_required', 'changes_requested'].includes(pr.review.decision) ||
              pr.review.unresolvedThreads > 0),
        );
        if (pr.state === 'open') openPrs.add(pr.number);
        else openPrs.delete(pr.number);
        if (id) heads.set(id, pr.headSha);
        break;
      }
      case 'pr.merged':
        pendingChecks.delete(event.payload.prNumber);
        pendingExternalReviews.delete(event.payload.prNumber);
        openPrs.delete(event.payload.prNumber);
        break;
      case 'agent_review.requested':
        pendingReviews.add(reviewKey(event));
        contradictWork(agent);
        break;
      case 'agent_review.submitted':
      case 'agent_review.abandoned':
        pendingReviews.delete(reviewKey(event));
        contradictWork(agent);
        break;
      case 'plan.node_updated':
        if (event.payload.waiting === 'worker_slot') queuedNodes.add(event.payload.nodeId);
        else queuedNodes.delete(event.payload.nodeId);
        if (event.payload.sessionId) {
          unassignedNodes.delete(event.payload.nodeId);
          getAgent(event.payload.sessionId);
        }
        break;
      case 'session.created':
        if (event.payload.session.planNodeId) {
          queuedNodes.delete(event.payload.session.planNodeId);
          unassignedNodes.delete(event.payload.session.planNodeId);
        }
        break;
      case 'session.started':
        if (agent) {
          agent.ended = false;
          agent.activity = 'starting';
        }
        break;
      case 'session.exited':
      case 'session.archived':
        if (agent) {
          if (agent.approvals.size || agent.currentPlan)
            warnings.add(
              'A session ended without a recorded decision; its wait stops at exit, unresolved identities remain.',
            );
          agent.ended = true;
        }
        break;
      case 'activity.changed':
        if (agent) {
          agent.activity = event.payload.activity;
          agent.ended = event.payload.activity === 'exited';
          if (agent.approvals.size && !['waiting_input', 'blocked'].includes(agent.activity))
            warnings.add(
              'Activity no longer proves an approval wait; unresolved requests are retained.',
            );
        }
        break;
      case 'approval.requested': {
        const approval = event.payload.approval;
        if (event.sessionId && event.sessionId !== approval.sessionId) {
          warnings.add('Approval session mismatch; no wait inferred.');
          break;
        }
        if (
          !approvals.has(approval.id) &&
          !decidedApprovals.has(approval.id) &&
          !approval.decision
        ) {
          approvals.set(approval.id, approval.sessionId);
          const owner = getAgent(approval.sessionId);
          owner.approvals.add(approval.id);
          owner.activity = 'waiting_input';
        }
        break;
      }
      case 'approval.decided': {
        const owner = approvals.get(event.payload.approvalId);
        if (owner && (!event.sessionId || event.sessionId === owner)) {
          decidedApprovals.add(event.payload.approvalId);
          getAgent(owner).approvals.delete(event.payload.approvalId);
        } else {
          if (!owner) decidedApprovals.add(event.payload.approvalId);
          warnings.add('Decision lacks a matching request; no earlier wait inferred.');
        }
        break;
      }
      case 'plan.submitted': {
        const plan = event.payload.plan;
        if (!plans.has(plan.id) && !decidedPlans.has(plan.id)) {
          plans.set(plan.id, plan);
          const owner = getAgent(plan.orchestratorSessionId);
          if (owner.currentPlan)
            warnings.add(
              'A newer plan superseded earlier blocking evidence; no earlier decision is inferred.',
            );
          owner.currentPlan = plan.id;
        }
        break;
      }
      case 'plan.approved':
      case 'plan.rejected': {
        const plan = plans.get(event.payload.planId);
        if (plan && (!event.sessionId || event.sessionId === plan.orchestratorSessionId)) {
          decidedPlans.add(plan.id);
          const owner = getAgent(plan.orchestratorSessionId);
          if (owner.currentPlan === plan.id) owner.currentPlan = undefined;
          if (event.type === 'plan.approved')
            for (const node of plan.nodes) {
              if (!node.sessionId) unassignedNodes.add(node.id);
              else getAgent(node.sessionId);
            }
        } else {
          if (!plan) decidedPlans.add(event.payload.planId);
          warnings.add('Plan decision lacks a matching submission; no earlier wait inferred.');
        }
        break;
      }
      case 'design.updated': {
        const design = event.payload.design;
        const owner = getAgent(design.sessionId);
        // A changed design invalidates the premise of an older plan, not its immutable identity.
        if (owner.currentPlan) {
          warnings.add('Design changed: earlier plan blocking evidence is stale.');
          owner.currentPlan = undefined;
        }
        const previous = designs.get(design.sessionId);
        const sameRevisionValid =
          previous?.status === 'pending' &&
          ['ready', 'failed', 'unavailable'].includes(design.status);
        if (
          (event.sessionId && event.sessionId !== design.sessionId) ||
          (previous &&
            (design.revision < previous.revision ||
              (design.revision === previous.revision &&
                !sameRevisionValid &&
                eventFingerprint(previous) !== eventFingerprint(design))))
        ) {
          uncertainDesigns.add(design.sessionId);
          warnings.add('Stale or conflicting design revision: no human wait inferred.');
        } else {
          if (!previous || design.revision > previous.revision)
            uncertainDesigns.delete(design.sessionId);
          designs.set(design.sessionId, design);
        }
        break;
      }
      case 'chat.item':
        if (event.payload.item.kind !== 'message' || event.payload.item.role === 'assistant')
          contradictWork(agent);
        break;
      case 'reasoning.summary':
      case 'worktree.diff_updated':
        contradictWork(agent);
        break;
      case 'feedback.routed':
        contradictWork(getAgent(event.payload.toSessionId));
        break;
    }
    if (
      index === events.length - 1 &&
      !unsafe &&
      durationKnown &&
      !completed() &&
      agents.size > 0 &&
      now !== undefined &&
      Number.isFinite(now)
    )
      end = Math.max(tail, now);
    const interval = { start: times[index]!, end: times[index + 1] ?? end };
    if (interval.end <= interval.start) continue;
    const participants = [...agents].filter(([, a]) => !a.ended);
    if (
      !unsafe &&
      !nonHumanPending() &&
      participants.length > 0 &&
      participants.every(([sid, a]) => waiting(sid, a))
    )
      waits.push(interval);
    for (const [sid, a] of participants) {
      a.observed += interval.end - interval.start;
      if (!unsafe && waiting(sid, a)) a.wait.push(interval);
      else if (!unsafe && a.activity === 'active') a.work.push(interval);
    }
  }
  const open = [...agents].some(([sid, a]) => waiting(sid, a));
  const unresolvedApprovals = [...agents].flatMap(([sessionId, a]) =>
    [...a.approvals].map((approvalId) => ({ sessionId, approvalId })),
  );
  const unresolvedPlans = [...plans.keys()].filter((id) => !decidedPlans.has(id));
  if (open)
    warnings.add(
      now === undefined || end === tail
        ? 'Open human waits end at the last observed event; their actual end is unknown.'
        : 'Open human waits are provisional through the live clock.',
    );
  if (unresolvedApprovals.length)
    warnings.add(
      `${unresolvedApprovals.length} unresolved approval request(s); pending identity alone does not prove current blocking.`,
    );
  if (pendingReviews.size)
    warnings.add('Unresolved review lifecycle remains active, including after reviewer exit.');
  const humanWait = unionIntervals(waits);
  const elapsed = end - start;
  const human = duration(humanWait);
  const perAgent: AgentTime[] = [...agents].map(([sessionId, a]) => {
    const work = duration(unionIntervals(a.work));
    const approvalWait = duration(unionIntervals(a.wait));
    return { sessionId, work, approvalWait, unknown: a.observed - work - approvalWait };
  });
  return {
    events,
    times,
    start,
    end,
    elapsed,
    active: elapsed - human,
    human,
    humanWait,
    perAgent,
    warnings: [...warnings],
    open,
    unresolvedApprovals,
    unresolvedPlans,
    durationKnown,
    completed: completed(),
    canTick: !unsafe && durationKnown && agents.size > 0 && !completed(),
    conflicts: [...conflicts].sort((a, b) => a - b),
  };
}
export type TimeAccounting = ReturnType<typeof accountTime>;

/** One mapping for chart, scrubber, milestones and Why. Collapse never changes source timestamps. */
export function timeMapping(accounting: TimeAccounting, mode: TimeMode) {
  const { start, end } = accounting;
  const intervals = mode === 'active' ? accounting.humanWait : [];
  const forward = (timestamp: number) => {
    const t = Math.max(start, Math.min(Number.isFinite(timestamp) ? timestamp : start, end));
    return (
      t - start - intervals.reduce((sum, i) => sum + Math.max(0, Math.min(t, i.end) - i.start), 0)
    );
  };
  // Right-continuous inverse; exact event selection and keyboard stepping retain all identities.
  const inverse = (position: number) => {
    const p = Math.max(0, Math.min(Number.isFinite(position) ? position : 0, forward(end)));
    let t = start + p;
    for (const i of intervals) {
      if (t < i.start) break;
      t += i.end - i.start;
    }
    return Math.min(t, end);
  };
  const seek = (position: number) => {
    const t = inverse(position);
    let index = 0;
    for (let i = 0; i < accounting.times.length; i++) {
      if (accounting.times[i]! > t) break;
      index = i;
    }
    return index;
  };
  return { forward, inverse, seek, total: forward(end) };
}
export function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
