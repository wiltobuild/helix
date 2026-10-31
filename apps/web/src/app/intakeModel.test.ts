import { readyIntakeSession, intakeScopeSwitchHeld } from './intakeModel';
import { fixtures, type HelixEvent } from '@helix/contracts';
import { describe, expect, test } from 'vitest';
import type { IntakeDraft } from '@helix/contracts';
import {
  approvalBlockers,
  briefSurvivesRename,
  citationLabel,
  clearIfUnchanged,
  editLocks,
  intakeStage,
  pendingAnswerNote,
  provisionalTitle,
  reconcileDraft,
  unsavedBriefProblem,
  writerReadiness,
} from './intakeModel';

const synthesis = {
  brief: 'Build a reset flow.',
  question: '',
  choices: [],
  unknowns: [],
  assumptions: [],
  confirmed: [],
};
const draft = (over: Partial<IntakeDraft> = {}): IntakeDraft => ({
  id: 'd1',
  revision: 3,
  title: 'Reset flow',
  originalGoal: 'Let people reset passwords',
  mode: 'interview',
  answers: [],
  synthesis,
  versions: [{ revision: 3, text: synthesis.brief, source: 'agent' }],
  status: 'review',
  ...over,
});

describe('provisionalTitle', () => {
  test.each([
    ['I want to build a password reset flow for customers.', 'Password reset flow for customers'],
    ['Can you please add dark mode to settings', 'Dark mode to settings'],
    ['Help me shape an onboarding checklist', 'Onboarding checklist'],
    ['  \n# Weekly usage dashboard\nShows signups by channel', 'Weekly usage dashboard'],
    ['Hi! We need to create an export to CSV. It should be fast.', 'Export to CSV'],
    ['build', 'Build'],
    ['3D print queue for the lab', '3D print queue for the lab'],
    ['1. Bulk invite teammates', 'Bulk invite teammates'],
  ])('%j → %j', (idea, expected) => {
    expect(provisionalTitle(idea)).toBe(expected);
  });

  test('falls back honestly for empty input and stays within limits', () => {
    expect(provisionalTitle('   ')).toBe('Untitled build');
    const long = provisionalTitle(`A ${'very '.repeat(40)}long idea`);
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith('…')).toBe(true);
  });

  test('never invents a product name from repository context', () => {
    expect(provisionalTitle('Let customers reset a forgotten password')).toBe(
      'Let customers reset a forgotten password',
    );
  });
});

describe('intakeStage', () => {
  test('no draft, launched, or an empty unsaved start all show the composer', () => {
    expect(intakeStage(null)).toBe('start');
    expect(intakeStage(draft({ status: 'launched', sessionId: 's' }))).toBe('start');
    expect(
      intakeStage(draft({ status: 'editing', originalGoal: '', synthesis: null, answers: [] })),
    ).toBe('start');
  });

  test('saved inputs without a brief resume in compose; other statuses resume as-is', () => {
    expect(intakeStage(draft({ status: 'editing', synthesis: null }))).toBe('compose');
    expect(intakeStage(draft({ status: 'generating' }))).toBe('generating');
    expect(intakeStage(draft({ status: 'failed', error: 'x' }))).toBe('failed');
    expect(intakeStage(draft({ status: 'launching' }))).toBe('launching');
    expect(intakeStage(draft())).toBe('review');
  });
});

describe('approvalBlockers', () => {
  const base = { dirty: false, briefEdited: false, title: 'Reset flow', goal: 'Reset' };
  test('ready review has no blockers', () => {
    expect(approvalBlockers({ ...base, draft: draft() })).toEqual([]);
  });
  test('unresolved decisions, unsaved edits and empty name each block approval', () => {
    const blocked = approvalBlockers({
      draft: draft({ synthesis: { ...synthesis, unknowns: ['Who can reset?', 'Expiry?'] } }),
      dirty: true,
      briefEdited: true,
      title: ' ',
      goal: 'Reset',
    });
    expect(blocked).toHaveLength(4);
    expect(blocked[0]).toBe('2 decisions still need your answer.');
  });
  test('non-review statuses are never approvable', () => {
    for (const status of ['editing', 'generating', 'failed'] as const)
      expect(approvalBlockers({ ...base, draft: draft({ status }) })).toEqual([
        'A reviewed brief is not ready yet.',
      ]);
    expect(approvalBlockers({ ...base, draft: null })).toHaveLength(1);
  });
});

test('writer readiness reports only what detection says', () => {
  expect(writerReadiness(undefined)).toBe('unknown');
  expect(writerReadiness([{ agent: 'claude-code', installed: true }])).toBe('unknown');
  expect(writerReadiness([{ agent: 'codex', installed: false }])).toBe('missing');
  expect(writerReadiness([{ agent: 'codex', installed: true, signedIn: false }])).toBe('signin');
  expect(writerReadiness([{ agent: 'codex', installed: true, signedIn: 'unknown' }])).toBe(
    'unknown',
  );
  expect(writerReadiness([{ agent: 'codex', installed: true, signedIn: true }])).toBe('ready');
});

test('only a purely user-written brief survives a rename verbatim', () => {
  expect(briefSurvivesRename(synthesis)).toBe(true);
  expect(briefSurvivesRename(null)).toBe(false);
  expect(briefSurvivesRename({ ...synthesis, assumptions: ['Email only'] })).toBe(false);
  expect(briefSurvivesRename({ ...synthesis, unknowns: ['Expiry?'] })).toBe(false);
  expect(
    briefSurvivesRename({ ...synthesis, confirmed: [{ statement: 'x', answerIds: ['a'] }] }),
  ).toBe(false);
});

