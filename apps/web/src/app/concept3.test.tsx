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

test('AgentBadge renders Claude 12-ray ripple sunburst and Codex spinning hex-knot with active flag', () => {
  const claudeActive = renderToStaticMarkup(
    <AgentBadge agent="claude-code" variant="full" active />,
  );
  expect(claudeActive).toContain('data-active="true"');
  expect(claudeActive).toContain('Claude Code');
  expect(claudeActive).toContain('--agent:var(--strand-claude)');
  // 12 radial rays rotated 0..330deg around (16, 16)
  expect(claudeActive.match(/transform="rotate\(/g)?.length).toBe(12);
  expect(claudeActive).toContain('transform="rotate(0 16 16)"');
  expect(claudeActive).toContain('transform="rotate(330 16 16)"');

  const codexActive = renderToStaticMarkup(<AgentBadge agent="codex" active />);
  expect(codexActive).toContain('data-active="true"');
  expect(codexActive).toContain('codex');
  // Hexagonal knot path + 6 internal rotor links + 1 core circle
  expect(codexActive).toContain(
    'd="M16 3.5 L26.8 9.75 L26.8 22.25 L16 28.5 L5.2 22.25 L5.2 9.75 Z"',
  );
  expect(codexActive.match(/<line /g)?.length).toBe(6);

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
