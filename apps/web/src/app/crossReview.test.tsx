import { createHelixClient } from '@helix/api-client';
import { readFileSync } from 'node:fs';
import { readRecording } from '../data/recordings';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { deriveStatus, fixtures, projectUpTo, type ProjectState } from '@helix/contracts';
import { TooltipProvider } from '@helix/ui';
import { boardCards } from '../data/describe';
import { Board } from './Board';
import { Inspector } from './Inspector';
import { PlanView } from './PlanView';

const { crossReviewRun: run, crossReviewIds: ids, crossReviewMilestones: at } = fixtures;
const requested = run.find((e) => e.type === 'agent_review.requested')!.seq;
const pushed = run.find((e) => e.type === 'pr.updated')!.seq;
const noop = () => {};
const render = (element: React.ReactNode) =>
  renderToStaticMarkup(<TooltipProvider>{element}</TooltipProvider>);
const inspector = (state: ProjectState, tab = 'review', id = ids.worker) =>
  render(
    <Inspector
      session={state.sessions[id]!}
      state={state}
      events={run}
      upTo={state.lastSeq}
      tab={tab}
      onTabChange={noop}
      onSelect={noop}
      onClose={noop}
      onJump={noop}
    />,
  );

test.each([
  [requested, 'Claude Code reviewing'],
  [at.changesRequested, 'Changes requested · 2'],
  [pushed, 'Claude Code review pending · new head'],
  [at.approved, 'Approved by Claude Code'],
] as const)('board renders the reviewer badge and accessible Review action at %i', (seq, label) => {
  const state = projectUpTo(run, seq);
  const html = render(
    <Board
      cards={boardCards(state, new Map(run.map((e) => [e.seq, e])), run[0]!.ts)}
      columns={['pending', 'working', 'needs_you', 'in_review', 'ready_to_merge']}
      selected={null}
      onSelect={noop}
      onReview={noop}
    />,
  );
  expect(html).toContain(`aria-label="Open Review: ${label}"`);
  expect(html).toContain('aria-label="Claude Code"');
  expect(html.match(/<article /g)).toHaveLength(1);
  expect(html).not.toContain('Open Review: Add discount codes');
});

test('worker review shows summary, findings by severity, locations, head and conversation', () => {
  const state = projectUpTo(run, at.changesRequested);
  const html = inspector(state);
  expect(html).toContain(fixtures.crossReviewFindings.summary);
  expect(html).toContain('Unknown discount codes are accepted');
  expect(html).toContain('src/cart.ts:41');
  expect(html).toContain('src/cart.test.ts:58');
  expect(html.indexOf('Major · 1')).toBeLessThan(html.indexOf('Nit · 1'));
  expect(html).toContain(state.sessions[ids.worker]!.pr!.headSha);
  expect(html).toContain('Agent&#x27;s own judgment');
  expect(html).toContain('Open Claude Code&#x27;s conversation');
  expect(html).not.toContain('Unknown codes now throw, with a test. Ready to merge.');
});