test('a composer clears only when its text is what was sent', () => {
  expect(clearIfUnchanged('A CSV export', 'A CSV export')).toBe('');
  expect(clearIfUnchanged('  A CSV export\n', 'A CSV export')).toBe('');
  expect(clearIfUnchanged('A CSV export with filters', 'A CSV export')).toBe(
    'A CSV export with filters',
  );
  expect(clearIfUnchanged('', 'A CSV export')).toBe('');
});

describe('pendingAnswerNote', () => {
  test('silent while the unsent answer belongs to the current question', () => {
    expect(pendingAnswerNote(undefined, 'Expiry?')).toBeUndefined();
    expect(pendingAnswerNote({ question: 'Expiry?', text: '1 hour' }, 'Expiry?')).toBeUndefined();
    expect(pendingAnswerNote({ question: 'Old?', text: '  ' }, 'Expiry?')).toBeUndefined();
  });
  test('names the earlier question when the current one changed', () => {
    expect(pendingAnswerNote({ question: 'Who resets?', text: 'Admins' }, 'Expiry?')).toBe(
      'You started this for an earlier question: “Who resets?”',
    );
    expect(pendingAnswerNote({ question: '', text: 'Admins' }, 'Expiry?')).toBe(
      'You started this before the current question was asked.',
    );
  });
});

describe('unsavedBriefProblem', () => {
  test('nothing to persist, or savable prose, is not a problem', () => {
    expect(
      unsavedBriefProblem({ briefEdited: false, brief: '', status: 'review' }),
    ).toBeUndefined();
    expect(
      unsavedBriefProblem({ briefEdited: true, brief: 'New wording', status: 'review' }),
    ).toBeUndefined();
  });
  test('an emptied brief blocks close/switch with a way forward instead of being skipped', () => {
    for (const brief of ['', '   \n'])
      expect(unsavedBriefProblem({ briefEdited: true, brief, status: 'review' })).toMatch(
        /can’t be empty.*Discard edits/,
      );
  });
  test('prose edits outside review are reported, not silently dropped', () => {
    expect(unsavedBriefProblem({ briefEdited: true, brief: 'x', status: 'failed' })).toMatch(
      /Discard edits/,
    );
  });
});

test('input edits and brief prose edits are mutually exclusive', () => {
  expect(editLocks({ dirty: false, briefEdited: false })).toEqual({ inputs: false, brief: false });
  expect(editLocks({ dirty: true, briefEdited: false })).toEqual({ inputs: false, brief: true });
  expect(editLocks({ dirty: false, briefEdited: true })).toEqual({ inputs: true, brief: false });
});

describe('reconcileDraft', () => {
  const local = draft();
  test('identical saved state changes nothing', () => {
    expect(reconcileDraft(local, draft(), true)).toEqual({ action: 'same', discardsLocal: false });
  });
  test('a status change at the same revision is not ignored', () => {
    const launched = draft({ status: 'launched', sessionId: 's1' });
    expect(reconcileDraft(local, launched, false)).toEqual({
      action: 'adopt',
      discardsLocal: false,
    });
    expect(reconcileDraft(local, draft({ status: 'launching' }), true)).toEqual({
      action: 'adopt',
      discardsLocal: true,
    });
  });
  test('editable updates keep local words on the same draft', () => {
    expect(reconcileDraft(local, draft({ revision: 4 }), true)).toEqual({
      action: 'keepLocal',
      discardsLocal: false,
    });
    expect(reconcileDraft(local, draft({ revision: 4 }), false).action).toBe('adopt');
  });
  test('a replaced or missing draft never receives stale local edits', () => {
    expect(reconcileDraft(local, draft({ id: 'other' }), true)).toEqual({
      action: 'adopt',
      discardsLocal: true,
    });
    expect(reconcileDraft(local, null, true).discardsLocal).toBe(true);
    expect(reconcileDraft(null, draft(), false).action).toBe('adopt');
  });
});

test('citations name the original idea or the numbered answer', () => {
  const answers = [
    { id: 'a1', question: 'Who resets?', answer: 'Anyone', source: 'user' as const },
  ];
  expect(citationLabel('original-goal', answers)).toBe('Your original idea');
  expect(citationLabel('a1', answers)).toBe('Answer 1: Who resets?');
  expect(citationLabel('zz', answers)).toBe('An earlier answer');
});

test('created intake navigation waits for the verified destination and its own session event', () => {
  const event = fixtures.crossReviewRun.find(
    (item): item is HelixEvent<'session.created'> => item.type === 'session.created',
  )!;
  const pending = { id: event.payload.session.id, projectId: event.payload.session.projectId };
  expect(readyIntakeSession(pending, 'different-project', [event])).toBeUndefined();
  expect(readyIntakeSession(pending, pending.projectId, [])).toBeUndefined();
  expect(readyIntakeSession(pending, pending.projectId, [event])).toBe(pending.id);
});
test('completed drafts permit scope changes while active and uncertain operations hold them', () => {
  const idle = { busy: false, loaded: true, approvalUnknown: false, status: 'launched' as const };
  expect(intakeScopeSwitchHeld(idle)).toBe(false);
  expect(intakeScopeSwitchHeld({ ...idle, status: 'launching' })).toBe(true);
  expect(intakeScopeSwitchHeld({ ...idle, status: 'generating' })).toBe(true);
  expect(intakeScopeSwitchHeld({ ...idle, approvalUnknown: true })).toBe(true);
});
