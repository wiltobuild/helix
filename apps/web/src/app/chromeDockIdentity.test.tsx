import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { fixtures, projectUpTo, type HelixEvent } from '@helix/contracts';
import { TooltipProvider } from '@helix/ui';
import { indexIdentities, resolveIdentities, withIdentityIndex } from '../data/identity';
import { ganttLanes, planTree } from '../data/observatory';
import type { HelixSource } from '../data/useHelixSource';
import type { RunView } from '../data/useRun';
import { accountTime, timeMapping } from '../data/activeTime';
import { NavRail, type SessionSummary } from './Chrome';
import { Dock } from './Dock';

const noop = () => {};
const render = (node: ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const helixMark = 'data-helix="dna"';

function runAt(events: readonly HelixEvent[], seq: number): RunView {
  const identities = indexIdentities(events);
  const state = withIdentityIndex(projectUpTo(events, seq), identities);
  const latestState = withIdentityIndex(projectUpTo(events, events.at(-1)!.seq), identities);
  const index = events.findIndex((e) => e.seq === seq);
  const timing = accountTime(events);
  const mapping = timeMapping(timing, 'elapsed');
  return {
    timing,
    mapping,
    timeMode: 'elapsed',
    position: mapping.forward(timing.times[index]!),
    eventTime: (i) => mapping.forward(timing.times[i]!),
    setTimeMode: vi.fn(),
    seekTime: vi.fn(),
    key: () => false,
    events,
    state,
    latestState,
    index,
    current: events[index]!,
    isLive: false,
    seek: vi.fn(),
    step: vi.fn(),
    goLive: vi.fn(),
    playing: false,
    togglePlay: vi.fn(),
    bySeq: new Map(events.map((e) => [e.seq, e])),
  };
}

function source(events: readonly HelixEvent[]): HelixSource {
  return {
    sourceId: 'demo:identity',
    mode: 'demo',
    events,
    projects: [],
    stream: 'demo',
    selectProject: noop,
    addProject: async () => {},
    openRecording: async () => {},
    speed: 1,
    setSpeed: noop,
    staticBuild: true,
  };
}

test('Chrome shows role before task and provider, with trace IDs and original navigation targets', () => {
  const run = runAt(fixtures.passwordResetRun, 15);
  const identities = [...resolveIdentities(run.state).values()];
  const summary = (id: string): SessionSummary => ({
    id,
    identity: identities.find((x) => x.sessionId === id)!,
    title: identities.find((x) => x.sessionId === id)!.taskTitle,
    status: 'working',
    meta: '1m',
    live: true,
  });
  const orchestrator = identities.find((x) => x.role === 'orchestrator')!;
  const worker = identities.find((x) => x.role === 'author')!;
  const onPage = vi.fn();
  const onOpenSession = vi.fn();
  const rail = NavRail({
    project: run.state.project,
    page: 'sessions',
    counts: {},
    active: summary(orchestrator.sessionId),
    recent: [summary(worker.sessionId)],
    onPage,
    onOpenSession,
    onSettings: noop,
  });
  const html = render(rail);
  expect(html).toContain(helixMark);
  expect(html).toContain('>Helix</span>');
  expect(html).toContain(worker.name);
  expect(html).toContain(worker.sessionId);
  expect(html).toContain(worker.planNodeId);
  expect(html.indexOf(worker.name)).toBeLessThan(html.indexOf(worker.taskTitle));
  // Exercise the existing button handlers without a browser or service.
  function visit(node: ReactNode) {
    Children.forEach(node, (child) => {
      if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
      if (child.type === 'button' && render(child).includes(worker.name)) child.props.onClick?.();
      visit(child.props.children);
    });
  }
  visit(rail);
  expect(onPage).toHaveBeenCalledExactlyOnceWith('sessions');
  expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(worker.sessionId);
});

test('Dock exposes stable task and reviewer lanes while preserving replay controls and history', () => {
  const events = fixtures.crossReviewRun;
  const run = runAt(events, fixtures.crossReviewMilestones.changesRequested);
  const tree = planTree(run.state, events, run.index, run.current.ts);
  const html = render(
    <Dock
      run={run}
      source={source(events)}
      tree={tree}
      expanded={false}
      onExpand={noop}
      onSelectSession={noop}
    />,
  );
  expect(html).toContain('Discount Codes Engineer');
  expect(html).toContain('Discount Codes Reviewer');
  expect(html).toContain('Discount Codes Reviewer requested changes');
  expect(html).toContain(fixtures.crossReviewIds.worker);
  expect(html).toContain(fixtures.crossReviewIds.reviewer);
  expect(html).toContain('aria-label="Replay speed"');
  expect(html).toContain('aria-label="Jump to end"');
  expect(html).toContain('aria-label="Expand timeline"');
  expect(html).toContain('type="range"');
  const names = () => ganttLanes(events, run.index, run.state, tree).lanes.map((l) => l.label);
  const before = names();
  run.state.sessions[fixtures.crossReviewIds.worker]!.session.agent = 'claude-code';
  run.state.sessions[fixtures.crossReviewIds.reviewer]!.session.agent = 'codex';
  expect(names()).toEqual(before);
});

test('Dock uses the canonical Helix identity before a plan exists and when replaying a full plan', () => {
  const events = fixtures.passwordResetRun;
  const planIndex = events.findIndex((e) => e.type === 'plan.submitted');
  for (const log of [events.slice(0, planIndex), events]) {
    const run = runAt(log, log[1]!.seq);
    const html = render(
      <Dock
        run={run}
        source={source(log)}
        tree={undefined}
        expanded={false}
        onExpand={noop}
        onSelectSession={noop}
      />,
    );
    expect(html).toContain(helixMark);
    expect(html).toContain('>Helix</span>');
    expect(html).not.toContain('>Orchestrator</span>');
    expect(html).not.toContain('Helix 2');
  }
});
