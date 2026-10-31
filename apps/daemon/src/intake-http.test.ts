import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { IntakeDraft } from '@helix/contracts';
import { openStore } from '@helix/storage';
import { createIntakeService } from './intake.js';
import { createServer } from './server.js';
import { createFakeCore, project } from './testing/fake-core.js';

test('HTTP intake validates payloads, persists resume in SQLite and enforces explicit brief approval', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'intake-http-'));
  const store = openStore({ dataDir: dir });
  const fixture = createFakeCore();
  const intake = createIntakeService(store, fixture.core, {
    generate: () => Promise.reject(new Error('unused')),
  });
  const app = await createServer({ core: { ...fixture.core, ...intake }, port: 0 });
  const url = `/api/projects/${project.id}/intake`;
  try {
    const invalid = await app.inject({ method: 'POST', url, payload: { action: 'approve' } });
    expect(invalid.statusCode).toBe(400);
    const create = await app.inject({
      method: 'POST',
      url,
      payload: { action: 'new', mode: 'direct', id: 'new', revision: 0, requestId: 'new' },
    });
    expect(create.statusCode).toBe(200);
    const initial = JSON.parse(create.body) as { draft: { id: string; revision: number } };
    const edit = await app.inject({
      method: 'POST',
      url,
      payload: {
        action: 'edit',
        id: initial.draft.id,
        revision: 1,
        requestId: 'edit',
        title: 'Reading',
        originalGoal: 'Local reading list',
        answers: [],
      },
    });
    expect(edit.statusCode).toBe(200);
    const rejected = await app.inject({
      method: 'POST',
      url,
      payload: { action: 'approve', id: initial.draft.id, revision: 2, requestId: 'premature' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(fixture.core.createSession).not.toHaveBeenCalled();
    const reloaded = createIntakeService(store, fixture.core, {
      generate: () => Promise.reject(new Error('unused')),
    });
    expect((await reloaded.projectIntake(project.id)).draft?.originalGoal).toBe(
      'Local reading list',
    );
    const review = await app.inject({
      method: 'POST',
      url,
      payload: {
        action: 'brief',
        id: initial.draft.id,
        revision: 2,
        requestId: 'review',
        text: 'Local reading list. No login.',
      },
    });
    expect(review.statusCode).toBe(200);
    const approve = await app.inject({
      method: 'POST',
      url,
      payload: { action: 'approve', id: initial.draft.id, revision: 3, requestId: 'approve' },
    });
    expect(approve.statusCode).toBe(200);
    expect(fixture.core.createSession).toHaveBeenCalledTimes(1);
    expect(fixture.core.createSession.mock.calls[0]?.[1].reviewedBrief?.text).toBe(
      'Local reading list. No login.',
    );
  } finally {
    await app.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP discovery works with zero projects and survives SQLite service restart without creating a build', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'discovery-http-'));
  const store = openStore({ dataDir: dir });
  const fixture = createFakeCore();
  const core = { ...fixture.core, listProjects: () => Promise.resolve([]) };
  const writer = {
    generate: (draft: IntakeDraft) =>
      Promise.resolve({
        message: draft.answers.length
          ? 'A quiet heads-up board can make chores visible without turning the home into a scoreboard.'
          : 'A calmer shared home could begin with a friendly heads-up board.',
        brief: 'Explore a calmer shared home',
        question: draft.answers.length
          ? 'Who should see each heads-up?'
          : 'Which daily friction matters most?',
        choices: [],
        unknowns: ['Main friction'],
        assumptions: [],
        confirmed: [{ statement: 'Calmer home', answerIds: ['original-goal'] }],
      }),
  };
  const intake = createIntakeService(store, core, writer);
  const app = await createServer({ core: { ...core, ...intake }, port: 0 });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/discovery',
      payload: { action: 'new', mode: 'interview', id: 'new', revision: 0, requestId: 'new-free' },
    });
    expect(created.statusCode).toBe(200);
    const initial = JSON.parse(created.body) as { draft: { id: string; revision: number } };
    const edit = await app.inject({
      method: 'POST',
      url: '/api/discovery',
      payload: {
        action: 'edit',
        id: initial.draft.id,
        revision: 1,
        requestId: 'free-edit',
        title: 'Calmer home',
        originalGoal: 'Help me design a calmer shared home',
        answers: [],
      },
    });
    expect(edit.statusCode).toBe(200);
    const generated = await app.inject({
      method: 'POST',
      url: '/api/discovery',
      payload: {
        action: 'generate',
        id: initial.draft.id,
        revision: 2,
        requestId: 'free-generate',
      },
    });
    expect(generated.statusCode).toBe(200);
    await vi.waitFor(async () =>
      expect((await intake.discoveryIntake()).draft?.status).toBe('review'),
    );
    const loaded = await app.inject({ method: 'GET', url: '/api/discovery' });
    expect(loaded.statusCode).toBe(200);
    expect(JSON.parse(loaded.body)).toEqual(
      await createIntakeService(store, core, writer).discoveryIntake(),
    );
    const first = (await intake.discoveryIntake()).draft!;
    const replied = await app.inject({
      method: 'POST',
      url: '/api/discovery',
      payload: {
        action: 'edit',
        id: first.id,
        revision: first.revision,
        requestId: 'free-reply',
        title: first.title,
        originalGoal: first.originalGoal,
        answers: [
          {
            id: 'reply-one',
            question: first.synthesis!.question,
            assistantMessage: first.synthesis!.message,
            answer: 'Chores, but no scores or nagging.',
            source: 'user',
          },
        ],
      },
    });
    expect(replied.statusCode).toBe(200);
    const secondRequest = await app.inject({
      method: 'POST',
      url: '/api/discovery',
      payload: {
        action: 'generate',
        id: first.id,
        revision: first.revision + 1,
        requestId: 'free-second-turn',
      },
    });
    expect(secondRequest.statusCode).toBe(200);
    await vi.waitFor(async () =>
      expect((await intake.discoveryIntake()).draft?.status).toBe('review'),
    );
    const second = (await createIntakeService(store, core, writer).discoveryIntake()).draft!;
    expect(second.synthesis?.message).toContain('without turning the home into a scoreboard');
    expect(second.answers[0]?.answer).toBe('Chores, but no scores or nagging.');
    expect(await core.listProjects()).toEqual([]);
    expect(second.destinationProjectId).toBeUndefined();
    expect(fixture.core.createSession).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
