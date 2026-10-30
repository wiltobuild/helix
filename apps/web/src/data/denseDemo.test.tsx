import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@helix/ui';
import { PlanView } from '../app/PlanView';
import { deriveStatus } from '@helix/contracts';
import { denseDemoRun, denseDemoEvents } from './denseDemo';
import { accountTime } from './activeTime';
import { createSafeProjector } from './safeProjection';
import { demoSelection, builtInRun, presetRecording } from './demoScenarios';
import { planTree } from './observatory';

test('the laptop scenario is deterministic, explicitly simulated and local-only', () => {
  expect(denseDemoRun()).toEqual(denseDemoEvents);
  expect(demoSelection('laptop').preset).toBe('laptop');
  expect(builtInRun('laptop')).toBe(denseDemoEvents);
  expect(presetRecording('laptop')).toBeUndefined();
});

test('every dense replay cursor projects safely with twelve workers and distinct wait states', () => {
  const projector = createSafeProjector(accountTime(denseDemoEvents));
  for (const event of denseDemoEvents) expect(projector.at(event.seq).ok).toBe(true);
  const last = denseDemoEvents.at(-1)!;
  const projected = projector.at(last.seq);
  if (!projected.ok) throw new Error(projected.error);
  const state = projected.state;
  expect(state.project.name).toContain('SIMULATED');
  const workers = Object.values(state.sessions).filter((entry) => entry.session.role === 'worker');
  expect(workers).toHaveLength(12);
  expect(workers.filter((worker) => deriveStatus(worker) === 'merged')).toHaveLength(2);
  expect(workers.some((worker) => deriveStatus(worker) === 'needs_you')).toBe(true);
  expect(workers.some((worker) => worker.pr?.checks.pending === 1)).toBe(true);
  expect(workers.some((worker) => worker.agentReview?.review?.findings.length === 2)).toBe(true);
  expect(denseDemoEvents.some((event) => event.type === 'agent_review.abandoned')).toBe(true);
  const tree = planTree(state, denseDemoEvents, denseDemoEvents.length - 1, last.ts)!;
  expect(tree.workers).toHaveLength(12);
  expect(tree.tasks.filter((task) => task.status === 'pending')).toHaveLength(4);
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <PlanView
        state={state}
        events={denseDemoEvents}
        index={denseDemoEvents.length - 1}
        selected={null}
        onSelect={() => {}}
      />
    </TooltipProvider>,
  );
  expect(html.match(/data-worker-node=/g)).toHaveLength(12);
  const reviews = [
    ...html.matchAll(
      /data-review-node="([^"]+)" style="left:([\d.]+)px;top:([\d.]+)px;width:([\d.]+)px"/g,
    ),
  ];
  expect(reviews).toHaveLength(12);
  for (const [, id, left, top, width] of reviews) {
    const task = html.match(
      new RegExp(
        `data-motion-key="${id}" style="left:([\\d.]+)px;top:([\\d.]+)px;width:([\\d.]+)px;height:([\\d.]+)px`,
      ),
    );
    expect(task).not.toBeNull();
    expect(Number(left) + Number(width) / 2).toBe(Number(task![1]) + Number(task![3]) / 2);
    expect(Number(top)).toBe(Number(task![2]) + Number(task![4]) + 24);
  }
  // Twelve one-task columns no longer reserve lateral review-card space.
  expect(html).toContain('width:4416px;height:500px');
  expect(html).toContain('Reviewer unavailable');
  expect(html).toMatch(/2(?:<!-- -->)? findings/);
  expect(html).toContain('<summary>Graph options</summary>');
  expect(html).not.toContain('Replay cursor');
});
