import { expect, it, vi } from 'vitest';
import {
  applyEvent,
  boardColumn,
  createProjector,
  deriveStatus,
  eventSchemas,
  eventSeqSchema,
  fixtures,
  helixEventSchema,
  projectIdSchema,
  projectUpTo,
  sessionIdSchema,
  type HelixEvent,
  type ProjectState,
} from './index.js';

const { passwordResetRun: run, passwordResetIds: ids } = fixtures;
function summary(state: ProjectState) {
  return {
    lastSeq: state.lastSeq,
    sessions: Object.fromEntries(
      Object.entries(state.sessions).map(([id, s]) => [
        id,
        {
          status: deriveStatus(s),
          column: boardColumn(deriveStatus(s)),
          activity: s.activity,
          lastEventSeq: s.lastEventSeq,
          branch: s.session.branch,
          chat: s.chat,
          pendingApprovalIds: s.pendingApprovalIds,
          pr: s.pr,
          worktree: s.worktree,
        },
      ]),
    ),
    approvals: state.approvals,
    plans: Object.fromEntries(
      Object.entries(state.plans).map(([id, p]) => [
        id,
        { goal: p.goal, status: p.status, nodeStatus: p.nodeStatus },
      ]),
    ),
  };
}
it.each([22, 26, 37, 44])('snapshots projection at seq %i', (seq) =>
  expect(summary(projectUpTo(run, seq))).toMatchSnapshot(),
);
it('produces the expected final board and dependent node statuses', () => {
  const s = projectUpTo(run, 44);
  expect(deriveStatus(s.sessions[ids.api]!)).toBe('merged');
  expect(deriveStatus(s.sessions[ids.ui]!)).toBe('merged');
  expect(deriveStatus(s.sessions[ids.e2e]!)).toBe('working');
  expect(s.plans[fixtures.passwordResetPlan.id]!.nodeStatus).toEqual({
    [ids.apiNode]: 'merged',
    [ids.uiNode]: 'merged',
    [ids.e2eNode]: 'working',
  });
  expect(deriveStatus(projectUpTo(run, 22).sessions[ids.api]!)).toBe('ci_failed');
  expect(deriveStatus(projectUpTo(run, 24).sessions[ids.api]!)).toBe('working');
});
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
}
it('matches incremental live state at every replay cursor and is deterministic', () => {
  let live: ProjectState | undefined;
  for (const e of run) {
    live = applyEvent(live, e);
    expect(projectUpTo(run, e.seq)).toEqual(live);
  }
  expect(projectUpTo(run, 44)).toEqual(projectUpTo(run, 44));
  expect(projectUpTo([...run].reverse(), 44)).toEqual(live);
});
it('does not mutate events or prior states, including nested references', () => {
  const events = structuredClone(run);
  const original = structuredClone(events);
  freeze(events);
  const before = projectUpTo(events, 22);
  const beforeCopy = structuredClone(before);
  freeze(before);
  const after = applyEvent(before, events[22]!);
  after.sessions[ids.api]!.chat[0] = { kind: 'message', role: 'system', text: 'mutation' };
  after.plans[fixtures.passwordResetPlan.id]!.nodes[0]!.title = 'mutation';
  after.sessions[ids.api]!.pr!.checks.failingNames.push('mutation');
  expect(before).toEqual(beforeCopy);
  expect(events).toEqual(original);
});
it('handles exit, archive and terminal markers using event time and sequence', () => {
  let s = projectUpTo(run, 9);
  for (const [seq, type, payload] of [
    [10, 'terminal.output_marker', { bytesOffset: 4 }],
    [11, 'session.exited', { code: null }],
    [12, 'session.archived', {}],
  ] as const) {
    const e = helixEventSchema.parse({ ...run[8], seq, type, payload, ts: '2026-10-01T10:00:00Z' });
    s = applyEvent(s, e);
  }
  expect(s.sessions[ids.e2e]!.activity).toBe('exited');
  expect(s.sessions[ids.e2e]!.session.archivedAt).toBe('2026-10-01T10:00:00Z');
  expect(s.sessions[ids.e2e]!.lastEventSeq).toBe(12);
  expect(deriveStatus(s.sessions[ids.e2e]!)).toBe('archived');
});
it('does not confuse merge commit with PR head', () => {
  expect(projectUpTo(run, 38).sessions[ids.api]!.pr!.headSha).toBe(
    projectUpTo(run, 37).sessions[ids.api]!.pr!.headSha,
  );
});
it('rejects incomplete history, duplicates, reversed application and mixed projects', () => {
  expect(() => projectUpTo([], 0)).toThrow('No project.added');
  expect(() => projectUpTo(run, 0)).toThrow('No project.added');
  expect(() => projectUpTo(run, NaN)).toThrow('cursor');
  expect(() => applyEvent(undefined, run[1]!)).toThrow('project.added');
  const s = projectUpTo(run, 9);
  expect(() => applyEvent(s, run[8]!, { strict: true })).toThrow('increase');
  expect(() => applyEvent(s, { ...run[9]!, projectId: projectIdSchema.parse('foreign') })).toThrow(
    'mix projects',
  );
  expect(() => projectUpTo([run[0]!, run[2]!], 3, { strict: true })).toThrow('session');
  expect(() => applyEvent(s, { ...run[9]!, sessionId: undefined }, { strict: true })).toThrow(
    'session',
  );
});
it('supports daemon sequence gaps and idempotently reads the same cursor', () => {
  const events: HelixEvent[] = run.map((e) => ({ ...e, seq: eventSeqSchema.parse(e.seq * 10) }));
  expect(projectUpTo(events, 440).lastSeq).toBe(440);
  expect(projectUpTo(events, 439)).toEqual(projectUpTo(events, 430));
});
it('clears a decided approval but leaves explicit activity unchanged', () => {
  const s = projectUpTo(run, 26).sessions[ids.ui]!;
  expect(s.pendingApprovalIds).toEqual([]);
  expect(s.activity).toBe('waiting_input');
  expect(deriveStatus(s)).toBe('needs_you');
  expect(deriveStatus(projectUpTo(run, 27).sessions[ids.ui]!)).toBe('working');
});

