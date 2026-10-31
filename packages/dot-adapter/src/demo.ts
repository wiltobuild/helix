import { createDotAdapter } from './index.js';

const scope = { projectId: 'mock-project', sessionId: 'mock-session' };
const ts = '2026-10-31T00:00:00.000Z';
const events = [
  {
    type: 'session.created',
    payload: {
      session: {
        id: scope.sessionId,
        projectId: scope.projectId,
        reviewedBrief: {
          intakeId: 'mock-intake',
          revision: 1,
          text: 'Mock brief',
          approvedAt: ts,
          answers: [
            { id: 'a', question: 'Mock question', answer: 'Mock answer', source: 'user' },
            {
              id: 'b',
              question: 'Mock recommendation',
              answer: 'Mock choice',
              source: 'recommendation-accepted',
            },
          ],
          assumptions: ['Mock assumption'],
        },
      },
    },
  },
  {
    type: 'design.updated',
    payload: { design: { sessionId: scope.sessionId, revision: 1, status: 'ready' } },
  },
  { type: 'session.started', payload: {} },
  { type: 'worktree.diff_updated', payload: { filesChanged: 1, insertions: 2, deletions: 0 } },
  {
    type: 'ci.updated',
    payload: { prNumber: 1, checks: { total: 2, passed: 2, failed: 0, pending: 0 } },
  },
].map((e, index) => ({ ...e, ...scope, seq: index * 10 + 1, ts, v: 1 }));
const adapter = createDotAdapter({
  instance: 'synthetic-demo',
  allow: [scope],
  now: () => Date.parse(ts),
  transport: ({ path }) =>
    Promise.resolve(
      JSON.stringify(
        path.endsWith('/intake')
          ? {
              draft: {
                status: 'review',
                mode: 'interview',
                revision: 2,
                answers: [],
                synthesis: { confirmed: [], assumptions: ['Mock'], unknowns: [] },
              },
            }
          : path.endsWith('/design')
            ? {
                design: {
                  sessionId: scope.sessionId,
                  revision: 1,
                  status: 'ready',
                  rounds: [{ concepts: [{}, {}, {}] }],
                },
              }
            : { events, lastSeq: events.at(-1)?.seq },
      ),
    ),
});
console.log('SYNTHETIC MOCK ONLY — no live Helix or Dot connection');
console.log(JSON.stringify(await adapter.invoke('getjourney', scope), null, 2));
