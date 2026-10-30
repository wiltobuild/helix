import { expect, test } from 'vitest';
import { fixtures, projectUpTo, type ProjectState, type SessionState } from '@helix/contracts';
import {
  approvedText,
  deriveRoleName,
  identityFor,
  resolveIdentities,
  reviewerName,
} from './identity';

const { passwordResetRun, passwordResetIds: ids } = fixtures;
const { crossReviewRun, crossReviewIds, crossReviewMilestones } = fixtures;

test('names are derived honestly as "<Domain> <Craft>" from the task text', () => {
  expect(deriveRoleName('Catalog API').name).toBe('Catalog Architect');
  expect(deriveRoleName('Integration').name).toBe('Integration Engineer');
  expect(deriveRoleName('Password reset API').name).toBe('Password Reset Architect');
  expect(deriveRoleName('Build accessible password reset forms').name).toBe(
    'Password Reset Designer',
  );
  expect(deriveRoleName('Design the storefront').name).toBe('Storefront Designer');
  expect(deriveRoleName('Cover the checkout journey in Playwright').name).toBe('Checkout Tester');
  expect(deriveRoleName('Add discount codes').name).toBe('Discount Codes Engineer');
  // Every word in the name comes from the task text or the fixed craft palette — nothing invented.
  const { name } = deriveRoleName('Product catalog schema and seeding');
  expect(name).toBe('Product Catalog Architect');
});

test('derivation is deterministic: identical text always yields the identical name', () => {
  const text = 'Build accessible password reset forms';
  expect(deriveRoleName(text)).toEqual(deriveRoleName(text));
});

test('falls back deterministically when the task text has no usable topic', () => {
  expect(deriveRoleName('the and of')).toEqual({ name: 'Agent', fromTask: false });
  expect(deriveRoleName('')).toEqual({ name: 'Agent', fromTask: false });
  // A craft word with no domain still names honestly by craft, not a generic fallback.
  expect(deriveRoleName('write the docs')).toEqual({ name: 'Scribe', fromTask: true });
});

/** A bare ProjectState carrying only the sessions resolveIdentities reads. */
function stateOf(sessions: SessionState[]): ProjectState {
  return {
    sessions: Object.fromEntries(sessions.map((s) => [s.session.id, s])),
    plans: {},
  } as unknown as ProjectState;
}

function worker(id: string, title: string, createdAt: string, agent = 'codex'): SessionState {
  return {
    session: {
      id,
      projectId: 'proj_test',
      role: 'worker',
      agent,
      title,
      prompt: title,
      interface: 'chat',
      createdAt,
    },
    activity: 'idle',
    turnLimited: false,
    chat: [],
    lastEventSeq: 0,
    pendingApprovalIds: [],
  } as unknown as SessionState;
}

test('collisions follow incremental log insertion, even for equal or backdated timestamps', () => {
  const first = worker('sess_z', 'Catalog schema', '2026-10-01T09:04:00.000Z');
  for (const createdAt of [first.session.createdAt, '2026-09-01T00:00:00.000Z']) {
    const later = worker('sess_a', 'Catalog API', createdAt);
    expect(identityFor(stateOf([first]), 'sess_z')?.name).toBe('Catalog Architect');
    const replay = resolveIdentities(stateOf([first, later]));
    expect(replay.get('sess_z')?.name).toBe('Catalog Architect');
    expect(replay.get('sess_a')?.name).toBe('Catalog Architect 2');
  }
});

test('identity is stable across live activity, provider and model changes', () => {
  const base = worker('sess_live', 'Password reset API', '2026-10-01T09:04:00.000Z', 'codex');
  const before = identityFor(stateOf([base]), 'sess_live')!;

  const moved = worker(
    'sess_live',
    'Password reset API',
    '2026-10-01T09:04:00.000Z',
    'claude-code',
  );
  moved.activity = 'active';
  moved.turnLimited = true;
  moved.session.model = 'some-model-v9';
  const after = identityFor(stateOf([moved]), 'sess_live')!;

  // The display name is the task's; only the secondary provider/model follow the reassignment.
  expect(after.name).toBe(before.name);
  expect(after.agent).toBe('claude-code');
  expect(after.model).toBe('some-model-v9');
});

test('identity is stable across replay: the same session reads the same at any cursor', () => {
  const early = projectUpTo(passwordResetRun, 20);
  const late = projectUpTo(passwordResetRun, 44);
  expect(identityFor(early, ids.api)?.name).toBe('Password Reset Architect');
  expect(identityFor(late, ids.api)?.name).toBe('Password Reset Architect');
  // Plan-derived names cover every delegated worker in the run.
  expect(identityFor(late, ids.ui)?.name).toBe('Password Reset Designer');
  expect(identityFor(late, ids.e2e)?.name).toBe('Password Reset Tester');
});

test('the orchestrator is always named Helix, with internal IDs kept for tracing', () => {
  const state = projectUpTo(passwordResetRun, 44);
  const orchestrator = identityFor(state, ids.orchestrator)!;
  expect(orchestrator.name).toBe('Helix');
  expect(orchestrator.role).toBe('orchestrator');
  // Original IDs are carried on the identity, never renamed.
  const api = identityFor(state, ids.api)!;
  expect(api.sessionId).toBe(ids.api);
  expect(api.planNodeId).toBe(ids.apiNode);
  expect(api.taskTitle).toBe('Implement secure password reset endpoints');
});

test('derives from the approved plan task, not the raw session title, when planned', () => {
  const state = projectUpTo(passwordResetRun, 44);
  // The session title is a sentence; the approved plan node title is the task of record.
  expect(approvedText(state.sessions[ids.api]!, state)).toBe('Password reset API');
});

test('a reviewer reads clearly distinct from the author it reviews', () => {
  const state = projectUpTo(crossReviewRun, crossReviewMilestones.approved, { strict: true });
  const author = identityFor(state, crossReviewIds.worker)!;
  const reviewer = identityFor(state, crossReviewIds.reviewer)!;

  expect(author.role).toBe('author');
  expect(author.name).toBe('Discount Codes Engineer');
  expect(reviewer.role).toBe('reviewer');
  expect(reviewer.name).toBe('Discount Codes Reviewer');
  expect(reviewer.name).not.toBe(author.name);
  // The reviewer shares the author's domain but never its craft.
  expect(reviewerName('Add discount codes').name).toBe('Discount Codes Reviewer');
});