function syntheticRun(count: number): HelixEvent[] {
  const events = [...run];
  for (let seq = events.length + 1; seq <= count; seq++) {
    const envelope = {
      seq: eventSeqSchema.parse(seq),
      ts: '2026-10-01T10:00:00Z',
      projectId: fixtures.passwordResetProject.id,
      sessionId: ids.e2e,
      v: 1 as const,
    };
    events.push(
      seq % 5 === 0
        ? {
            ...envelope,
            type: 'activity.changed',
            payload: { activity: seq % 10 === 0 ? 'active' : 'idle' },
          }
        : {
            ...envelope,
            type: 'chat.item',
            payload: {
              item: {
                kind: 'message',
                role: 'assistant',
                text: `Step ${seq}: verify reset-token expiry and single-use behavior through the browser, then inspect the mailbox delivery and report the regression results.`,
              },
            },
          },
    );
  }
  return events;
}

it('matches full replay around checkpoint edges, gaps, and out-of-order lookups', () => {
  const events = syntheticRun(350).map((e) => ({ ...e, seq: eventSeqSchema.parse(e.seq * 3) }));
  const projector = createProjector([...events].reverse());
  for (const seq of [1050, 300, 303, 297, 299, 600, 601, 603, 3, 132, 900, 9999]) {
    expect(projector.at(seq)).toEqual(projectUpTo(events, seq));
  }
  expect(projector.at(300)).toBe(projector.at(300));
  expect(projector.at(302)).toBe(projector.at(300));
  expect(() => projector.at(2)).toThrow('No project.added');
  expect(() => projector.at(NaN)).toThrow('cursor');
  expect(() => createProjector([]).at(0)).toThrow('No project.added');
});

