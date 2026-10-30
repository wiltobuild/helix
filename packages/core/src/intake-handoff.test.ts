import { expect, test } from 'vitest';
import { projectBuilds } from '@helix/contracts';
import { fixture } from './test-support.js';

test('approved brief survives events and reaches planner and existing design stage without rewriting build goal', async () => {
  const f = fixture({ orchestratorPrompt: () => 'Plan this build; wait for approval.' });
  try {
    const project = await f.add();
    const original = 'Help students organize their work';
    const reviewedBrief = {
      intakeId: 'intake-test',
      revision: 4,
      text: 'Build a student task tracker web app with a calm dashboard. No social feed.',
      approvedAt: '2026-10-30T00:00:00.000Z',
      answers: [],
      assumptions: ['Use a calm palette'],
    };
    const root = await f.core.createSession(
      project.id,
      {
        title: 'Student tracker',
        prompt: original,
        reviewedBrief,
        agent: 'codex',
        interface: 'chat',
        planWithOrchestrator: true,
      },
      'approved-intake',
    );
    await f.drain();
    expect(root.prompt).toBe(original);
    expect(projectBuilds(f.state(project.id))[0]?.goal).toBe(original);
    expect(f.state(project.id).sessions[root.id]?.session.reviewedBrief).toEqual(reviewedBrief);
    const design = (await f.core.sessionDesign!(root.id)).design;
    expect(design?.brief).toContain(reviewedBrief.text);
    expect(design?.brief).toContain(original);
    expect(f.harness.handles.get(root.id)?.send.mock.calls[0]?.[0]).toContain(reviewedBrief.text);
    expect(
      Object.values(f.state(project.id).sessions).filter((s) => s.session.role === 'worker'),
    ).toHaveLength(0);
    expect(design?.brief).toContain('Use a calm palette');
    expect(f.harness.handles.get(root.id)?.send.mock.calls[0]?.[0]).toContain('Use a calm palette');
  } finally {
    await f.core.shutdown();
  }
});
