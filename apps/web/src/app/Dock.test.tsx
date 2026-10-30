import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { fixtures, helixEventSchema, type HelixEvent } from '@helix/contracts';
import { TooltipProvider } from '@helix/ui';
import { accountTime, timeMapping, type TimeMode } from '../data/activeTime';
import { createSafeProjector } from '../data/safeProjection';
import { ganttLanes } from '../data/observatory';
import { ganttTimeAxis, pointerTime, timelineMilestones } from '../data/timeline';
import type { RunView } from '../data/useRun';
import type { HelixSource } from '../data/useHelixSource';
import { Dock } from './Dock';

const origin = Date.parse('2026-10-01T00:00:00Z');
const iso = (seconds: number) => new Date(origin + seconds * 1000).toISOString();
function event(
  seq: number,
  seconds: number,
  type: string,
  payload: unknown,
  sessionId?: string,
): HelixEvent {
  return helixEventSchema.parse({
    seq,
    ts: iso(seconds),
    type,
    payload,
    v: 1,
    projectId: fixtures.passwordResetProject.id,
    ...(sessionId ? { sessionId } : {}),
  });
}
const events = [
  event(1, 0, 'project.added', { project: fixtures.passwordResetProject }),
  event(
    2,
    0,
    'session.created',
    {
      session: {
        id: 'worker',
        projectId: fixtures.passwordResetProject.id,
        role: 'worker',
        agent: 'codex',
        title: 'Worker',
        prompt: 'Task',
        interface: 'chat',
        createdAt: iso(0),
      },
    },
    'worker',
  ),
  event(3, 1, 'session.started', {}, 'worker'),
  event(4, 1, 'activity.changed', { activity: 'active' }, 'worker'),
  event(
    5,
    2,
    'approval.requested',
    {
      approval: {
        id: 'approval',
        sessionId: 'worker',
        kind: 'command',
        summary: 'Human decision',
        detail: '',
        scope: 'once',
        requestedAt: iso(2),
      },
    },
    'worker',
  ),
  event(6, 4, 'activity.changed', { activity: 'waiting_input' }, 'worker'),
  event(7, 8, 'approval.decided', { approvalId: 'approval', decision: 'approved' }, 'worker'),
  event(8, 9, 'session.exited', { code: 0 }, 'worker'),
  event(9, 10, 'explain.note', { text: 'History observed', source: 'helix' }),
];

function view(mode: TimeMode, index: number, history: readonly HelixEvent[] = events): RunView {
  const timing = accountTime(history);
  const events = timing.events;
  const projector = createSafeProjector(timing);
  const projection = projector.at(events[index]!.seq),
    latest = projector.at(events.at(-1)!.seq);
  if (!projection.ok || !latest.ok) throw new Error('Test history must project strictly');
  const mapping = timeMapping(timing, mode);
  return {
    events,
    current: events[index]!,
    index,
    state: projection.state,
    latestState: latest.state,
    timing,
    mapping,
    timeMode: mode,
    position: mapping.forward(timing.times[index]!),
    eventTime: (i) => mapping.forward(timing.times[i]!),
    bySeq: new Map(events.map((e) => [e.seq, e])),
    isLive: false,
    playing: false,
    seek: () => {},
    step: () => {},
    goLive: () => {},
    togglePlay: () => {},
    setTimeMode: () => {},
    seekTime: () => {},
    key: () => false,
  };
}
const source: HelixSource = {
  sourceId: 'demo:test',
  mode: 'demo',
  events,
  projects: [],
  stream: 'demo',
  selectProject: () => {},
  addProject: async () => {},
  openRecording: async () => {},
  speed: 1,
  setSpeed: () => {},
  staticBuild: true,
};
function render(run: RunView) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <Dock
        run={run}
        source={source}
        tree={undefined}
        expanded={false}
        onExpand={() => {}}
        onSelectSession={() => {}}
      />
    </TooltipProvider>,
  );
}

test('Dock exposes the clock, honest history totals, per-agent accounting and collapsed waits', () => {
  const html = render(view('active', 5));
  expect(html).toContain('Timeline clock');
  expect(html).toContain('Project history:');
  expect(html).toContain('00:10 elapsed');
  expect(html).toContain('00:04 active');
  expect(html).toContain('00:06 global human wait');
  expect(html).toContain('Unknown time stays active');
  expect(html).toContain('Evidenced work');
  expect(html).toContain('Other / unknown');
  expect(html).toContain('Inspect collapsed human wait of 00:06');
  expect(html).toContain('00:02 active. Event 6');
  expect(html).toContain('recorded session span');
  expect(render(view('elapsed', 5))).not.toContain('Inspect collapsed human wait');
});

