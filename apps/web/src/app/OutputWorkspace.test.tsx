import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { fixtures, projectUpTo } from '@helix/contracts';
import type { HelixClient } from '@helix/api-client';
import { OutputWorkspace } from './OutputWorkspace';

test('replay and disconnect show evidence without mounting an iframe or requesting a lease', () => {
  const events = fixtures.passwordResetRun;
  const state = projectUpTo(events, events.at(-1)!.seq);
  const worker = Object.values(state.sessions).find(
    (s) => s.session.role === 'worker' && s.worktree,
  )!;
  worker.output = {
    workerSessionId: worker.session.id,
    buildSessionId: worker.session.id,
    revision: 3,
    branch: 'helix/frontend',
    headSha: 'a'.repeat(40),
    briefHash: 'b'.repeat(64),
    designHash: 'c'.repeat(64),
    artifactHash: 'd'.repeat(64),
    status: 'running',
    message: 'Static export',
    feedback: [
      {
        id: 'feedback',
        revision: 2,
        headSha: 'a'.repeat(40),
        text: 'Increase spacing',
        status: 'routed',
        disposition: 'Queued to worker',
      },
    ],
  };
  const outputLease = vi.fn();
  for (const isLive of [true, false]) {
    const html = renderToStaticMarkup(
      <OutputWorkspace
        state={state}
        events={events}
        isLive={isLive}
        connected={false}
        client={{ outputLease } as unknown as HelixClient}
      />,
    );
    expect(html).not.toContain('<iframe');
    expect(html).toContain('Increase spacing');
    expect(html).toContain('helix/frontend');
    expect(html).toContain('disabled');
  }
  expect(outputLease).not.toHaveBeenCalled();
});
