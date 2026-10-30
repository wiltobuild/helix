import { expect, test, vi } from 'vitest';
import { sessionIdSchema, planNodeIdSchema, type VisualConcept } from '@helix/contracts';
import {
  needsVisualDesign,
  newVisualDesign,
  changeVisualDesign,
  completeVisualRound,
} from './visual-design.js';
import { fixture } from './test-support.js';
import { createHelixCore } from './index.js';
const concepts = (round = 1): VisualConcept[] =>
  [1, 2, 3].map((n) => ({
    id: `r${round}-${n}`,
    title: `Direction ${n}`,
    imageUrl: `https://example.test/render-${round}-${n}.png`,
    mimeType: 'image/png',
    prompt: 'A raster concept',
    rationale: 'Fits the brief',
    tradeoffs: ['More visual density'],
    recommended: n === 1,
  }));
const id = sessionIdSchema.parse('session-visual');
test('UI requests automatically trigger exploration, backend-only requests do not', () => {
  expect(needsVisualDesign('Build a storefront for a coffee shop')).toBe(true);
  expect(needsVisualDesign('Build a landing page')).toBe(true);
  expect(needsVisualDesign('Repair database migrations')).toBe(false);
});
test('reject all generates a fresh round, retains history and rejects stale choices', () => {
  const old = completeVisualRound(newVisualDesign(id, 'A storefront', true), concepts());
  const request = {
    requestId: 'reject-1',
    revision: 1,
    action: 'regenerate' as const,
    text: 'More editorial; reject all three',
    references: [{ url: 'https://example.test/reference.png' }],
  };
  const next = changeVisualDesign(old, request, true);
  expect(next.status).toBe('pending');
  expect(next.rounds).toHaveLength(2);
  expect(next.rounds[0]!.concepts).toHaveLength(3);
  expect(next.rounds[1]!.concepts).toHaveLength(0);
  expect(changeVisualDesign(next, request, true)).toBe(next);
  expect(() =>
    changeVisualDesign(
      next,
      {
        requestId: 'stale',
        revision: 1,
        action: 'approve',
        conceptIds: ['r1-1'],
        text: 'Choose it',
      },
      true,
    ),
  ).toThrow(/revision/);
  expect(() => changeVisualDesign(next, { ...request, text: 'different' }, true)).toThrow(/reused/);
});
test('combine with rationale, converse again, cancel and explicit retry', () => {
  const ready = completeVisualRound(newVisualDesign(id, 'A storefront', true), concepts());
  const approved = changeVisualDesign(
    ready,
    {
      requestId: 'choose',
      revision: 1,
      action: 'approve',
      conceptIds: ['r1-1', 'r1-3'],
      text: 'Combine first layout and third palette',
    },
    true,
  );
  expect(approved.decision?.conceptIds).toHaveLength(2);
  const commented = changeVisualDesign(
    approved,
    { requestId: 'comment', revision: 2, action: 'comment', text: 'Less saturated please' },
    true,
  );
  expect(commented.status).toBe('ready');
  expect(commented.decision).toBeUndefined();
  const cancelled = changeVisualDesign(
    commented,
    { requestId: 'cancel', revision: 3, action: 'cancel' },
    true,
  );
  expect(cancelled.status).toBe('cancelled');
  expect(
    changeVisualDesign(cancelled, { requestId: 'retry', revision: 4, action: 'retry' }, false)
      .status,
  ).toBe('unavailable');
});
test('provider output must have three distinct raster references', () => {
  const d = newVisualDesign(id, 'A storefront', true);
  expect(() => completeVisualRound(d, concepts().slice(0, 2))).toThrow();
  expect(() => completeVisualRound(d, [concepts()[0]!, concepts()[0]!, concepts()[0]!])).toThrow();
  expect(() =>
    completeVisualRound(
      d,
      concepts().map((c) => ({ ...c, imageUrl: 'javascript:alert(1)' })),
    ),
  ).toThrow();
});
async function visualFixture(provider = vi.fn(() => Promise.resolve(concepts()))) {
  const f = fixture({ visualImages: { generate: provider } });
  const project = await f.add();
  const owner = await f.core.createSession(
    project.id,
    {
      title: 'Coffee',
      prompt: 'Build a coffee storefront',
      agent: 'codex',
      interface: 'chat',
      planWithOrchestrator: true,
    },
    'create',
  );
  await f.drain();
  return { ...f, project, owner, provider };
}
test('automatic exploration, idempotent regenerate, replay and revision-bound approval', async () => {
  const f = await visualFixture();
  try {
    expect(f.provider).toHaveBeenCalledTimes(1);
    expect(f.provider.mock.calls[0]?.length).toBeGreaterThan(0);
    const first = (await f.core.sessionDesign!(f.owner.id)).design!;
    expect(first.status).toBe('ready');
    const request = {
      requestId: 'regenerate',
      revision: first.revision,
      action: 'regenerate' as const,
      text: 'Reject all',
    };
    await Promise.all([
      f.core.changeDesign!(f.owner.id, request),
      f.core.changeDesign!(f.owner.id, request),
    ]);
    await f.drain();
    expect(f.provider).toHaveBeenCalledTimes(2);
    expect(f.state(f.project.id).sessions[f.owner.id]!.design?.rounds).toHaveLength(2);
    await expect(
      f.core.changeDesign!(f.owner.id, {
        requestId: 'stale',
        revision: 1,
        action: 'approve',
        conceptIds: ['r1-1'],
        text: 'yes',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const reloaded = createHelixCore(f.deps);
    expect((await reloaded.sessionDesign!(f.owner.id)).design).toEqual(
      (await f.core.sessionDesign!(f.owner.id)).design,
    );
    await reloaded.shutdown();
  } finally {
    await f.core.shutdown();
  }
});
test('unavailable is honest and an independent backend node starts while visual node waits', async () => {
  const f = fixture();
  try {
    const p = await f.add();
    const owner = await f.core.createSession(
      p.id,
      {
        title: 'Site',
        prompt: 'Build a website',
        agent: 'codex',
        interface: 'chat',
        planWithOrchestrator: true,
      },
      'planner',
    );
    expect((await f.core.sessionDesign!(owner.id)).design?.status).toBe('unavailable');
    const node = (key: string, title: string, files: string[]) => ({
      id: planNodeIdSchema.parse(key),
      title,
      description: title,
      files,
      acceptance: ['Works'],
      dependsOn: [],
      agent: 'codex' as const,
      rationale: 'Independent scope',
    });
    const plan = await f.core.submitPlan({
      projectId: p.id,
      orchestratorSessionId: owner.id,
      goal: 'Website',
      nodes: [
        node('node-ui', 'Build frontend', ['apps/web/**']),
        node('node-db', 'Database constraints', ['db/**']),
      ],
    });
    await f.core.decidePlan(plan.id, { decision: 'approve' });
    const state = f.state(p.id);
    expect(state.plans[plan.id]!.nodes.find((n) => n.id === 'node-ui')?.sessionId).toBeUndefined();
    expect(state.plans[plan.id]!.nodes.find((n) => n.id === 'node-db')?.sessionId).toBeDefined();
  } finally {
    await f.core.shutdown();
  }
});
test('cancelled generation cannot publish late results', async () => {
  let resolve!: (v: VisualConcept[]) => void;
  const provider = vi.fn(
    () =>
      new Promise<VisualConcept[]>((r) => {
        resolve = r;
      }),
  );
  const f = await visualFixture(provider);
  try {
    const d = (await f.core.sessionDesign!(f.owner.id)).design!;
    await f.core.changeDesign!(f.owner.id, {
      requestId: 'cancel',
      revision: d.revision,
      action: 'cancel',
    });
    resolve(concepts());
    await f.drain();
    expect((await f.core.sessionDesign!(f.owner.id)).design?.status).toBe('cancelled');
    expect(f.provider).toHaveBeenCalledTimes(1);
  } finally {
    await f.core.shutdown();
  }
});
test('direct visual task is held, then launches the same session after approval', async () => {
  const f = fixture({ visualImages: { generate: () => Promise.resolve(concepts()) } });
  try {
    const p = await f.add();
    const s = await f.core.createSession(
      p.id,
      { title: 'Site', prompt: 'Build a website', agent: 'codex', interface: 'chat' },
      'direct',
    );
    await f.drain();
    expect(f.state(p.id).sessions[s.id]!.worktree).toBeUndefined();
    const d = (await f.core.sessionDesign!(s.id)).design!;
    await f.core.changeDesign!(s.id, {
      requestId: 'approve',
      revision: d.revision,
      action: 'approve',
      conceptIds: ['r1-1'],
      text: 'Choose editorial layout',
    });
    expect(Object.keys(f.state(p.id).sessions)).toEqual([s.id]);
    expect(f.state(p.id).sessions[s.id]!.worktree).toBeDefined();
  } finally {
    await f.core.shutdown();
  }
});

test('checkpoint resume requires current design revision and current worker commit', async () => {
  const f = fixture({ visualImages: { generate: () => Promise.resolve(concepts()) } });
  try {
    const p = await f.add();
    const s = await f.core.createSession(
      p.id,
      { title: 'Site', prompt: 'Build a website', agent: 'codex', interface: 'chat' },
      'checkpoint-owner',
    );
    await f.drain();
    await f.core.changeDesign!(s.id, {
      requestId: 'initial-choice',
      revision: 1,
      action: 'approve',
      conceptIds: ['r1-1'],
      text: 'Use editorial direction',
    });
    const checkpoint = {
      workerSessionId: s.id,
      headSha: 'head-1',
      previewUrl: 'http://localhost:7777',
      recommendation: 'Check responsive layout and reduced motion',
      reducedMotion: true,
    };
    const ready = (
      await f.core.changeDesign!(s.id, {
        requestId: 'checkpoint',
        revision: 2,
        action: 'checkpoint',
        checkpoint,
      })
    ).design!;
    expect(ready.status).toBe('ready');
    await expect(f.core.merge(s.id)).rejects.toMatchObject({ code: 'MERGE_BLOCKED' });
    await expect(
      f.core.changeDesign!(s.id, {
        requestId: 'old-revision',
        revision: 2,
        action: 'approve',
        conceptIds: ['r1-1'],
        text: 'Ship it',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    f.git.headSha.mockResolvedValue('head-2');
    await expect(
      f.core.changeDesign!(s.id, {
        requestId: 'old-commit',
        revision: ready.revision,
        action: 'approve',
        conceptIds: ['r1-1'],
        text: 'Continue',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    f.git.headSha.mockResolvedValue('head-1');
    const resumed = await f.core.changeDesign!(s.id, {
      requestId: 'current',
      revision: ready.revision,
      action: 'approve',
      conceptIds: ['r1-1'],
      text: 'Continue with this preview',
    });
    expect(resumed.design?.status).toBe('approved');
  } finally {
    await f.core.shutdown();
  }
});

test('restart marks an uncertain image job failed without submitting a duplicate', async () => {
  const provider = vi.fn(() => new Promise<VisualConcept[]>(() => {}));
  const f = await visualFixture(provider);
  const recovered = createHelixCore(f.deps);
  try {
    await f.core.shutdown();
    await recovered.start();
    expect((await recovered.sessionDesign!(f.owner.id)).design?.status).toBe('failed');
    expect(provider).toHaveBeenCalledTimes(1);
  } finally {
    await recovered.shutdown();
  }
});

test('freeform design conversation reaches the orchestrator and its reply persists', async () => {
  const f = await visualFixture();
  try {
    const handle = f.harness.handles.get(f.owner.id)!;
    handle.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
    await f.drain();
    const d = (await f.core.sessionDesign!(f.owner.id)).design!;
    await f.core.changeDesign!(f.owner.id, {
      requestId: 'talk',
      revision: d.revision,
      action: 'comment',
      text: 'Can the warmer palette still meet contrast requirements?',
    });
    expect(handle.send.mock.calls.at(-1)?.[0]).toContain('contrast requirements');
    handle.emit({
      type: 'chat.item',
      payload: {
        item: {
          kind: 'message',
          role: 'assistant',
          text: 'Yes; use darker text and verify contrast in the working preview.',
        },
      },
    });
    await f.drain();
    const updated = (await f.core.sessionDesign!(f.owner.id)).design!;
    expect(updated.conversation.at(-1)?.text).toContain('verify contrast');
    expect(updated.decision).toBeUndefined();
  } finally {
    await f.core.shutdown();
  }
});
