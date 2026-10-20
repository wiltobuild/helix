import { expect, it } from 'vitest';
import { applyEvent, boardColumn, deriveStatus, eventSeqSchema, fixtures, helixEventSchema, projectIdSchema, projectUpTo, type HelixEvent, type ProjectState } from '../src/index.js';

const { passwordResetRun: run, passwordResetIds: ids } = fixtures;
function summary(state: ProjectState) {
  return {
    lastSeq: state.lastSeq,
    sessions: Object.fromEntries(Object.entries(state.sessions).map(([id, s]) => [id, {
      status: deriveStatus(s), column: boardColumn(deriveStatus(s)), activity: s.activity,
      lastEventSeq: s.lastEventSeq, branch: s.session.branch, chat: s.chat,
      pendingApprovalIds: s.pendingApprovalIds, pr: s.pr, worktree: s.worktree,
    }])),
    approvals: state.approvals,
    plans: Object.fromEntries(Object.entries(state.plans).map(([id, p]) => [id, { goal: p.goal, nodeStatus: p.nodeStatus }])),
  };
}
it.each([22, 26, 37, 44])('snapshots projection at seq %i', (seq) => expect(summary(projectUpTo(run, seq))).toMatchSnapshot());
it('produces the expected final board and dependent node statuses', () => {
  const s = projectUpTo(run, 44);
  expect(deriveStatus(s.sessions[ids.api]!)).toBe('merged');
  expect(deriveStatus(s.sessions[ids.ui]!)).toBe('merged');
  expect(deriveStatus(s.sessions[ids.e2e]!)).toBe('working');
  expect(s.plans[fixtures.passwordResetPlan.id]!.nodeStatus).toEqual({ [ids.apiNode]: 'merged', [ids.uiNode]: 'merged', [ids.e2eNode]: 'working' });
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
  for (const [seq, type, payload] of [[10, 'terminal.output_marker', { bytesOffset: 4 }], [11, 'session.exited', { code: null }], [12, 'session.archived', {}]] as const) {
    const e = helixEventSchema.parse({ ...run[8], seq, type, payload, ts: '2026-10-01T10:00:00Z' });
    s = applyEvent(s, e);
  }
  expect(s.sessions[ids.e2e]!.activity).toBe('exited');
  expect(s.sessions[ids.e2e]!.session.archivedAt).toBe('2026-10-01T10:00:00Z');
  expect(s.sessions[ids.e2e]!.lastEventSeq).toBe(12);
  expect(deriveStatus(s.sessions[ids.e2e]!)).toBe('archived');
});
it('does not confuse merge commit with PR head', () => {
  expect(projectUpTo(run, 38).sessions[ids.api]!.pr!.headSha).toBe(projectUpTo(run, 37).sessions[ids.api]!.pr!.headSha);
});
it('rejects incomplete history, duplicates, reversed application and mixed projects', () => {
  expect(() => projectUpTo([], 0)).toThrow('No project.added');
  expect(() => projectUpTo(run, 0)).toThrow('No project.added');
  expect(() => projectUpTo(run, NaN)).toThrow('cursor');
  expect(() => applyEvent(undefined, run[1]!)).toThrow('project.added');
  const s = projectUpTo(run, 9);
  expect(() => applyEvent(s, run[8]!)).toThrow('increase');
  expect(() => applyEvent(s, { ...run[9]!, projectId: projectIdSchema.parse('foreign') })).toThrow('mix projects');
  expect(() => projectUpTo([run[0]!, run[2]!], 3)).toThrow('session');
  expect(() => applyEvent(s, { ...run[9]!, sessionId: undefined })).toThrow('session');
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
