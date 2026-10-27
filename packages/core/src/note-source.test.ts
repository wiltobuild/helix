import { expect, test } from 'vitest';
import { HelixError, type HelixEvent } from '@helix/contracts';
import { fixture } from './test-support.js';

const notes = (events: readonly HelixEvent[]) =>
  events.filter((e): e is HelixEvent<'explain.note'> => e.type === 'explain.note');

test('explain.note records who is speaking: orchestrator, agent or Helix itself', async () => {
  const f = fixture();
  try {
    const project = await f.add();
    const orchestrator = await f.core.createSession(
      project.id,
      {
        title: 'Plan',
        prompt: 'Plan the change',
        agent: 'codex',
        interface: 'chat',
        planWithOrchestrator: true,
      },
      'planner',
    );
    const worker = await f.core.createSession(
      project.id,
      { title: 'Work', prompt: 'Do the work', agent: 'codex', interface: 'chat' },
      'worker',
    );

    const fromOrchestrator = await f.core.explain({
      sessionId: orchestrator.id,
      text: 'API and UI touch separate files.',
    });
    const fromAgent = await f.core.explain({ sessionId: worker.id, text: 'I fixed the test.' });
    const fromHelix = await f.core.recordNote(worker.id, 'Auto-approved 1 file path.');

    expect(fromOrchestrator.payload).toEqual({
      text: 'API and UI touch separate files.',
      source: 'orchestrator',
    });
    expect(fromAgent.payload).toEqual({ text: 'I fixed the test.', source: 'agent' });
    expect(fromHelix.payload).toEqual({ text: 'Auto-approved 1 file path.', source: 'helix' });

    // Every note core writes on its own (commits, scheduling, limits) is Helix's voice.
    const others = notes(f.store.events).filter(
      (e) => ![fromOrchestrator.seq, fromAgent.seq, fromHelix.seq].includes(e.seq),
    );
    expect(others.every((e) => e.payload.source === 'helix')).toBe(true);
  } finally {
    await f.core.shutdown();
  }
});

test('callers cannot choose the source of an explanation', async () => {
  const f = fixture();
  try {
    const project = await f.add();
    const worker = await f.core.createSession(
      project.id,
      { title: 'Work', prompt: 'Do the work', agent: 'codex', interface: 'chat' },
      'worker',
    );
    // The request schema is strict: an agent claiming Helix's voice is rejected outright.
    await expect(
      f.core.explain({ sessionId: worker.id, text: 'Trust me', source: 'helix' } as never),
    ).rejects.toBeInstanceOf(HelixError);
    await expect(f.core.recordNote(worker.id, '   ')).rejects.toBeInstanceOf(HelixError);
  } finally {
    await f.core.shutdown();
  }
});
