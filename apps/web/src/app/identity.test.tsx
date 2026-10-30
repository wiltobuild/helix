import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ActorBadge, SessionCard } from '@helix/ui';

// The canonical two-strand Helix mark; the Codex hex-knot path. Used to prove which emblem renders.
const HELIX_STRAND = 'd="M8 4 C24 10';
const CODEX_KNOT = 'd="M22.2819 9.8211';

test('the orchestrator actor wears the canonical HelixLogo, never a provider emblem', () => {
  const html = renderToStaticMarkup(
    <ActorBadge name="Helix" role="orchestrator" agent="claude-code" active />,
  );
  expect(html).toContain('data-role="orchestrator"');
  expect(html).toContain('Helix');
  expect(html).toContain(HELIX_STRAND);
  // Four base-pair rungs confirm it is the real HelixLogo symbol, not an invented one.
  expect(html.match(/<line /g)?.length).toBe(4);
  expect(html).not.toContain(CODEX_KNOT);
  expect(html).toContain('data-active="true"');
});

test('an author actor leads with its task name and keeps the provider/model secondary', () => {
  const html = renderToStaticMarkup(
    <ActorBadge name="Catalog Architect" role="author" agent="codex" model="gpt-x" active />,
  );
  expect(html).toContain('data-role="author"');
  expect(html).toContain('Catalog Architect');
  expect(html).toContain('codex');
  expect(html).toContain('gpt-x');
  // The provider emblem is the Codex knot, not the Helix mark.
  expect(html).toContain(CODEX_KNOT);
  expect(html).not.toContain(HELIX_STRAND);
});

test('a reviewer actor is tagged so it never reads as the author', () => {
  const author = renderToStaticMarkup(
    <ActorBadge name="Discount Codes Engineer" role="author" agent="codex" />,
  );
  const reviewer = renderToStaticMarkup(
    <ActorBadge name="Discount Codes Reviewer" role="reviewer" agent="claude-code" />,
  );
  expect(author).not.toContain('reviews');
  expect(reviewer).toContain('data-role="reviewer"');
  expect(reviewer).toContain('reviews');
  expect(reviewer).toContain('Discount Codes Reviewer');
});

test('idle actor does not animate its emblem', () => {
  const html = renderToStaticMarkup(<ActorBadge name="Helix" role="orchestrator" agent="codex" />);
  expect(html).not.toContain('data-active="true"');
});

test('SessionCard shows the actor identity as primary while keeping the task title', () => {
  const html = renderToStaticMarkup(
    <SessionCard
      title="Issue single-use expiring reset tokens"
      agent="codex"
      status="working"
      actor={{ name: 'Password Reset Architect', role: 'author', agent: 'codex', active: true }}
    />,
  );
  // Identity is the primary actor label…
  expect(html).toContain('Password Reset Architect');
  expect(html).toContain('data-role="author"');
  // …and the task title is still present as the card's content.
  expect(html).toContain('Issue single-use expiring reset tokens');
  expect(html).toContain('data-active="true"');
});

test('SessionCard without an actor falls back to the plain provider badge', () => {
  const html = renderToStaticMarkup(
    <SessionCard title="Some task" agent="claude-code" status="in_review" />,
  );
  expect(html).toContain('Some task');
  expect(html).toContain('claude');
  expect(html).not.toContain('data-role="author"');
});
