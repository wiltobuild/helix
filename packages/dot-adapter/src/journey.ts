import type { Event, Evidence, Journey } from './types.js';

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const date = (value: unknown): boolean => text(value) && Number.isFinite(Date.parse(value));

/** Validate every field used to elevate a claim; unknown event payloads remain opaque. */
export function validEvidencePayload(event: Event): boolean {
  const p = event.payload;
  if (event.type === 'pr.merged') return count(p.prNumber) && p.prNumber > 0 && text(p.mergeSha);
  if (event.type === 'pr.opened' || event.type === 'pr.updated') {
    const pr = object(p.pr);
    return (
      count(pr.number) &&
      pr.number > 0 &&
      text(pr.headSha) &&
      ['open', 'closed', 'merged'].includes(String(pr.state))
    );
  }
  if (event.type === 'plan.submitted') {
    const plan = object(p.plan);
    return (
      text(plan.id) &&
      plan.projectId === event.projectId &&
      plan.orchestratorSessionId === event.sessionId
    );
  }
  if (event.type === 'plan.approved') return text(p.planId) && p.approvedBy === 'human';
  if (event.type === 'plan.rejected') return text(p.planId) && text(p.reason);
  if (event.type === 'approval.requested') {
    const a = object(p.approval);
    return text(a.id) && a.sessionId === event.sessionId && date(a.requestedAt);
  }
  if (event.type === 'approval.decided')
    return (
      text(p.approvalId) &&
      ['approved', 'rejected', 'changes_requested'].includes(String(p.decision))
    );
  if (event.type === 'reasoning.summary')
    return typeof p.text === 'string' && ['agent', 'orchestrator'].includes(String(p.source));
  if (event.type === 'worktree.diff_updated')
    return count(p.filesChanged) && count(p.insertions) && count(p.deletions);
  if (event.type === 'session.created') {
    const session = object(p.session);
    if (session.id !== event.sessionId || session.projectId !== event.projectId) return false;
    if (session.reviewedBrief === undefined) return true;
    const brief = object(session.reviewedBrief);
    return (
      text(brief.intakeId) &&
      count(brief.revision) &&
      brief.revision > 0 &&
      text(brief.text) &&
      date(brief.approvedAt) &&
      Array.isArray(brief.answers) &&
      brief.answers.every((raw: unknown) => {
        const a = object(raw);
        return (
          text(a.id) &&
          text(a.question) &&
          text(a.answer) &&
          (a.source === 'user' || a.source === 'recommendation-accepted')
        );
      }) &&
      Array.isArray(brief.assumptions) &&
      brief.assumptions.every(text)
    );
  }
  if (event.type === 'design.updated') {
    const d = object(p.design);
    if (
      d.sessionId !== event.sessionId ||
      !count(d.revision) ||
      d.revision < 1 ||
      !['pending', 'ready', 'approved', 'failed', 'unavailable', 'cancelled'].includes(
        String(d.status),
      )
    )
      return false;
    if (d.status !== 'approved') return true;
    const decision = object(d.decision);
    if (!Array.isArray(d.rounds)) return false;
    const concepts = object(d.rounds.at(-1)).concepts;
    if (!Array.isArray(concepts)) return false;
    const ids = new Set(concepts.map((c: unknown) => object(c).id));
    return (
      decision.revision === d.revision &&
      text(decision.rationale) &&
      Array.isArray(decision.conceptIds) &&
      decision.conceptIds.length > 0 &&
      decision.conceptIds.length <= 3 &&
      decision.conceptIds.every((id: unknown) => text(id) && ids.has(id))
    );
  }
  if (event.type === 'ci.updated') {
    const c = object(p.checks);
    return (
      count(p.prNumber) &&
      p.prNumber > 0 &&
      count(c.total) &&
      count(c.passed) &&
      count(c.failed) &&
      count(c.pending) &&
      c.passed + c.failed + c.pending === c.total
    );
  }
  if (event.type === 'session.exited')
    return p.code === null || (typeof p.code === 'number' && Number.isSafeInteger(p.code));
  if (event.type === 'activity.changed')
    return ['starting', 'active', 'idle', 'waiting_input', 'blocked', 'exited', 'unknown'].includes(
      String(p.activity),
    );
  return true;
}