it('holds deeply frozen snapshots safely and detaches from caller-owned history', () => {
  const events = syntheticRun(250);
  const projector = createProjector(events);
  const earlier = projector.at(100);
  const expected = structuredClone(earlier);
  const later = projector.at(101);
  expect(earlier.sessions[ids.e2e]!.chat[0]).toBe(later.sessions[ids.e2e]!.chat[0]);
  expect(Object.isFrozen(earlier)).toBe(true);
  expect(Object.isFrozen(earlier.sessions[ids.e2e]!.chat[0])).toBe(true);
  expect(() => {
    earlier.sessions[ids.e2e]!.chat.push({ kind: 'message', role: 'user', text: 'mutate' });
  }).toThrow();
  expect(() => {
    earlier.plans[fixtures.passwordResetPlan.id]!.nodes[0]!.title = 'mutate';
  }).toThrow();
  events.splice(0, events.length);
  projector.at(250);
  expect(earlier).toEqual(expected);
  expect(projector.at(100)).toEqual(expected);
});

it('folds full history without cloning the growing ProjectState', () => {
  const clone = vi.spyOn(globalThis, 'structuredClone');
  try {
    projectUpTo(syntheticRun(500), 500);
    const statesCloned = clone.mock.calls.filter(
      ([value]: [unknown, ...unknown[]]) =>
        value !== null && typeof value === 'object' && 'sessions' in value,
    );
    expect(statesCloned).toHaveLength(0);
  } finally {
    clone.mockRestore();
  }
});

it('scrubs 5,000 events at 200 seeded random cursors in under 1 second', () => {
  const events = syntheticRun(5000);
  let seed = 20261020;
  const cursors = Array.from({ length: 200 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed % 5000) + 1;
  });
  const buildStart = performance.now();
  const projector = createProjector(events);
  const buildMs = performance.now() - buildStart;
  const start = performance.now();
  const states = cursors.map((seq) => projector.at(seq));
  const lookupMs = performance.now() - start;
  console.info(
    `Projector perf: 5000 events; build=${buildMs.toFixed(2)}ms; 200 lookups=${lookupMs.toFixed(2)}ms`,
  );
  expect(lookupMs).toBeLessThan(1000);
  expect(states.map((s) => s.lastSeq)).toEqual(cursors);
  expect(states[0]).toEqual(projectUpTo(events, cursors[0]!));
});

it('records an unknown session and continues with the next valid event by default', () => {
  const before = projectUpTo(run, 9);
  const bad = {
    ...run[13]!,
    seq: eventSeqSchema.parse(10),
    sessionId: sessionIdSchema.parse('missing'),
  };
  const skipped = applyEvent(before, bad);
  expect(skipped.sessions).toEqual(before.sessions);
  expect(skipped.lastSeq).toBe(10);
  expect(skipped.anomalies).toEqual([
    { seq: 10, type: 'activity.changed', reason: 'Unknown or missing session: missing' },
  ]);
  expect(before.anomalies).toEqual([]);
  const recovered = applyEvent(skipped, { ...run[13]!, seq: eventSeqSchema.parse(11) });
  expect(recovered.sessions[ids.api]!.activity).toBe('active');
  expect(recovered.anomalies).toEqual(skipped.anomalies);
  expect(() => applyEvent(before, bad, { strict: true })).toThrow('missing');
});

it('skips unknown approvals, PR mismatches and malformed payloads', () => {
  const initial = projectUpTo(run, 20);
  const badEvents = [
    helixEventSchema.parse({
      ...run[25],
      seq: 21,
      payload: { approvalId: 'missing', decision: 'approved' },
    }),
    helixEventSchema.parse({
      ...run[21],
      seq: 22,
      payload: { ...run[21]!.payload, prNumber: 999 },
    }),
    { ...run[13], seq: 23, payload: { activity: 'dead' } } as unknown as HelixEvent,
  ];
  let state = initial;
  for (const e of badEvents) {
    expect(() => applyEvent(initial, e, { strict: true })).toThrow();
    state = applyEvent(state, e);
  }
  expect(state.sessions).toEqual(initial.sessions);
  expect(state.approvals).toEqual(initial.approvals);
  expect(state.anomalies.map((a) => a.seq)).toEqual([21, 22, 23]);
  expect(state.anomalies[0]!.reason).toBe('Unknown approval');
  expect(state.anomalies[1]!.reason).toBe('PR update requires matching PR');
});

