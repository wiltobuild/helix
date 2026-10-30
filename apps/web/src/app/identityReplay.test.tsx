import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { fixtures, helixEventSchema, projectUpTo, type HelixEvent } from '@helix/contracts';
import { ActorBadge, TooltipProvider } from '@helix/ui';
import { describeEvent } from '../data/describe';
import {
  indexIdentities,
  resolveIdentities,
  resolveProjectIdentities,
  withIdentityIndex,
} from '../data/identity';
import { PlanView } from './PlanView';
import { Inspector } from './Inspector';
import { Dock } from './Dock';
import { CommitsView } from './SessionViews';
import type { HelixSource } from '../data/useHelixSource';

const noop = () => {};
const render = (element: React.ReactNode) =>
  renderToStaticMarkup(<TooltipProvider>{element}</TooltipProvider>);
const template = projectUpTo(fixtures.passwordResetRun, 44);
const plan = Object.values(template.plans)[0]!;
const orch = template.sessions[plan.orchestratorSessionId]!.session;
const worker = template.sessions[fixtures.passwordResetIds.api]!.session;

function collisionRun() {
  const events: HelixEvent[] = [fixtures.passwordResetRun[0]!];
  const add = (type: string, payload: unknown, sessionId?: string) => {
    const event = helixEventSchema.parse({
      v: 1,
      seq: events.length + 1,
      ts: orch.createdAt,
      projectId: orch.projectId,
      type,
      payload,
      ...(sessionId ? { sessionId } : {}),
    });
    events.push(event);
    return event.seq;
  };
  add('session.created', { session: orch }, orch.id);
  const submitted = fixtures.passwordResetRun.find((e) => e.type === 'plan.submitted')!;
  if (submitted.type !== 'plan.submitted') throw new Error('Missing fixture plan');
  const nodes = submitted.payload.plan.nodes.slice(0, 2).map((node, index) => ({
    ...node,
    title: index === 0 ? 'Catalog schema' : 'Catalog API',
    dependsOn: [],
  }));
  add('plan.submitted', { plan: { ...submitted.payload.plan, nodes } }, orch.id);
  const approved = add('plan.approved', { planId: plan.id, approvedBy: 'human' }, orch.id);
  const create = (id: string, nodeIndex: number, agent = 'codex') =>
    add(
      'session.created',
      {
        session: {
          ...worker,
          id,
          agent,
          title: 'Execute approved work',
          planNodeId: nodes[nodeIndex]!.id,
          createdAt: orch.createdAt,
        },
      },
      id,
    );
  // Workers start in reverse plan order, with lexically decreasing IDs and equal timestamps.
  create('sess_z', 1);
  const started = create('sess_a', 0);
  const replaced = create('sess_replacement', 0, 'claude-code');
  add(
    'session.created',
    { session: { ...orch, id: 'sess_second_orchestrator' } },
    'sess_second_orchestrator',
  );
  return { events, approved, started, replaced, nodes };
}

function at(events: readonly HelixEvent[], seq: number) {
  return withIdentityIndex(projectUpTo(events, seq, { strict: true }), indexIdentities(events));
}

test('plan collisions are reserved before execution and survive reverse attachment and replacement', () => {
  const { events, approved, started, replaced, nodes } = collisionRun();
  for (const seq of [approved, started, replaced, approved]) {
    const state = at(events, seq);
    const identities = resolveProjectIdentities(state);
    expect(identities.nodes.get(nodes[0]!.id)?.name).toBe('Catalog Architect');
    expect(identities.nodes.get(nodes[1]!.id)?.name).toBe('Catalog Architect 2');
    const html = render(<PlanView state={state} selected={null} onSelect={noop} isLive={false} />);
    expect(html).toContain('Catalog Architect</strong>');
    expect(html).toContain('Catalog Architect 2</strong>');
    if (seq >= started) {
      expect(identities.sessions.get('sess_a')?.name).toBe('Catalog Architect');
      expect(identities.sessions.get('sess_z')?.name).toBe('Catalog Architect 2');
    }
    if (seq >= replaced) {
      expect(identities.sessions.get('sess_replacement')).toMatchObject({
        name: 'Catalog Architect',
        agent: 'claude-code',
      });
    }
  }
});

test('later plans do not renumber earlier standalone workers, including incremental replay', () => {
  const { events } = collisionRun();
  const standalone = helixEventSchema.parse({
    ...events[1]!,
    payload: {
      session: {
        ...worker,
        id: 'sess_standalone',
        planNodeId: undefined,
        title: 'Catalog API',
        createdAt: orch.createdAt,
      },
    },
  });
  // Put the standalone session before the plan and rebuild sequence numbers.
  const log = [events[0]!, { ...standalone, sessionId: undefined }, ...events.slice(1)].map(
    (event, i) => helixEventSchema.parse({ ...event, seq: i + 1 }),
  );
  for (let count = 2; count <= log.length; count++) {
    const prefix = log.slice(0, count);
    const incremental = at(prefix, count);
    expect(resolveIdentities(incremental).get('sess_standalone')?.name).toBe('Catalog Architect');
    expect(resolveIdentities(at(log, count))).toEqual(resolveIdentities(incremental));
  }
  expect(
    [...resolveProjectIdentities(at(log, log.length)).nodes.values()].map((n) => n.name),
  ).toEqual(['Catalog Architect 2', 'Catalog Architect 3']);
});