test('Gantt bars, marks, scrubber and inverse pointer use the same compressed axis', () => {
  const run = view('active', 5);
  const axis = ganttTimeAxis(run.timing, run.mapping);
  const lanes = ganttLanes(events, events.length - 1, run.latestState, undefined, axis).lanes;
  // Session span starts at creation; evidenced work is accounted separately.
  expect(lanes[0]!.bars[0]).toMatchObject({ from: 0, to: 0.75 });
  const approval = lanes[0]!.marks.find((mark) => mark.seq === events[4]!.seq)!;
  expect(approval.at).toBe(0.5);
  const position = pointerTime(150, 100, 100, run.mapping.total);
  expect(position).toBe(run.eventTime(4));
  expect(run.mapping.seek(position)).toBe(6); // Right edge of the collapsed interval.
  expect(run.mapping.inverse(position)).toBe(origin + 8000);
  expect(timelineMilestones(events).map(run.eventTime)).toEqual(
    timelineMilestones(events).map((i) => axis.eventAt(i) * run.mapping.total),
  );
  expect(pointerTime(1, 0, 0, run.mapping.total)).toBe(0);
});

test('scrubbing preserves the full latest-state chart and later milestones', () => {
  const early = view('active', 0),
    tail = view('active', events.length - 1);
  const chart = (run: RunView) =>
    ganttLanes(
      events,
      events.length - 1,
      run.latestState,
      undefined,
      ganttTimeAxis(run.timing, run.mapping),
    );
  expect(chart(early)).toEqual(chart(tail));
  expect(Object.keys(early.state.sessions)).toEqual([]);
  expect(render(early)).toContain('Worker');
  expect(render(early)).toMatch(/<option value="7">00:03 active · [^<]+ stopped\.<\/option>/);
  expect(early.current).toBe(events[0]);
});

test('zero-length sessions never gain fake work duration or pointer distance', () => {
  const zero = events.map((e) => ({ ...e, ts: iso(0) }));
  const timing = accountTime(zero),
    mapping = timeMapping(timing, 'active');
  const projection = createSafeProjector(timing).at(zero.at(-1)!.seq);
  if (!projection.ok) throw new Error(projection.error);
  const chart = ganttLanes(
    zero,
    zero.length - 1,
    projection.state,
    undefined,
    ganttTimeAxis(timing, mapping),
  );
  expect(chart.lanes[0]!.bars[0]).toMatchObject({ from: 0, to: 0 });
  expect(pointerTime(300, 100, 200, mapping.total)).toBe(0);
  expect(mapping.seek(0)).toBe(zero.length - 1);
});

test.each(['active', 'elapsed'] as const)(
  'backward timestamps keep %s bars, marks, playhead and navigation on event coordinates',
  (mode) => {
    const history = [
      events[0]!,
      events[1]!,
      event(3, 10, 'activity.changed', { activity: 'active' }, 'worker'),
      event(4, 5, 'explain.note', { text: 'Backdated observation', source: 'helix' }, 'worker'),
      event(5, 5, 'session.exited', { code: 0 }, 'worker'),
      event(6, 20, 'explain.note', { text: 'History observed', source: 'helix' }),
    ];
    const original = JSON.stringify(history);
    const run = view(mode, 4, history);
    const axis = ganttTimeAxis(run.timing, run.mapping);
    const lane = ganttLanes(run.events, history.length - 1, run.latestState, undefined, axis)
      .lanes[0]!;
    expect(lane.bars[0]).toMatchObject({ from: 0, to: 0.5 });
    expect(lane.marks.find((mark) => mark.seq === 4)?.at).toBe(0.5);
    expect(run.position).toBe(10000);
    expect(run.eventTime(4)).toBe(lane.bars[0]!.to * run.mapping.total);
    expect(run.mapping.seek(pointerTime(150, 100, 100, run.mapping.total))).toBe(4);
    expect(render(run)).toContain(`00:10 ${mode}. Event 5`);
    expect(render(run)).toMatch(new RegExp(`<option value="4" selected="">00:10 ${mode} ·`));
    expect(run.current).toBe(history[4]);
    expect(JSON.stringify(history)).toBe(original);
    expect(run.current.ts).toBe(iso(5));

    // The same raw timestamp can also start a later session at a different normalized time.
    const lateStart = [
      history[0]!,
      history[1]!,
      history[2]!,
      event(
        4,
        0,
        'session.created',
        {
          session: {
            ...fixtures.passwordResetRun.find((e) => e.type === 'session.created')!.payload.session,
            id: 'later',
            role: 'worker',
            title: 'Later task',
          },
        },
        'later',
      ),
      event(5, 5, 'session.exited', { code: 0 }, 'later'),
      history[5]!,
    ];
    const later = view(mode, 4, lateStart);
    const laterLane = ganttLanes(
      later.events,
      lateStart.length - 1,
      later.latestState,
      undefined,
      ganttTimeAxis(later.timing, later.mapping),
    ).lanes.find((lane) => lane.sessionId === 'later')!;
    expect(laterLane.bars[0]).toMatchObject({ from: 0.5, to: 0.5 });
  },
);