it('validates every reference before mutating plans or their session links', () => {
  const before = projectUpTo(run, 9);
  const submission = helixEventSchema.parse({
    ...run[4],
    seq: 10,
    payload: {
      plan: { ...fixtures.passwordResetPlan, id: 'plan_bad', orchestratorSessionId: 'missing' },
    },
  });
  const skipped = applyEvent(before, submission);
  expect(skipped.plans).toEqual(before.plans);
  expect(skipped.sessions).toEqual(before.sessions);
  const update = helixEventSchema.parse({
    ...run[39],
    seq: 11,
    sessionId: 'missing',
    payload: {
      nodeId: ids.e2eNode,
      sessionId: ids.api,
      note: 'Must not partially reassign the node',
    },
  });
  const after = applyEvent(skipped, update);
  expect(after.plans).toEqual(before.plans);
  expect(after.sessions).toEqual(before.sessions);
  expect(after.anomalies).toHaveLength(2);
});

it('caps anomaly history at the newest 100 and agrees across checkpoints', () => {
  const badEvents = Array.from({ length: 120 }, (_, i) => ({
    ...run[13]!,
    seq: eventSeqSchema.parse(10 + i),
    sessionId: sessionIdSchema.parse('missing'),
  }));
  const events = [...run.slice(0, 9), ...badEvents];
  const state = projectUpTo(events, 129);
  expect(state.lastSeq).toBe(129);
  expect(state.anomalies).toHaveLength(100);
  expect(state.anomalies[0]!.seq).toBe(30);
  expect(state.anomalies.at(-1)!.seq).toBe(129);
  expect(createProjector(events).at(129)).toEqual(state);
  expect(() => createProjector(events, { strict: true })).toThrow('missing');
});

it('records duplicate and reversed events without moving lastSeq backward', () => {
  const state = projectUpTo(run, 9);
  const duplicate = applyEvent(state, run[8]!);
  const reversed = applyEvent(duplicate, run[7]!);
  expect(reversed.lastSeq).toBe(9);
  expect(reversed.sessions).toEqual(state.sessions);
  expect(reversed.anomalies.map((a) => a.seq)).toEqual([9, 8]);
});

it.each([false, true])('always rejects project identity errors (strict=%s)', (strict) => {
  const state = projectUpTo(run, 9);
  expect(() =>
    applyEvent(state, { ...run[9]!, projectId: projectIdSchema.parse('foreign') }, { strict }),
  ).toThrow('mix projects');
  const mismatch = helixEventSchema.parse({
    ...run[0],
    seq: 10,
    payload: { project: { ...fixtures.passwordResetProject, id: 'foreign' } },
  });
  expect(() => applyEvent(undefined, mismatch, { strict })).toThrow('matching project.added');
  expect(() => applyEvent(state, mismatch, { strict })).toThrow('matching project.added');
});

it('attaches sessionless explain notes to the node plan orchestrator', () => {
  const note = eventSchemas['explain.note'].parse({ ...run[43], sessionId: undefined });
  const before = projectUpTo(run, 43);
  const after = applyEvent(before, note);
  expect(after.sessions[ids.orchestrator]!.chat.at(-1)).toEqual({
    kind: 'plan_update',
    planId: fixtures.passwordResetPlan.id,
    nodeId: ids.e2eNode,
    text: note.payload.text,
  });
  expect(after.sessions[ids.orchestrator]!.lastEventSeq).toBe(44);
  expect(after.anomalies).toEqual([]);
  expect(createProjector([...run.slice(0, 43), note]).at(44)).toEqual(after);
});
