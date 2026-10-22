import { describe, expect, test } from 'vitest';
import { normalizeChecks, normalizeMergeable, normalizeReviews } from './normalize.js';

describe('check normalization', () => {
  test.each(['success', 'neutral', 'skipped'])('%s passes', (conclusion) => {
    expect(normalizeChecks([{ id: 1, name: 'build', status: 'completed', conclusion }])).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      failingNames: [],
    });
  });
  test.each(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'])(
    '%s fails',
    (conclusion) => {
      expect(normalizeChecks([{ id: 1, name: 'build', status: 'completed', conclusion }])).toEqual({
        total: 1,
        passed: 0,
        failed: 1,
        pending: 0,
        failingNames: ['build'],
      });
    },
  );
  test.each(['queued', 'in_progress', 'pending', 'waiting', 'requested', 'unknown'])(
    '%s stays pending',
    (status) => {
      expect(normalizeChecks([{ id: 1, name: 'build', status, conclusion: null }]).pending).toBe(1);
    },
  );
  test('deduplicates reruns by start, not completion, and sorts failing names', () => {
    expect(
      normalizeChecks(
        [
          {
            id: 1,
            name: 'build',
            status: 'completed',
            conclusion: 'failure',
            started_at: '2026-01-01',
            completed_at: '2026-01-04',
          },
          {
            id: 2,
            name: 'build',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-01-02',
            completed_at: '2026-01-03',
          },
        ],
        [
          { id: 5, context: 'z', state: 'error' },
          { id: 4, context: 'a', state: 'failure' },
          { id: 3, context: 'a', state: 'success' },
        ],
      ),
    ).toEqual({ total: 3, passed: 1, failed: 2, pending: 0, failingNames: ['a', 'z'] });
  });
  test('completed with no conclusion stays pending', () => {
    expect(
      normalizeChecks([{ id: 1, name: 'build', status: 'completed', conclusion: null }]).pending,
    ).toBe(1);
  });
});
describe('reviews', () => {
  test.each([
    [[], false, 'none'],
    [['APPROVED'], false, 'approved'],
    [['APPROVED', 'CHANGES_REQUESTED'], false, 'changes_requested'],
    [['APPROVED'], true, 'review_required'],
    [[], true, 'review_required'],
    [['COMMENTED'], false, 'none'],
    [['CHANGES_REQUESTED'], true, 'changes_requested'],
  ] as const)('normalizes %j with required pending=%s', (states, pending, decision) => {
    expect(
      normalizeReviews(
        states.map((state, id) => ({ id, state, user: { login: String(id) } })),
        3,
        pending,
      ),
    ).toEqual({ decision, unresolvedThreads: 3 });
  });
  test('latest submitted review wins; drafts and deleted reviewers are ignored', () => {
    expect(
      normalizeReviews([
        { id: 4, user: { login: 'Ada' }, state: 'PENDING' },
        { id: 3, user: { login: 'ada' }, state: 'APPROVED' },
        { id: 2, user: { login: 'ada' }, state: 'CHANGES_REQUESTED' },
        { id: 5, user: null, state: 'CHANGES_REQUESTED' },
      ]).decision,
    ).toBe('approved');
  });
  test('dismissed review removes an old objection', () => {
    expect(
      normalizeReviews([
        { id: 1, user: { login: 'a' }, state: 'CHANGES_REQUESTED' },
        { id: 2, user: { login: 'a' }, state: 'DISMISSED' },
      ]).decision,
    ).toBe('none');
  });
  test('GraphQL requirement catches missing branch-protection approvals', () => {
    expect(
      normalizeReviews(
        [{ id: 1, user: { login: 'a' }, state: 'APPROVED' }],
        0,
        false,
        'REVIEW_REQUIRED',
      ).decision,
    ).toBe('review_required');
  });
});
test.each([
  [true, 'mergeable'],
  [false, 'conflicting'],
  [null, 'unknown'],
] as const)('mergeable %s -> %s', (input, expected) => {
  expect(normalizeMergeable(input)).toBe(expected);
});

test('a queued rerun with no start timestamp replaces an older completed attempt', () => {
  expect(
    normalizeChecks([
      {
        id: 1,
        name: 'unit',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-01-01T00:00:00Z',
      },
      { id: 2, name: 'unit', status: 'queued', conclusion: null, started_at: null },
    ]),
  ).toEqual({ total: 1, passed: 0, failed: 0, pending: 1, failingNames: [] });
});
