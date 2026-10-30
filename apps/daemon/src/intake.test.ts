/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await -- Assertions inspect mock methods, and async test doubles model promise-returning ports. */
import { expect, test, vi } from 'vitest';
import {
  HelixError,
  projectIdSchema,
  sessionIdSchema,
  type HelixStore,
  type HelixCore,
  type IntakeDraft,
  type IntakeRequest,
  type IntakeSynthesis,
  type MetaValue,
} from '@helix/contracts';
import { createIntakeService, type IntakeWriter } from './intake.js';
const projectId = projectIdSchema.parse('project_intake');
const synthesis: IntakeSynthesis = {
  brief:
    'A focused task tracker for students. No social feed. Acceptance: create and complete a task.',
  question: '',
  choices: [],
  unknowns: [],
  assumptions: ['Use a simple local data model'],
  confirmed: [{ statement: 'Task tracker', answerIds: ['original-goal'] }],
};
function setup(writer: IntakeWriter = { generate: vi.fn(async () => synthesis) }) {
  const metadata = new Map<string, MetaValue>();
  const receipts = new Map<string, { hash: string; value: unknown }>();
  const store = {
    getMeta: vi.fn(async (scope: string, key: string) =>
      structuredClone(metadata.get(scope + key)),
    ),
    setMeta: vi.fn(async (scope: string, key: string, value: MetaValue) => {
      metadata.set(scope + key, structuredClone(value));
    }),
    recall: vi.fn(async (scope: string, key: string, hash: string) => {
      const found = receipts.get(scope + key);
      if (found && found.hash !== hash)
        throw new HelixError('IDEMPOTENCY_CONFLICT', 'Changed command');
      return found?.value;
    }),
    remember: vi.fn(async (scope: string, key: string, hash: string, value: unknown) => {
      receipts.set(scope + key, { hash, value });
    }),
  } as unknown as HelixStore;
  const core = {
    listProjects: vi.fn(async () => [{ id: projectId }]),
    createSession: vi.fn(async () => ({ id: sessionIdSchema.parse('session_intake') })),
  } as unknown as HelixCore;
  const service = createIntakeService(store, core, writer);
  let sequence = 0;
  const command = async (
    draft: IntakeDraft | null,
    action: Record<string, unknown>,
    requestId = `command_${++sequence}`,
  ) =>
    (
      await service.changeIntake(projectId, {
        ...action,
        id: draft?.id ?? 'new',
        revision: draft?.revision ?? 0,
        requestId,
      } as IntakeRequest)
    ).draft!;
  const start = async (mode = 'interview') => {
    const fresh = await command(null, { action: 'new', mode });
    return command(fresh, {
      action: 'edit',
      title: 'Task tracker',
      originalGoal: 'Build a task tracker for students',
      answers: [],
    });
  };
  const current = async () => (await service.projectIntake(projectId)).draft!;
  return { store, core, service, command, start, current, writer };
}

