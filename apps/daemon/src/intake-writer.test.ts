/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await -- Assertions inspect mock methods, and async test doubles model promise-returning ports. */
import { expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  projectIdSchema,
  type AgentHarness,
  type HarnessEmission,
  type HarnessSession,
  type IntakeDraft,
} from '@helix/contracts';
import { createIntakeWriter, intakePrompt } from './intake-writer.js';
const draft: IntakeDraft = {
  id: 'draft',
  revision: 1,
  title: 'Tracker',
  originalGoal: 'Student task tracker',
  mode: 'interview',
  answers: [],
  synthesis: null,
  versions: [],
  status: 'generating',
};
const result = {
  brief: 'Build a student tracker',
  question: 'What would disappoint you?',
  choices: [],
  unknowns: ['Negative constraints'],
  assumptions: [],
  confirmed: [{ statement: 'Tracker', answerIds: ['original-goal'] }],
};
test('writer uses existing harness, parses final output and stops its isolated session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'intake-writer-'));
  let emit!: (e: HarnessEmission) => void;
  const handle: HarnessSession = {
    send: vi.fn(async () => {
      emit({ type: 'activity.changed', payload: { activity: 'active' } });
      emit({
        type: 'chat.item',
        payload: { item: { kind: 'message', role: 'assistant', text: JSON.stringify(result) } },
      });
      emit({ type: 'activity.changed', payload: { activity: 'idle' } });
    }),
    onEvent: (cb) => {
      emit = cb;
      return vi.fn();
    },
    stop: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
  };
  const harness = { start: vi.fn(async () => handle) } as unknown as AgentHarness;
  try {
    const writer = createIntakeWriter(harness, dir, projectIdSchema.parse('project_test'));
    expect(
      await writer.generate(
        draft,
        new AbortController().signal,
        projectIdSchema.parse('project_test'),
      ),
    ).toEqual(result);
    expect(vi.mocked(harness.start).mock.calls[0]?.[0].cwd).toContain(path.join(dir, 'intake'));
    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(intakePrompt(draft)).toContain('No markdown fences');
    expect(intakePrompt(draft)).toContain('negative constraints');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('cancelled writer never starts an agent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'intake-cancel-'));
  const harness = { start: vi.fn() } as unknown as AgentHarness;
  const controller = new AbortController();
  controller.abort();
  try {
    await expect(
      createIntakeWriter(harness, dir, projectIdSchema.parse('project_test')).generate(
        draft,
        controller.signal,
        projectIdSchema.parse('project_test'),
      ),
    ).rejects.toThrow('Cancelled');
    expect(harness.start).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