test('every orchestrator is exactly Helix with distinct trace IDs and the canonical logo', () => {
  const { events } = collisionRun();
  const identities = [...resolveIdentities(at(events, events.length)).values()].filter(
    (i) => i.role === 'orchestrator',
  );
  expect(identities.map((i) => i.name)).toEqual(['Helix', 'Helix']);
  expect(new Set(identities.map((i) => i.sessionId)).size).toBe(2);
  for (const identity of identities) {
    const html = render(<ActorBadge {...identity} name="Helix 2" title={identity.sessionId} />);
    expect(html).toContain('>Helix</span>');
    expect(html).not.toContain('Helix 2');
    expect(html).toContain('d="M8 4 C24 10');
    expect(html).toContain(identity.sessionId);
  }
});

test('timeline and inspector history retain worker/reviewer identities across provider changes', () => {
  const {
    crossReviewRun: events,
    crossReviewIds: ids,
    crossReviewMilestones: milestones,
  } = fixtures;
  const state = at(events, milestones.routed);
  const current = events.find((e) => e.seq === milestones.changesRequested)!;
  const before = describeEvent(current, state);
  state.sessions[ids.worker]!.session.agent = 'claude-code';
  state.sessions[ids.reviewer]!.session.agent = 'codex';
  expect(describeEvent(current, state)).toBe(before);
  expect(before).toContain('Discount Codes Reviewer requested changes');
  const history = render(
    <Inspector
      session={state.sessions[ids.worker]!}
      state={state}
      events={events}
      upTo={milestones.routed}
      tab="why"
      onTabChange={noop}
      onSelect={noop}
      onClose={noop}
      onJump={noop}
    />,
  );
  expect(history).toContain('Discount Codes Reviewer requested changes');
  expect(history).toContain('findings back to Discount Codes Engineer');
  expect(history).not.toContain('Codex requested changes');
  const timeline = render(
    <Dock
      source={
        {
          mode: 'demo',
          events,
          projects: [],
          stream: 'demo',
          selectProject: noop,
          addProject: async () => {},
          openRecording: async () => {},
          staticBuild: true,
          speed: 1,
          setSpeed: noop,
        } satisfies HelixSource
      }
      tree={undefined}
      expanded={false}
      onExpand={noop}
      onSelectSession={noop}
      run={{
        events,
        state,
        latestState: state,
        current,
        index: events.indexOf(current),
        isLive: false,
        seek: noop,
        step: noop,
        goLive: noop,
        playing: false,
        togglePlay: noop,
        bySeq: new Map(events.map((e) => [e.seq, e])),
      }}
    />,
  );
  expect(timeline).toContain('Discount Codes Reviewer requested changes');
  const created = events.find(
    (e) => e.type === 'session.created' && e.payload.session.id === ids.worker,
  )!;
  expect(describeEvent(created, state)).toContain('Discount Codes Engineer (Codex)');
});

test('attaching a standalone session retains collision reservations and its earlier history label', () => {
  const { events, nodes } = collisionRun();
  const standalone = (id: string) =>
    helixEventSchema.parse({
      ...events[1]!,
      sessionId: id,
      payload: { session: { ...worker, id, planNodeId: undefined, title: 'Catalog API' } },
    });
  const log = [
    events[0]!,
    standalone('sess_original'),
    standalone('sess_twin'),
    ...events.slice(1),
  ].map((event, i) => helixEventSchema.parse({ ...event, seq: i + 1 }));
  log.push(
    helixEventSchema.parse({
      ...events[1]!,
      seq: log.length + 1,
      sessionId: 'sess_original',
      type: 'chat.item',
      payload: {
        item: { kind: 'message', role: 'system', text: 'Committed abc1234: Catalog update' },
      },
    }),
  );
  const originalEvent = log[1]!;
  const before = at(log, log.length);
  const originalSentence = describeEvent(originalEvent, before);
  expect(resolveIdentities(before).get('sess_twin')?.name).toBe('Catalog Architect 2');
  log.push(
    helixEventSchema.parse({
      ...events[1]!,
      seq: log.length + 1,
      type: 'plan.node_updated',
      payload: { nodeId: nodes[0]!.id, sessionId: 'sess_original' },
    }),
  );
  const after = at(log, log.length);
  expect(resolveIdentities(after).get('sess_original')?.name).toBe('Catalog Architect 3');
  expect(resolveIdentities(after).get('sess_twin')?.name).toBe('Catalog Architect 2');
  expect(describeEvent(originalEvent, after)).toBe(originalSentence);
  expect(originalSentence).toContain('Catalog Architect (Codex)');
  const commits = render(
    <CommitsView state={after} events={log} index={log.length - 1} onOpen={noop} onSeek={noop} />,
  );
  expect(commits).toContain('Catalog Architect</span>');
  expect(commits).not.toContain('Catalog Architect 3</span>');
});
