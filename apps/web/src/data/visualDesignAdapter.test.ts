import { expect, test } from 'vitest';
import { sessionIdSchema, visualDesignRequestSchema, type VisualDesign } from '@helix/contracts';
import { visualDesignRequest, visualDesignView } from './visualDesignAdapter';

const design: VisualDesign = {
  sessionId: sessionIdSchema.parse('session-design'),
  revision: 3,
  brief: 'Build a warm storefront',
  status: 'unavailable',
  rounds: [
    { revision: 1, jobId: 'round-one', concepts: [] },
    { revision: 3, jobId: 'round-two', concepts: [] },
  ],
  conversation: [
    {
      role: 'user',
      text: 'Reject all and try warmer colors',
      revision: 3,
      references: [{ url: 'https://example.com/reference.png' }],
    },
  ],
  references: [],
  receipts: [],
  blocker: 'No supported image adapter configured',
};

test('adapter preserves actual unavailable state, references, revisions and history without fabricated renders', () => {
  const view = visualDesignView(design, 'Storefront', ['Homepage']);
  expect(view.id).toBe(design.sessionId);
  expect(view.revision).toBe(3);
  expect(view.activeRoundId).toBe('round-two');
  expect(view.rounds[0]?.status).toBe('superseded');
  expect(view.rounds[1]).toMatchObject({
    status: 'unavailable',
    concepts: [],
    error: design.blocker,
  });
  expect(view.conversation[0]?.references).toEqual(design.conversation[0]?.references);
});

test.each(['regenerate', 'feedback', 'approve', 'approve_checkpoint', 'retry', 'cancel'] as const)(
  'UI %s maps to the shared strict API contract',
  (action) => {
    const result = visualDesignRequest({
      workspaceId: design.sessionId,
      revision: 3,
      roundId: 'round-two',
      action,
      conceptIds: ['one', 'three'],
      feedback: 'Combine layout and palette',
      references: ['https://example.com/reference.png'],
      requestId: 'same-id',
    });
    expect(visualDesignRequestSchema.safeParse(result).success).toBe(true);
    expect(result.requestId).toBe('same-id');
    expect(result.revision).toBe(3);
    expect(result.action).toBe(
      action === 'feedback' ? 'comment' : action === 'approve_checkpoint' ? 'approve' : action,
    );
  },
);

test('a decision without new references does not erase the persisted reference set', () => {
  const request = visualDesignRequest({
    workspaceId: design.sessionId,
    revision: 3,
    roundId: 'round-two',
    action: 'approve',
    conceptIds: ['one'],
    feedback: '',
    references: [],
    requestId: 'choose',
  });
  expect(request).not.toHaveProperty('references');
});

test('round and decision palette snapshots are projected independently', () => {
  const palette = {
    name: 'Teal',
    background: '#F6F4EF',
    foreground: '#183430',
    primary: '#0E7672',
    accent: '#B64D31',
  };
  const view = visualDesignView(
    {
      ...design,
      rounds: [{ revision: 1, jobId: 'old', concepts: [], palette }, ...design.rounds],
      decision: { revision: 2, conceptIds: ['one'], rationale: 'Approved', palette },
    },
    'Test',
    [],
  );
  expect(view.rounds[0]?.palette).toEqual(palette);
  expect(view.rounds.at(-1)?.palette).toBeUndefined();
  expect(view.decisions[0]?.palette).toEqual(palette);
  const request = visualDesignRequest({
    workspaceId: design.sessionId,
    revision: 3,
    roundId: 'round-two',
    action: 'regenerate',
    conceptIds: [],
    feedback: '',
    references: [],
    requestId: 'palette',
    palette,
  });
  expect(visualDesignRequestSchema.parse(request).palette).toEqual(palette);
});
