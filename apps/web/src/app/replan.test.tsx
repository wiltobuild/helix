import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { createProjector, fixtures, type HelixEvent } from '@helix/contracts';
import { TooltipProvider } from '@helix/ui';
import { boardCards } from '../data/describe';
import { planTree } from '../data/observatory';
import { Inspector } from './Inspector';

// Found in the first live run: after "Request changes", the orchestrator submits a second plan.
// Every view must follow the newest plan, not the rejected one.
const run = fixtures.passwordResetRun;
const submitIndex = run.findIndex((e) => e.type === 'plan.submitted');
const submitted = run[submitIndex]! as Extract<HelixEvent, { type: 'plan.submitted' }>;
const first = submitted.payload.plan;
const lastSeq = submitted.seq;
const events: HelixEvent[] = [
  ...run.slice(0, submitIndex + 1),
  {
    ...submitted,
    seq: lastSeq + 1,
    type: 'plan.rejected',
    payload: { planId: first.id, reason: 'Add a chart task' },
  } as HelixEvent,
  {
    ...submitted,
    seq: lastSeq + 2,
    payload: {
      plan: { ...first, id: `${first.id}_v2` as typeof first.id, goal: `${first.goal} (revised)` },
    },
  } as HelixEvent,
];

test('after a rejected plan, the newest plan is the one waiting for approval', () => {
  const projector = createProjector(events);
  const state = projector.at(lastSeq + 2);
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const index = events.length - 1;

  const tree = planTree(state, events, index, events[index]!.ts)!;
  expect(tree.plan.id).toBe(`${first.id}_v2`);
  expect(tree.orchestrator.statusLabel).toBe('Needs review');

  const card = boardCards(state, bySeq, events[index]!.ts).find(
    (c) => c.id === first.orchestratorSessionId,
  );
  expect(card?.status).toBe('needs_you');

  const html = renderToStaticMarkup(
    <TooltipProvider>
      <Inspector
        session={state.sessions[first.orchestratorSessionId]!}
        state={state}
        events={events}
        upTo={lastSeq + 2}
        onClose={() => {}}
        onJump={() => {}}
        tab="summary"
        onTabChange={() => {}}
        onSelect={() => {}}
        tree={tree}
      />
    </TooltipProvider>,
  );
  expect(html).toContain('Approve plan');
  expect(html).toContain('(revised)');
});