test('direct path reviews exact prompt before one idempotent launch with original goal preserved', async () => {
  const t = setup();
  let draft = await t.start('direct');
  expect(t.core.createSession).not.toHaveBeenCalled();
  draft = await t.command(draft, { action: 'brief', text: draft.originalGoal });
  expect(t.writer.generate).not.toHaveBeenCalled();
  const reviewed = draft;
  draft = await t.command(draft, { action: 'approve' }, 'approval');
  await t.command(reviewed, { action: 'approve' }, 'approval');
  expect(t.core.createSession).toHaveBeenCalledTimes(1);
  const launch = vi.mocked(t.core.createSession).mock.calls[0]!;
  expect(launch[0]).toBe(projectId);
  expect(launch[1].prompt).toBe(reviewed.originalGoal);
  expect(launch[1].reviewedBrief?.text).toBe(reviewed.originalGoal);
  expect(launch[1].reviewedBrief?.revision).toBe(reviewed.revision);
  expect(launch[1].planWithOrchestrator).toBe(true);
  expect(launch[2]).toBe(`intake:${draft.id}:${reviewed.revision}`);
});
test('interview persists answers, recommendations, assumptions, sources and versioned generated brief', async () => {
  const t = setup();
  let draft = await t.start();
  draft = await t.command(draft, {
    action: 'edit',
    title: draft.title,
    originalGoal: draft.originalGoal,
    answers: [
      {
        id: 'a1',
        question: 'What should we avoid?',
        answer: 'No social feed',
        source: 'recommendation-accepted',
      },
    ],
  });
  await t.command(draft, { action: 'generate' });
  await vi.waitFor(async () => expect((await t.current()).status).toBe('review'));
  draft = await t.current();
  expect(draft.answers[0]?.source).toBe('recommendation-accepted');
  expect(draft.synthesis).toEqual(synthesis);
  expect(draft.versions).toHaveLength(1);
  expect(
    (await createIntakeService(t.store, t.core, t.writer).projectIntake(projectId)).draft,
  ).toEqual(draft);
  expect(t.core.createSession).not.toHaveBeenCalled();
});
test('consequential unknowns prohibit launch even after editing prose', async () => {
  const t = setup({
    generate: async () => ({ ...synthesis, question: 'Who uses this?', unknowns: ['Audience'] }),
  });
  let draft = await t.start();
  await t.command(draft, { action: 'generate' });
  await vi.waitFor(async () => expect((await t.current()).status).toBe('review'));
  draft = await t.command(await t.current(), { action: 'brief', text: 'Edited brief' });
  await expect(t.command(draft, { action: 'approve' })).rejects.toThrow('resolve consequential');
  expect(t.core.createSession).not.toHaveBeenCalled();
});
test('edit invalidates stale generation, old approval and keeps earlier versions', async () => {
  let resolve!: (value: IntakeSynthesis) => void;
  const t = setup({
    generate: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  let draft = await t.start();
  draft = await t.command(draft, { action: 'generate' });
  const old = draft;
  draft = await t.command(draft, {
    action: 'edit',
    title: draft.title,
    originalGoal: 'A different goal',
    answers: [],
  });
  resolve(synthesis);
  await new Promise((r) => setTimeout(r, 10));
  expect((await t.current()).synthesis).toBeNull();
  await expect(t.command(old, { action: 'approve' })).rejects.toThrow('brief changed');
  expect(t.core.createSession).not.toHaveBeenCalled();
});
test('duplicate generate request does not start another job; cancel ignores late completion', async () => {
  let resolve!: (value: IntakeSynthesis) => void;
  const writer = {
    generate: vi.fn(
      () =>
        new Promise<IntakeSynthesis>((r) => {
          resolve = r;
        }),
    ),
  };
  const t = setup(writer);
  const base = await t.start();
  const draft = await t.command(base, { action: 'generate' }, 'generate');
  await t.command(base, { action: 'generate' }, 'generate');
  expect(writer.generate).toHaveBeenCalledTimes(1);
  await t.command(draft, { action: 'cancel' });
  resolve(synthesis);
  await new Promise((r) => setTimeout(r, 10));
  expect((await t.current()).status).toBe('editing');
});
test('generation error retains answers and explicit retry can recover', async () => {
  const writer = {
    generate: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(synthesis),
  };
  const t = setup(writer);
  await t.command(await t.start(), { action: 'generate' });
  await vi.waitFor(async () => expect((await t.current()).status).toBe('failed'));
  await t.command(await t.current(), { action: 'generate' });
  await vi.waitFor(async () => expect((await t.current()).status).toBe('review'));
});
test('daemon restart exposes interrupted generation without retrying automatically', async () => {
  const t = setup({ generate: () => new Promise(() => {}) });
  await t.command(await t.start(), { action: 'generate' });
  const recovered = await createIntakeService(t.store, t.core, t.writer).projectIntake(projectId);
  expect(recovered.draft?.status).toBe('failed');
});
test('invented confirmation provenance is rejected', async () => {
  const t = setup({
    generate: async () => ({
      ...synthesis,
      confirmed: [{ statement: 'Made up', answerIds: ['missing'] }],
    }),
  });
  await t.command(await t.start(), { action: 'generate' });
  await vi.waitFor(async () => expect((await t.current()).status).toBe('failed'));
});
test('uncertain launch preserves approval, rejects edits, and retries identical create key', async () => {
  const t = setup();
  let draft = await t.start('direct');
  draft = await t.command(draft, { action: 'brief', text: 'Exact reviewed brief' });
  vi.mocked(t.core.createSession).mockRejectedValueOnce(new Error('lost connection'));
  await expect(t.command(draft, { action: 'approve' })).rejects.toThrow('lost connection');
  const pending = await t.current();
  expect(pending.status).toBe('launching');
  await expect(
    t.command(pending, { action: 'edit', title: 'Changed', originalGoal: 'Changed', answers: [] }),
  ).rejects.toThrow('brief changed');
  await t.command(pending, { action: 'approve' });
  expect(vi.mocked(t.core.createSession).mock.calls[0]).toEqual(
    vi.mocked(t.core.createSession).mock.calls[1],
  );
});
