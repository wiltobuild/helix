import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
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
