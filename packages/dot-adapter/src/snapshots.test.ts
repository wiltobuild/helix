import { expect, test } from 'vitest';
import { createDotAdapter } from './index.js';

const scope = { projectId: 'p', sessionId: 's' };
const brief = {
  intakeId: 'i',
  revision: 2,
  text: 'Private',
  approvedAt: '2026-10-31T00:00:00Z',
  answers: [],
  assumptions: [],
};
const draft = {
  id: 'i',
  revision: 2,
  status: 'review',
  mode: 'interview',
  answers: [],
  synthesis: null,
  approved: brief,
};
const design = {
  sessionId: 's',
  revision: 2,
  status: 'approved',
  rounds: [{ revision: 1, concepts: [{ id: 'concept-1' }] }],
  decision: { revision: 2, conceptIds: ['concept-1'], rationale: 'Private' },
};
const invoke = (intake: unknown, visual: unknown) =>
  createDotAdapter({
    instance: 'mock',
    allow: [scope],
    transport: ({ path }) =>
      Promise.resolve(
        JSON.stringify(
          path.endsWith('/intake')
            ? { draft: intake }
            : path.endsWith('/design')
              ? { design: visual }
              : { events: [], lastSeq: 0 },
        ),
      ),
  }).invoke('getjourney', scope);

test('null snapshots are explicit absence with no acceptance', async () => {
  expect(await invoke(null, null)).toMatchObject({
    ok: true,
    data: { current: { discovery: { state: 'absent' }, design: { state: 'absent' } } },
    provenance: { stale: true, partial: true },
  });
});

test('acceptance is bound to intake and design revision evidence', async () => {
  expect(await invoke(draft, design)).toMatchObject({
    ok: true,
    data: { current: { discovery: { acceptedBrief: true }, design: { accepted: true } } },
  });
});

test.each([
  { ...draft, approved: { ...brief, intakeId: 'other' } },
  { ...draft, approved: { ...brief, revision: 1 } },
  { ...draft, destinationProjectId: 'other' },
])('rejects stale or cross-project intake acceptance %#', async (value) => {
  expect(await invoke(value, null)).toMatchObject({ ok: false, error: 'invalid_response' });
});

test.each([
  { ...design, rounds: [] },
  { ...design, decision: { ...design.decision, conceptIds: ['missing'] } },
  { ...design, decision: { ...design.decision, revision: 1 } },
  { ...design, sessionId: 'other' },
])('rejects unsupported design acceptance %#', async (value) => {
  expect(await invoke(null, value)).toMatchObject({ ok: false, error: 'invalid_response' });
});

test('another session intake is withheld', async () => {
  expect(await invoke({ ...draft, sessionId: 'another' }, null)).toMatchObject({
    ok: true,
    data: { current: { discovery: { state: 'outside-session-scope' } } },
  });
});

test('new out-of-order events cannot enter through a later page', async () => {
  const row = (seq: number) => ({
    ...scope,
    seq,
    v: 1,
    ts: '2026-10-31T00:00:00Z',
    type: 'session.started',
    payload: {},
  });
  const adapter = createDotAdapter({
    instance: 'mock',
    allow: [scope],
    transport: ({ path }) =>
      Promise.resolve(
        JSON.stringify(
          path.includes('since=0&')
            ? { events: Array.from({ length: 100 }, (_, n) => row(n * 2 + 2)), lastSeq: 200 }
            : { events: [row(1), row(201)], lastSeq: 201 },
        ),
      ),
  });
  expect(await adapter.invoke('getjourney', scope)).toMatchObject({
    ok: false,
    error: 'invalid_response',
  });
});

test.each(['cancelled', 'pending', 'failed'])(
  'latest %s design clears a historical ready decision',
  async (status) => {
    const events = ['ready', status].map((state, index) => ({
      ...scope,
      seq: index + 1,
      v: 1,
      ts: '2026-10-31T00:00:00Z',
      type: 'design.updated',
      payload: { design: { sessionId: 's', revision: index + 1, status: state } },
    }));
    const adapter = createDotAdapter({
      instance: 'mock',
      allow: [scope],
      transport: ({ path }) =>
        Promise.resolve(
          JSON.stringify(
            path.endsWith('/intake')
              ? { draft: null }
              : path.endsWith('/design')
                ? { design: { sessionId: 's', revision: 2, status, rounds: [] } }
                : { events, lastSeq: 2 },
          ),
        ),
    });
    expect(await adapter.invoke('getjourney', scope)).toMatchObject({
      ok: true,
      data: { decisionNeeded: [], current: { design: { decisionNeeded: false } } },
    });
  },
);
