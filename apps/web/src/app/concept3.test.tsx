import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { fixtures, projectUpTo } from '@helix/contracts';
import { AgentBadge, HelixLogo, SessionCard, TooltipProvider } from '@helix/ui';
import { PlanView } from './PlanView';

const { passwordResetRun: run } = fixtures;

test('HelixLogo renders two-strand DNA crossover with 4 base-pair rungs and active state', () => {
  const idleHtml = renderToStaticMarkup(<HelixLogo size={24} />);
  expect(idleHtml).not.toContain('data-active="true"');
  expect(idleHtml).toContain('width="24"');
  expect(idleHtml).toContain('height="24"');
  // 4 base-pair rungs + 2 strand paths + 4 endpoint nodes
  expect(idleHtml.match(/<line /g)?.length).toBe(4);
  expect(idleHtml.match(/<path /g)?.length).toBe(2);
  expect(idleHtml.match(/<circle /g)?.length).toBe(4);

  const activeBadgeHtml = renderToStaticMarkup(<HelixLogo size={38} active variant="badge" />);
  expect(activeBadgeHtml).toContain('data-active="true"');
  expect(activeBadgeHtml).toContain('width="38"');
  expect(activeBadgeHtml).toContain('<rect ');
});

test('AgentBadge renders Claude 12-ray ripple sunburst + outward ripple rings (3B) and Codex rotational hex-knot (2A) with active flag', () => {
  const claudeActive = renderToStaticMarkup(
    <AgentBadge agent="claude-code" variant="full" active />,
  );
  expect(claudeActive).toContain('data-active="true"');
  expect(claudeActive).toContain('Claude Code');
  expect(claudeActive).toContain('--agent:var(--strand-claude)');
  // 2 outward concentric ripple rings (r="10.8") + 1 core circle (r="2.8") = 3 circles
  expect(claudeActive.match(/<circle /g)?.length).toBe(3);
  expect(claudeActive.match(/r="10.8"/g)?.length).toBe(2);
  // 12 radial rays rotated around (12, 12)
  expect(claudeActive.match(/transform="rotate\(/g)?.length).toBe(12);
  expect(claudeActive).toContain('transform="rotate(0 12 12)"');
  expect(claudeActive).toContain('transform="rotate(330 12 12)"');

  const codexActive = renderToStaticMarkup(<AgentBadge agent="codex" active />);
  expect(codexActive).toContain('data-active="true"');
  expect(codexActive).toContain('codex');
  // Authentic OpenAI / Codex 6-fold hexagonal knot path
  expect(codexActive).toContain('d="M22.2819 9.8211');

  const codexIdle = renderToStaticMarkup(<AgentBadge agent="codex" />);
  expect(codexIdle).not.toContain('data-active="true"');
});

test('SessionCard activates AgentBadge emblem animation only when status is working', () => {
  const workingCard = renderToStaticMarkup(
    <SessionCard
      title="API reset token endpoint"
      agent="codex"
      status="working"
      statusLabel="Running tests"
    />,
  );
  expect(workingCard).toContain('data-status="working"');
  expect(workingCard).toContain('data-active="true"');

  const reviewCard = renderToStaticMarkup(
    <SessionCard
      title="API reset token endpoint"
      agent="codex"
      status="in_review"
      statusLabel="Ready for review"
    />,
  );
  expect(reviewCard).toContain('data-status="in_review"');
  expect(reviewCard).not.toContain('data-active="true"');
});

test('PlanView renders Concept 3 Flow Observatory bar and strand-colored dependency edges', () => {
  // At seq 15, workers are actively running in Wave 1
  const workingState = projectUpTo(run, 15);
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <PlanView state={workingState} selected={null} onSelect={() => {}} />
    </TooltipProvider>,
  );

  // Flow Observatory telemetry bar
  expect(html).toContain('aria-label="Plan strand summary"');
  expect(html).toContain('2 tasks');
  expect(html).toContain('1 task');

  // Strand-colored dependency edges
  expect(html).toContain('--edge-strand:var(--strand-claude)');
  expect(html).toContain('--edge-strand:var(--strand-codex)');
});