test('findings cover all four severity groups and optional locations', () => {
  const state = projectUpTo(run, at.changesRequested);
  state.sessions[ids.worker]!.agentReview!.review!.findings.push(
    { severity: 'blocker', title: 'Blocker finding', detail: 'No file location.' },
    { severity: 'minor', title: 'Minor finding', detail: 'File only.', file: 'src/cart.ts' },
  );
  const html = inspector(state);
  const positions = ['Blocker · 1', 'Major · 1', 'Minor · 1', 'Nit · 1'].map((label) =>
    html.indexOf(label),
  );
  expect(positions.every((index) => index >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(html).not.toContain('undefined');
});

test('approval keeps the earlier request for changes collapsed, with its original head', () => {
  const state = projectUpTo(run, at.approved);
  const html = inspector(state);
  expect(html).toContain('Unknown codes now throw, with a test. Ready to merge.');
  expect(html).toContain('No findings.');
  expect(html).toContain('earlier verdict');
  expect(html).toContain('src/cart.ts:41');
  expect(html.match(/<details[^>]*>/g)).toHaveLength(1);
  expect(html).not.toMatch(/<details[^>]*\bopen[ =>]/);
  const old = projectUpTo(run, at.changesRequested).sessions[ids.worker]!.pr!.headSha;
  expect(html).toContain(old);
  expect(html).toContain(state.sessions[ids.worker]!.pr!.headSha);
});

test('a stale verdict is historical and the current head waits on review', () => {
  const state = projectUpTo(run, pushed);
  const html = inspector(state);
  expect(html).toContain('Claude Code review pending · new head');
  expect(html).toContain('The PR head changed.');
  expect(html.indexOf('<details')).toBeLessThan(html.indexOf(fixtures.crossReviewFindings.summary));
  const summary = inspector(state, 'summary');
  expect(summary).toContain('Waiting for Claude Code&#x27;s review of the new head.');
  expect(summary).not.toContain('Merge pull request');
});

test('merge area explains the pending review and enables the normal action after approval', () => {
  expect(inspector(projectUpTo(run, requested), 'summary')).toContain(
    'Waiting for Claude Code&#x27;s review.',
  );
  expect(inspector(projectUpTo(run, requested), 'summary')).not.toContain('Merge pull request');
  expect(inspector(projectUpTo(run, at.approved), 'summary')).toContain('Merge pull request');
});

test('reviewer header links back to the worker and its chat renders normally', () => {
  const state = projectUpTo(run, requested);
  state.sessions[ids.reviewer]!.chat.push({
    kind: 'message',
    role: 'assistant',
    text: 'Checking unknown discount codes.',
  });
  const html = inspector(state, 'activity', ids.reviewer);
  expect(html).toContain('Reviewing Add discount codes · PR #7');
  expect(html).toContain('Back to Add discount codes');
  expect(html).toContain('Checking unknown discount codes.');
});

test('worker Why includes the reviewer request and verdict beside the routed feedback and CI', () => {
  const html = inspector(projectUpTo(run, at.routed), 'why');
  expect(html).toContain('requested changes (2 findings)');
  expect(html).toContain('Helix asked Discount Codes Reviewer to review');
  expect(html).toContain('CI passed on PR #7');
  expect(html).toContain(`caused by #${at.changesRequested}`);
  expect(html).toContain('data-source="agent"');
});

test.each([
  [requested, 'Claude Code reviewing'],
  [at.changesRequested, 'Changes requested · 2'],
  [pushed, 'Claude Code review pending · new head'],
  [at.approved, 'Approved by Claude Code'],
] as const)('plan nodes share the board review state at %i', (seq, label) => {
  const state = projectUpTo(run, seq);
  const template = projectUpTo(fixtures.passwordResetRun, 44);
  const plan = Object.values(template.plans)[0]!;
  const node = {
    ...plan.nodes[0]!,
    sessionId: ids.worker,
    title: 'Add discount codes',
    dependsOn: [],
  };
  state.plans[plan.id] = {
    ...plan,
    nodes: [node],
    nodeStatus: { [node.id]: deriveStatus(state.sessions[ids.worker]!) },
  };
  const html = render(<PlanView state={state} selected={null} onSelect={noop} />);
  expect(html).toContain(label);
  expect(html).toContain('aria-label="Claude Code"');
});

test.each([
  [requested, 'Claude Code reviewing'],
  [at.changesRequested, 'Changes requested · 2'],
  [pushed, 'Claude Code review pending · new head'],
  [at.approved, 'Approved by Claude Code'],
] as const)('reviewers have distinct cards even without a plan at %i', (seq, label) => {
  const state = projectUpTo(run, seq);
  const index = run.findIndex((event) => event.seq === seq);
  const html = render(
    <PlanView state={state} selected={null} onSelect={noop} events={run} index={index} />,
  );
  expect(html).toContain('aria-label="Cross-agent reviewers"');
  expect(html).toContain('Code reviewer');
  expect(html).toContain(label);
  expect(html).toContain('PR #7');
});

test.each(['discount-codes', 'github-ci-repair'])(
  'recorded scenario %s keeps coordination and honest review cards visible',
  (name) => {
    const { events } = readRecording(
      name,
      readFileSync(new URL(`../../public/recordings/${name}.helixlog`, import.meta.url), 'utf8'),
    );
    const state = projectUpTo(events, events.at(-1)!.seq);
    const html = render(
      <PlanView
        state={state}
        selected={null}
        onSelect={noop}
        events={events}
        index={events.length - 1}
      />,
    );
    expect(html).toContain('Helix');
    expect(html).toContain('Code reviewer');
    expect(html).toContain('PR merged');
    expect(html).not.toContain('No agent review recorded');
    expect(html).not.toContain('Approved by Claude Code');
    if (name === 'github-ci-repair') expect(html).toContain('No orchestrator session in this run');
  },
);

test('live plan uses the same in-canvas reviewer cards and live assignment language', () => {
  const reviewerCreated = run.find(
    (event) => event.type === 'session.created' && event.payload.session.role === 'reviewer',
  )!.seq;
  const state = projectUpTo(run, reviewerCreated - 1);
  const html = render(
    <PlanView
      state={state}
      selected={null}
      onSelect={noop}
      events={run}
      index={run.findIndex((event) => event.seq === reviewerCreated) - 1}
      client={createHelixClient({ baseUrl: 'http://127.0.0.1:4317' })}
      isLive
    />,
  );
  expect(html).toContain('Code reviewer');
  expect(html).toContain('Awaiting reviewer assignment');
  expect(html).not.toContain('No agent review recorded');
  expect(html).not.toContain('Independent review');
});