/** Only fixed summaries leave this projection; prompts, URLs and paths stay inert. */
export function summarize(events: Event[], partial: boolean): Journey {
  const result: Journey = {
    stages: { discovery: [], design: [], execution: [], handoff: [] },
    executionState: 'unknown',
    decisionNeeded: [],
    blockers: [],
    limits: ['Read-only observations; no current-head verification or budget guarantees.'],
  };
  const pending = new Set<string>();
  for (const event of events) {
    const p = event.payload;
    const add = (stage: Evidence['stage'], claim: string, assurance: Evidence['assurance']) => {
      result.stages[stage].push({ seq: event.seq, stage, claim, assurance });
    };
    if (event.type === 'session.created') {
      const brief = object(object(p.session).reviewedBrief);
      add('discovery', 'Session creation recorded', 'recorded');
      if (Array.isArray(brief.answers)) {
        const user = brief.answers.filter((a: unknown) => object(a).source === 'user').length;
        const recommendations = brief.answers.filter(
          (a: unknown) => object(a).source === 'recommendation-accepted',
        ).length;
        add(
          'discovery',
          `${user} user answers; ${recommendations} accepted recommendations recorded`,
          'accepted',
        );
      }
      if (Array.isArray(brief.assumptions) && brief.assumptions.length) {
        add(
          'discovery',
          `${brief.assumptions.length} assumptions remain distinct from confirmed answers`,
          'generated',
        );
      }
    }
    if (event.type === 'design.updated') {
      const design = object(p.design);
      const status = design.status;
      if (status !== 'ready') pending.delete('design');
      if (status === 'approved') {
        pending.delete('design');
        add(
          'design',
          'Design acceptance recorded; implementation verification remains separate',
          'accepted',
        );
      } else if (status === 'ready') {
        pending.add('design');
        add('design', 'Generated concepts await a decision', 'generated');
      } else if (status === 'failed' || status === 'unavailable') {
        result.blockers.push('Design unavailable or failed in observed history');
      }
      if (design.checkpoint)
        add('design', 'Preview checkpoint recorded; preview not opened or verified', 'generated');
    }
    if (event.type === 'plan.submitted') pending.add(`plan:${String(object(p.plan).id)}`);
    if (event.type === 'plan.approved' || event.type === 'plan.rejected')
      pending.delete(`plan:${String(p.planId)}`);
    if (event.type === 'approval.requested')
      pending.add(`approval:${String(object(p.approval).id)}`);
    if (event.type === 'approval.decided') {
      pending.delete(`approval:${String(p.approvalId)}`);
      add(
        'execution',
        'Approval decision recorded; inspect Helix for remaining requests',
        'recorded',
      );
    }
    if (event.type === 'session.started') {
      result.executionState = 'active';
      add('execution', 'Execution started', 'recorded');
    }
    if (event.type === 'activity.changed') result.executionState = String(p.activity);
    if (event.type === 'session.archived') result.executionState = 'archived';
    if (event.type === 'worktree.diff_updated')
      add('execution', 'Generated workspace changes recorded', 'generated');
    if (event.type === 'reasoning.summary')
      add('execution', 'Agent summary available; not verification evidence', 'generated');
    if (event.type === 'session.exited') {
      result.executionState = 'exited';
      add(
        'execution',
        p.code === 0
          ? 'Process exited successfully; task acceptance unknown'
          : 'Process exited without confirmed success',
        'recorded',
      );
      if (p.code !== 0) result.blockers.push('Process failure or unknown exit');
    }
    if (event.type === 'pr.opened' || event.type === 'pr.updated')
      add('handoff', 'Pull request facts recorded; current head not rechecked', 'recorded');
    if (event.type === 'ci.updated') {
      const c = object(p.checks);
      if (
        typeof c.total === 'number' &&
        c.total > 0 &&
        c.passed === c.total &&
        c.failed === 0 &&
        c.pending === 0
      ) {
        add('handoff', 'Passing CI reported in history; current revision not verified', 'verified');
      } else add('handoff', 'CI not confirmed passing in this observation', 'recorded');
    }
    if (event.type === 'pr.merged')
      add('handoff', 'Merge recorded in history; no deployment claim', 'accepted');
  }
  result.decisionNeeded = [...new Set([...pending].map((item) => item.split(':')[0]))].map(
    (item) => `Inspect ${item} decision in Helix; adapter cannot approve`,
  );
  if (!events.length) result.blockers.push('No session evidence available');
  if (partial)
    result.limits.push(
      'Bounded history is partial; pending decisions and blockers may have later resolutions.',
    );
  return result;
}
