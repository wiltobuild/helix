import { expect, test } from 'vitest';
import { deriveStatus, fixtures, helixEventSchema, projectUpTo } from '@helix/contracts';
import {
  boardCards,
  describeEvent,
  eventTone,
  projectAttention,
  provenance,
  slotWaitNote,
  slotWaiting,
  statusLine,
  turnLimitNote,
} from './describe';

const { passwordResetRun: run, passwordResetIds: ids, passwordResetPlan: plan } = fixtures;
const state = () => projectUpTo(run, 44);

test('turn-cap detection follows the flag even when wording and activity change', () => {
  const project = state();
  const session = project.sessions[ids.api]!;
  session.turnLimited = true;
  session.activity = 'unknown';
  session.chat = [{ kind: 'message', role: 'system', text: 'The task used its allowance.' }];
  expect(statusLine(session, 'needs_you', project)).toBe(
    'Turn limit reached · send a message to continue',
  );
  expect(turnLimitNote(session)).toBeUndefined();
});

test('current-project attention points to an awaiting plan or command decision', () => {
  const awaitingPlan = projectUpTo(run, 5);
  expect(projectAttention(awaitingPlan, run.slice(0, 5))).toEqual({
    sessionId: ids.orchestrator,
    tab: 'summary',
    reason: 'Plan needs your approval',
    nextAction: 'Open plan to approve or request changes',
  });

  const awaitingCommand = projectUpTo(run, 17);
  expect(projectAttention(awaitingCommand, run.slice(0, 17))).toEqual({
    sessionId: ids.ui,
    tab: 'summary',
    reason: 'A command needs your decision',
    nextAction: 'Open task to approve, reject, or request changes',
  });
});

test('current-project attention distinguishes CI wait, failed checks, and a stopped reviewer', () => {
  const events = fixtures.crossReviewRun;
  const workerId = fixtures.crossReviewIds.worker;
  const pending = projectUpTo(events, 7);
  expect(projectAttention(pending, events.slice(0, 7))).toEqual({
    sessionId: workerId,
    tab: 'pr',
    reason: 'Waiting for CI',
    nextAction: 'Checks are running · open PR & CI',
  });

  const failed = projectUpTo(events, 7);
  const worker = failed.sessions[workerId]!;
  worker.pr!.checks = { total: 1, passed: 0, failed: 1, pending: 0, failingNames: ['tests'] };
  expect(projectAttention(failed, events.slice(0, 7))).toEqual({
    sessionId: workerId,
    tab: 'pr',
    reason: 'CI failed',
    nextAction: 'Open PR & CI to see the failing check',
  });

  const reviewed = projectUpTo(events, fixtures.crossReviewMilestones.approved);
  const reviewedWorker = reviewed.sessions[workerId]!;
  reviewedWorker.pr!.state = 'open';
  reviewedWorker.pr!.draft = false;
  delete reviewedWorker.agentReview;
  const stopped = helixEventSchema.parse({
    v: 1,
    seq: events.length + 1,
    ts: events.at(-1)!.ts,
    projectId: reviewed.project.id,
    sessionId: fixtures.crossReviewIds.reviewer,
    type: 'agent_review.abandoned',
    payload: {
      workerSessionId: workerId,
      prNumber: reviewedWorker.pr!.number,
      headSha: reviewedWorker.pr!.headSha,
      reason: 'Reviewer unavailable',
    },
  });
  expect(projectAttention(reviewed, [...events, stopped])?.reason).not.toBe(
    'Reviewer stopped without a verdict',
  );
  reviewed.lastSeq = stopped.seq;
  expect(projectAttention(reviewed, [...events, stopped])).toEqual({
    sessionId: workerId,
    tab: 'review',
    reason: 'Reviewer stopped without a verdict',
    nextAction: 'Open Review: Reviewer unavailable',
  });
  expect(deriveStatus(reviewedWorker)).toBe('ready_to_merge');
  expect(statusLine(reviewedWorker, 'ready_to_merge', reviewed, 'Reviewer unavailable')).toBe(
    'Reviewer stopped: Reviewer unavailable · open Review',
  );
});

