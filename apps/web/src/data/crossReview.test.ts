import { expect, test } from 'vitest';
import {
  deriveStatus,
  fixtures,
  helixEventSchema,
  projectUpTo,
  whyChain,
  type HelixEvent,
} from '@helix/contracts';
import { boardCards, describeEvent, eventTone, provenance, statusLine } from './describe';
import { crossReview, reviewerTarget, sessionHistory } from './crossReview';
import { replayPause } from './useDemoStream';

const { crossReviewRun: run, crossReviewIds: ids, crossReviewMilestones: at } = fixtures;
const requested = run.find((e) => e.type === 'agent_review.requested')!;
const pushed = run.find((e) => e.type === 'pr.updated')!;
const bySeq = new Map<number, HelixEvent>(run.map((e) => [e.seq, e]));

test.each([
  [requested.seq - 1, undefined],
  [requested.seq, 'Claude Code reviewing'],
  [at.changesRequested, 'Changes requested · 2'],
  [at.routed, 'Changes requested · 2'],
  [pushed.seq, 'Claude Code review pending · new head'],
  [pushed.seq + 3, 'Claude Code reviewing'],
  [at.approved, 'Approved by Claude Code'],
] as const)('worker chip at event %i reads %s and reviewers never get cards', (seq, label) => {
  const state = projectUpTo(run, seq, { strict: true });
  const cards = boardCards(state, bySeq, bySeq.get(seq)!.ts);
  expect(cards.map((c) => c.id)).toEqual([ids.worker]);
  expect(cards[0]!.review?.label).toBe(label);
  if (label) expect(cards[0]!.review?.agent).toBe('claude-code');
});

test('reverse agent pairing names Codex as the reviewer', () => {
  const reversed = run.map((e) =>
    e.type === 'session.created'
      ? {
          ...e,
          payload: {
            session: {
              ...e.payload.session,
              agent: e.payload.session.agent === 'codex' ? 'claude-code' : 'codex',
            },
          },
        }
      : e,
  );
  const state = projectUpTo(reversed, at.approved, { strict: true });
  expect(crossReview(state.sessions[ids.worker]!, state)?.label).toBe('Approved by Codex');
  expect(
    describeEvent(
      reversed.find((e) => e.seq === at.approved)!,
      state,
    ),
  ).toContain('Codex approved');
});

test('an approval for an old head is pending, never ready or approved', () => {
  if (pushed.type !== 'pr.updated') throw new Error('Missing PR update');
  const moved = helixEventSchema.parse({
    ...pushed,
    seq: run.at(-1)!.seq + 1,
    payload: { pr: { ...pushed.payload.pr, headSha: 'new-head-after-approval' } },
  });
  const events = [...run, moved];
  const state = projectUpTo(events, moved.seq, { strict: true });
  const worker = state.sessions[ids.worker]!;
  expect(crossReview(worker, state)).toMatchObject({
    stale: true,
    status: 'reviewing',
    label: 'Claude Code review pending · new head',
  });
  expect(deriveStatus(worker)).toBe('in_review');
});

test('abandonment removes the chip and remains in worker history', () => {
  if (requested.type !== 'agent_review.requested') throw new Error('Missing request');
  const abandoned = helixEventSchema.parse({
    ...requested,
    seq: requested.seq + 1,
    causedBy: requested.seq,
    type: 'agent_review.abandoned',
    payload: { ...requested.payload, reason: 'Reviewer stopped.' },
  });
  const events = [...run.filter((e) => e.seq <= requested.seq), abandoned];
  const state = projectUpTo(events, abandoned.seq, { strict: true });
  expect(crossReview(state.sessions[ids.worker]!, state)).toBeUndefined();
  expect(sessionHistory(events, ids.worker, abandoned.seq)[0]).toEqual(abandoned);
  expect(describeEvent(abandoned, state)).toBe(
    "Helix ended Claude Code's review of “Add discount codes” · PR #7 without a verdict: Reviewer stopped.",
  );
  expect(eventTone(abandoned)).toBe('needs');
  expect(provenance(abandoned, state)).toBe('helix');
});

test.each([
  [
    requested.seq,
    'Helix asked Claude Code to review “Add discount codes” · PR #7.',
    'review',
    'helix',
  ],
  [
    at.changesRequested,
    'Claude Code requested changes (2 findings) for “Add discount codes” · PR #7.',
    'failed',
    'agent',
  ],
  [at.approved, 'Claude Code approved “Add discount codes” · PR #7.', 'done', 'agent'],
  [
    at.routed,
    'Helix sent the review findings back to Codex for “Add discount codes”.',
    'feedback',
    'helix',
  ],
] as const)(
  'event %i has a useful sentence, tone and provenance',
  (seq, sentence, tone, source) => {
    const state = projectUpTo(run, seq);
    const event = bySeq.get(seq)!;
    expect(describeEvent(event, state)).toBe(sentence);
    expect(eventTone(event)).toBe(tone);
    expect(provenance(event, state)).toBe(source);
    expect(replayPause(event)).toBe(1600);
  },
);

test('routed findings trace through the verdict and review request to green CI', () => {
  const state = projectUpTo(run, at.routed);
  const chain = whyChain(run, at.routed).slice(0, 4);
  expect(chain.map((e) => e.type)).toEqual([
    'feedback.routed',
    'agent_review.submitted',
    'agent_review.requested',
    'ci.updated',
  ]);
  expect(chain.map((e) => provenance(e, state))).toEqual(['helix', 'agent', 'helix', 'helix']);
  expect(describeEvent(chain[3]!, state)).toBe('CI passed on PR #7 (1/1).');
  const history = sessionHistory(run, ids.worker, at.routed);
  expect(chain.every((e) => history.includes(e))).toBe(true);
  expect(history.some((e) => e.seq > at.routed)).toBe(false);
});

test('reviewer target resolves the worker and PR before and after a request', () => {
  for (const seq of [requested.seq - 1, requested.seq, at.approved]) {
    const state = projectUpTo(run, seq);
    expect(reviewerTarget(state.sessions[ids.reviewer]!, state, run, seq)).toEqual({
      worker: state.sessions[ids.worker],
      prNumber: 7,
    });
  }
});

test('a cross-review change request says where the findings went, not GitHub thread counts', () => {
  const state = projectUpTo(run, at.changesRequested);
  const worker = state.sessions[ids.worker]!;
  expect(statusLine(worker, deriveStatus(worker), state)).toBe('Findings sent back to Codex');
});
