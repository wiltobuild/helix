import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { fixtures, projectUpTo } from '@helix/contracts';
import { TooltipProvider } from '@helix/ui';
import type { HelixSource } from '../data/useHelixSource';
import { SessionHeader } from './Chrome';

test('the integrated session header exposes Design alongside Plan, Board, Files and Commits', () => {
  const events = fixtures.passwordResetRun;
  const state = projectUpTo(events, events.at(-1)!.seq);
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <SessionHeader
        state={state}
        source={{ mode: 'demo' } as HelixSource}
        title="Visual task"
        mode="paused"
        elapsedMs={0}
        tab="visual"
        onTab={() => {}}
        counts={{}}
        onNewTask={() => {}}
        onAddRepo={() => {}}
        onSelectRepo={() => {}}
        stopAll={null}
        repos={[state.project]}
        activeCount={0}
      />
    </TooltipProvider>,
  );
  expect(html).toMatch(/aria-selected="true"[^>]*>Design/);
  for (const label of ['Plan', 'Board', 'Files', 'Commits']) expect(html).toContain(`>${label}`);
});