test('acceptance failure feedback names the correction and rerun step', () => {
  const events = fixtures.crossReviewRun;
  const feedback = events.find((e) => e.type === 'feedback.routed');
  expect(feedback?.type).toBe('feedback.routed');
  if (feedback?.type !== 'feedback.routed') return;
  const acceptance = helixEventSchema.parse({
    ...feedback,
    payload: { ...feedback.payload, reason: 'acceptance_failed' },
  });
  const project = projectUpTo(events, fixtures.crossReviewMilestones.routed);
  expect(describeEvent(acceptance, project)).toContain('failed acceptance checks');
  expect(describeEvent(acceptance, project)).toContain('correct the work and rerun them');
});

test('same-head acceptance failure stays visible even when CI and GitHub review are green', () => {
  const project = projectUpTo(fixtures.crossReviewRun, fixtures.crossReviewMilestones.approved);
  const worker = project.sessions[fixtures.crossReviewIds.worker]!;
  worker.pr!.state = 'open';
  worker.pr!.draft = false;
  delete worker.agentReview;
  worker.acceptanceFailedHeads = [worker.pr!.headSha];
  expect(deriveStatus(worker)).toBe('changes_requested');
  expect(projectAttention(project, fixtures.crossReviewRun)).toMatchObject({
    sessionId: worker.session.id,
    reason: 'Exact file check failed',
    tab: 'activity',
  });
  expect(statusLine(worker, 'changes_requested', project)).toContain('correcting before review');
});

test('limit-note text is display-only and finds the latest matching system message', () => {
  const session = state().sessions[ids.api]!;
  session.chat = [
    { kind: 'message', role: 'system', text: 'Turn limit reached (20 turns).' },
    { kind: 'message', role: 'system', text: 'Turn limit reached (40 turns).' },
    { kind: 'message', role: 'assistant', text: 'Turn limit reached (60 turns).' },
  ];
  expect(turnLimitNote(session)).toBeUndefined();
  session.turnLimited = true;
  expect(turnLimitNote(session)).toBe('Turn limit reached (40 turns).');
});

function waitingState() {
  const project = state();
  const projectedPlan = project.plans[plan.id]!;
  delete projectedPlan.nodes[0]!.sessionId;
  projectedPlan.waitingNodes[ids.apiNode] = 'worker_slot';
  project.sessions[ids.orchestrator]!.chat = [
    {
      kind: 'plan_update',
      planId: plan.id,
      nodeId: ids.apiNode,
      text: 'New capacity wording.',
    },
  ];
  return project;
}

test('slot detection follows the waiting map and retains human-readable notes', () => {
  const project = waitingState();
  expect(slotWaitNote(project, ids.apiNode)).toBe('New capacity wording.');
  expect(slotWaiting(project)).toEqual([{ nodeId: ids.apiNode, note: 'New capacity wording.' }]);
  project.plans[plan.id]!.waitingNodes = {};
  project.sessions[ids.orchestrator]!.chat = [
    {
      kind: 'plan_update',
      planId: plan.id,
      nodeId: ids.apiNode,
      text: 'Waiting: 3 of 3 worker slots are in use.',
    },
  ];
  expect(slotWaitNote(project, ids.apiNode)).toBeUndefined();
  expect(slotWaiting(project)).toEqual([]);
});

test('slot detection works without note text and clears for assigned workers', () => {
  const project = waitingState();
  project.sessions[ids.orchestrator]!.chat = [];
  expect(slotWaitNote(project, ids.apiNode)).toBe('Waiting for a worker slot');
  project.plans[plan.id]!.nodes[0]!.sessionId = ids.api;
  expect(slotWaitNote(project, ids.apiNode)).toBeUndefined();
  expect(slotWaiting(project)).toEqual([]);
});

