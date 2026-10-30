import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { VisualWorkspace } from './VisualWorkspace';
import type { VisualWorkspaceView } from '../data/visualWorkspace';

const workspace: VisualWorkspaceView = {
  id: 'design-1',
  revision: 2,
  title: 'Coffee storefront',
  activeRoundId: 'round-2',
  affectedTasks: ['Build storefront'],
  conversation: [
    { id: 'feedback', revision: 1, role: 'user', text: 'More playful, keep the warm palette.' },
  ],
  decisions: [],
  rounds: [
    { id: 'round-1', revision: 1, status: 'ready', brief: 'Earlier brief', concepts: [] },
    {
      id: 'round-2',
      revision: 2,
      status: 'ready',
      brief: 'Warm, playful coffee shop',
      concepts: ['Editorial', 'Bold color', 'Craft'].map((title, index) => ({
        id: String(index),
        title,
        imageUrl: `https://example.com/render-${index}.png`,
        alt: `${title} storefront concept`,
        rationale: 'A distinctive direction',
        tradeoffs: ['More expressive typography'],
      })),
      recommendation: { conceptId: '1', rationale: 'Best fit for the playful brief' },
    },
  ],
};

test('three real asset references, freeform refinement, references, recommendation and reject-all are visible', () => {
  const html = renderToStaticMarkup(
    <VisualWorkspace workspace={workspace} connection="live" adapter={{ send: async () => {} }} />,
  );
  expect(html.match(/<img /g)).toHaveLength(3);
  expect(html).toContain('Reject all &amp; generate three');
  expect(html).toContain('Feedback, questions, or combination instructions');
  expect(html).toContain('Reference images or websites');
  expect(html).toContain('Best fit for the playful brief');
  expect(html).toContain('Round 1');
  expect(html).toContain('More playful, keep the warm palette.');
  expect(html).toContain('Unrelated work can continue');
});

test.each(['replay', 'disconnected'] as const)(
  '%s disables choices and generation',
  (connection) => {
    const html = renderToStaticMarkup(
      <VisualWorkspace
        workspace={workspace}
        connection={connection}
        adapter={{ send: async () => {} }}
      />,
    );
    const controls = html.match(/<(?:button|input|textarea)\b[^>]*>/g) ?? [];
    const decisionControls = controls.filter(
      (tag) => !tag.includes('aria-current') && !tag.includes('type="button"'),
    );
    expect(decisionControls.every((tag) => tag.includes('disabled'))).toBe(true);
    expect(html).toContain('read only');
    expect(
      html.match(/<button\b[^>]*>.*?<\/button>/g)?.find((button) => button.includes('Reject all')),
    ).toContain('disabled');
  },
);

test('unavailable generation explains setup without fabricating concepts', () => {
  const html = renderToStaticMarkup(<VisualWorkspace connection="unavailable" />);
  expect(html).toContain('supported image-generation provider');
  expect(html).toContain('No concepts have been generated');
  expect(html).not.toContain('<img');
});

test('checkpoint starts with an opt-in preview and binds approval to its revision', () => {
  const html = renderToStaticMarkup(
    <VisualWorkspace
      workspace={{
        ...workspace,
        checkpoint: {
          id: 'checkpoint',
          revision: 1,
          title: 'Homepage scaffold',
          summary: 'Hero implemented',
          recommendation: 'Check mobile spacing',
          status: 'ready',
          previewUrl: 'http://localhost:5173/',
          commit: 'abc123',
        },
      }}
      connection="live"
      adapter={{ send: async () => {} }}
    />,
  );
  expect(html).toContain('Open working preview');
  expect(html).toContain('abc123');
  expect(html).not.toContain('<iframe');
  expect(
    html
      .match(/<button\b[^>]*>.*?<\/button>/g)
      ?.find((button) => button.includes('Approve checkpoint')),
  ).toContain('disabled');
});
