import { fixtures, helixEventSchema, type HelixEvent } from '@helix/contracts';

/** Deterministic simulated events only. This scenario never launches jobs or contacts GitHub. */
export function denseDemoRun(): readonly HelixEvent[] {
  const events: HelixEvent[] = [];
  const projectId = 'proj_simulated_laptop';
  const orchestrator = 'sess_simulated_helix';
  const ts = (offset = events.length) =>
    new Date(Date.UTC(2026, 9, 1, 12, 0, offset)).toISOString();
  const add = (type: string, payload: unknown, sessionId?: string, planNodeId?: string) => {
    events.push(
      helixEventSchema.parse({
        v: 1,
        seq: events.length + 1,
        ts: ts(),
        projectId,
        type,
        payload,
        ...(sessionId ? { sessionId } : {}),
        ...(planNodeId ? { planNodeId } : {}),
      }),
    );
  };
  add('project.added', {
    project: {
      ...fixtures.passwordResetProject,
      id: projectId,
      name: 'SIMULATED · laptop workspace',
      repoPath: '/simulated/laptop',
      github: undefined,
    },
  });
  const session = (
    id: string,
    title: string,
    role: string,
    agent: string,
    parent?: string,
    node?: string,
  ) => ({
    id,
    projectId,
    title,
    prompt: 'Simulated UI acceptance scenario; no jobs are run.',
    role,
    agent,
    interface: 'chat',
    createdAt: ts(),
    ...(parent ? { parentSessionId: parent } : {}),
    ...(node ? { planNodeId: node } : {}),
  });
  add(
    'session.created',
    {
      session: session(
        orchestrator,
        'SIMULATED · 12-agent working window',
        'orchestrator',
        'claude-code',
      ),
    },
    orchestrator,
  );
  add('session.started', {}, orchestrator);
  add('activity.changed', { activity: 'active' }, orchestrator);
  const names = [
    'Authentication API',
    'Account settings',
    'Billing totals',
    'Search indexing',
    'Email approval',
    'Checkout tests',
    'Receipt rendering',
    'Stock reservation',
    'Shipping estimates',
    'Audit trail',
    'Accessibility checks',
    'Release notes',
  ];
  const nodes = names.map((title, i) => ({
    id: `node_simulated_${i}`,
    title,
    description: title,
    files: [`src/demo-${i}.ts`],
    acceptance: ['Simulated acceptance evidence'],
    dependsOn: i >= 8 ? [`node_simulated_${i - 6}`] : [],
    agent: i % 2 ? 'claude-code' : 'codex',
    rationale: 'Simulated parallel work for layout acceptance.',
    sessionId: `sess_simulated_${i}`,
  }));
  const planId = 'plan_simulated_laptop';
  add(
    'plan.submitted',
    {
      plan: {
        id: planId,
        projectId,
        orchestratorSessionId: orchestrator,
        goal: 'SIMULATED · inspect a dense working window',
        createdAt: ts(),
        nodes,
      },
    },
    orchestrator,
  );
  add('plan.approved', { planId, approvedBy: 'human' }, orchestrator);
  for (const [i, node] of nodes.entries()) {
    const sid = node.sessionId;
    add(
      'session.created',
      { session: session(sid, node.title, 'worker', node.agent, orchestrator, node.id) },
      sid,
      node.id,
    );
    if (i >= 8) continue;
    add('session.started', {}, sid, node.id);
    add('activity.changed', { activity: 'active' }, sid, node.id);
    if (i === 2 || i === 3) continue; // Parallel active workers.
    if (i === 4) {
      add(
        'approval.requested',
        {
          approval: {
            id: 'approval_simulated',
            sessionId: sid,
            kind: 'command',
            summary: 'SIMULATED · approve email preview',
            detail: 'No command will execute.',
            scope: 'once',
            requestedAt: ts(),
          },
        },
        sid,
        node.id,
      );
      add('activity.changed', { activity: 'waiting_input' }, sid, node.id);
      continue;
    }
    const number = 100 + i;
    const headSha = String(i + 1).repeat(40);
    add(
      'pr.opened',
      {
        pr: {
          number,
          url: `https://example.invalid/simulated/pull/${number}`,
          state: 'open',
          draft: false,
          headSha,
          mergeable: 'mergeable',
          checks: {
            total: 1,
            passed: i === 5 ? 0 : 1,
            failed: 0,
            pending: i === 5 ? 1 : 0,
            failingNames: [],
          },
          review: { decision: 'none', unresolvedThreads: 0 },
          updatedAt: ts(),
        },
      },
      sid,
      node.id,
    );
    add('activity.changed', { activity: 'idle' }, sid, node.id);
    if (i < 2) {
      add('pr.merged', { prNumber: number, mergeSha: headSha }, sid, node.id);
      add('session.exited', { code: 0 }, sid, node.id);
    } else if (i === 6 || i === 7) {
      const rid = `sess_simulated_reviewer_${i}`;
      add(
        'session.created',
        {
          session: session(
            rid,
            `Review ${node.title}`,
            'reviewer',
            node.agent === 'codex' ? 'claude-code' : 'codex',
            sid,
          ),
        },
        rid,
      );
      add('session.started', {}, rid);
      add('agent_review.requested', { workerSessionId: sid, prNumber: number, headSha }, rid);
      if (i === 6) {
        const sample = fixtures.crossReviewRun.find(
          (event) => event.type === 'agent_review.submitted',
        );
        if (sample?.type === 'agent_review.submitted')
          add(
            'agent_review.submitted',
            { workerSessionId: sid, prNumber: number, headSha, review: sample.payload.review },
            rid,
          );
      } else {
        add(
          'agent_review.abandoned',
          {
            workerSessionId: sid,
            prNumber: number,
            headSha,
            reason: 'SIMULATED · reviewer unavailable; no review verdict exists.',
          },
          rid,
        );
        add('session.exited', { code: 1 }, rid);
      }
    }
  }
  return events;
}

export const denseDemoEvents = denseDemoRun();