test('paused scheduling replaces worker-slot wording', () => {
  const project = waitingState();
  project.schedulingPaused = true;
  expect(slotWaitNote(project, ids.apiNode)).toBe('Paused: scheduling is stopped');
  expect(slotWaiting(project)).toEqual([
    { nodeId: ids.apiNode, note: 'Paused: scheduling is stopped' },
  ]);
});

test.each([true, false])(
  'describes project scheduling changes with Helix provenance (paused=%s)',
  (paused) => {
    const project = state();
    const event = helixEventSchema.parse({
      v: 1,
      seq: 45,
      ts: run[0]!.ts,
      projectId: project.project.id,
      type: 'scheduling.changed',
      payload: { paused },
    });
    expect(describeEvent(event, project)).toBe(
      paused ? 'You stopped all agents; scheduling is paused.' : 'Scheduling resumed.',
    );
    expect(eventTone(event)).toBe(paused ? 'needs' : 'work');
    expect(provenance(event, project)).toBe('helix');
  },
);

test('statusLine distinguishes starting, thinking, running tools, and idle states', () => {
  const project = state();
  const session = project.sessions[ids.api]!;

  session.activity = 'starting';
  session.chat = [];
  expect(statusLine(session, 'working', project)).toBe('Starting up');

  session.activity = 'active';
  expect(statusLine(session, 'working', project)).toBe('Thinking');

  session.chat.push({
    kind: 'reasoning_summary',
    text: 'Checking token expiration boundary conditions',
  });
  expect(statusLine(session, 'working', project)).toBe(
    'Thinking · Checking token expiration bound…',
  );

  session.chat.push({
    kind: 'tool_call',
    tool: 'shell',
    inputSummary: 'pnpm vitest run token.test.ts',
    status: 'running',
  });
  expect(statusLine(session, 'working', project)).toBe('Running · pnpm vitest run token.test.ts');

  session.chat.push({
    kind: 'tool_call',
    tool: 'shell',
    inputSummary: 'pnpm vitest run token.test.ts',
    status: 'succeeded',
  });
  expect(statusLine(session, 'working', project)).toBe('pnpm vitest run token.test.ts');

  session.activity = 'idle';
  delete session.session.planNodeId;
  expect(statusLine(session, 'pending', project)).toBe('Idle · turn complete');
  expect(statusLine(session, 'exited', project)).toBe('Worker stopped · open Activity for details');
});

test('boardCards surfaces the orchestrator while planning or awaiting review', () => {
  const bySeq = new Map(run.map((e) => [e.seq, e]));
  const nowIso = run.at(-1)!.ts;

  // At seq 5, plan is submitted and awaiting approval -> orchestrator appears under needs_you
  const awaitingState = projectUpTo(run, 5);
  const awaitingCards = boardCards(awaitingState, bySeq, nowIso);
  const orchCard = awaitingCards.find((c) => c.id === ids.orchestrator);
  expect(orchCard).toBeDefined();
  expect(orchCard?.column).toBe('needs_you');
  expect(orchCard?.card.statusLabel).toBe('Approve plan · 3 tasks · open to review');

  // Once approved and workers are delegated (seq 44), orchestrator steps off the board unless it needs attention
  const finalState = state();
  expect(
    boardCards(finalState, bySeq, nowIso).find((c) => c.id === ids.orchestrator),
  ).toBeUndefined();

  // If the orchestrator hits a turn limit or requests input, it reappears under needs_you
  finalState.sessions[ids.orchestrator]!.turnLimited = true;
  finalState.sessions[ids.orchestrator]!.activity = 'waiting_input';
  const blockedOrch = boardCards(finalState, bySeq, nowIso).find((c) => c.id === ids.orchestrator);
  expect(blockedOrch?.column).toBe('needs_you');
});
