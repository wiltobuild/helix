import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { createProjector, fixtures, helixEventSchema } from '@helix/contracts';
import { HistoryUnavailable } from '../app/HistoryUnavailable';
import type { HelixSource } from './useHelixSource';
import { accountTime } from './activeTime';
import { createSafeProjector } from './safeProjection';
import { emptyHistory, receiveEvent, selectHistory, sourceIdentity } from './sourceHistory';
import { initialTimeline, transitionTimeline } from './timelineState';
import { historicalActorName, identityFor } from './identity';

const events = fixtures.passwordResetRun;
const genesis = events[0]!;
const projectId = genesis.projectId;

test('safe current and latest projections retain naming reservations and historical actor identity', () => {
  const created = events.find(
    (event) => event.type === 'session.created' && event.payload.session.role === 'worker',
  )!;
  const original = JSON.stringify(events);
  const projector = createSafeProjector(accountTime(events));
  const early = projector.at(created.seq),
    latest = projector.at(events.at(-1)!.seq);
  if (!early.ok || !latest.ok) throw new Error('Fixture history must project');
  expect(historicalActorName(early.state, created)).toBe('Password Reset Architect');
  expect(historicalActorName(latest.state, created)).toBe('Password Reset Architect');
  expect(identityFor(early.state, created.sessionId!)?.name).toBe('Password Reset Architect');
  expect(identityFor(latest.state, created.sessionId!)?.sessionId).toBe(created.sessionId);
  expect(JSON.stringify(events)).toBe(original);
});
const conflictingGenesis = helixEventSchema.parse({
  ...genesis,
  type: 'activity.changed',
  payload: { activity: 'active' },
});

test('conflicting schema-valid genesis variants fail closed through actual projection and retain original evidence', () => {
  let history = receiveEvent(emptyHistory(projectId), projectId, genesis);
  history = receiveEvent(history, projectId, conflictingGenesis);
  const before = JSON.stringify(history.events);
  const timing = accountTime(history.events);
  // Reproduce the actual contracts failure, not only the accounting classification.
  expect(() => createProjector(timing.events)).toThrow(
    'Projection must begin with matching project.added',
  );
  const result = createSafeProjector(timing).at(1);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Invalid projection must not expose state');
  expect(result.error).toContain('Conflicting event identities #1');
  expect(result.error).toContain('Projection must begin with matching project.added');
  expect(result).not.toHaveProperty('state');
  expect(history.events).toHaveLength(2);
  expect(history.events).toContain(genesis);
  expect(history.events).toContain(conflictingGenesis);
  expect(JSON.stringify(history.events)).toBe(before);
});

test('the unavailable view shows both retained variants and no approval or mutation controls', () => {
  const history = [genesis, conflictingGenesis];
  const projection = createSafeProjector(accountTime(history)).at(1);
  if (projection.ok) throw new Error('Expected conflict');
  const source: HelixSource = {
    sourceId: sourceIdentity('live', projectId),
    mode: 'live',
    events: history,
    projects: [fixtures.passwordResetProject],
    stream: 'live',
    selectProject: () => {},
    addProject: async () => {},
    openRecording: async () => {},
    speed: 1,
    setSpeed: () => {},
    staticBuild: false,
  };
  const html = renderToStaticMarkup(
    <HistoryUnavailable error={projection.error} events={history} source={source} />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain('History cannot be projected safely');
  expect(html).toContain('Retained event evidence (2 variants)');
  expect(html).toContain('project.added');
  expect(html).toContain('activity.changed');
  expect(html).toContain(`View ${fixtures.passwordResetProject.name}`);
  expect(html.match(/<button/g)).toHaveLength(1); // Source selection only.
  expect(html).not.toContain('Approve plan');
  expect(html).not.toContain('New build');
  expect(html).not.toContain('Merge');
});

test('missing session backfill restores strict projection without resetting timeline identity or mode', () => {
  let history = emptyHistory(projectId);
  history = receiveEvent(history, projectId, genesis);
  history = receiveEvent(history, projectId, events[2]!);
  let timing = accountTime(history.events);
  const sourceId = sourceIdentity('live', projectId);
  let navigation = transitionTimeline(
    initialTimeline(sourceId),
    { type: 'seek', index: 1 },
    timing,
  );
  navigation = transitionTimeline(navigation, { type: 'mode', mode: 'active' }, timing);
  expect(createSafeProjector(timing).at(events[2]!.seq).ok).toBe(false);
  history = receiveEvent(history, projectId, events[1]!);
  timing = accountTime(history.events);
  const recovered = createSafeProjector(timing).at(events[2]!.seq);
  expect(recovered.ok).toBe(true);
  if (!recovered.ok) throw new Error(recovered.error);
  expect(recovered.state.lastSeq).toBe(events[2]!.seq);
  expect(transitionTimeline(navigation, { type: 'source', sourceId }, timing)).toBe(navigation);
  expect(navigation).toMatchObject({ cursor: events[2]!.seq, timeMode: 'active' });
});

test('source switching recovers independently while the previous source retains its conflicts', () => {
  const broken = receiveEvent(
    receiveEvent(emptyHistory(projectId), projectId, genesis),
    projectId,
    conflictingGenesis,
  );
  const otherGenesis = helixEventSchema.parse({
    ...genesis,
    projectId: 'other-project',
    payload: { project: { ...fixtures.passwordResetProject, id: 'other-project' } },
  });
  const other = receiveEvent(selectHistory(broken, 'other-project'), 'other-project', otherGenesis);
  expect(createSafeProjector(accountTime(other.events)).at(otherGenesis.seq).ok).toBe(true);
  expect(createSafeProjector(accountTime(broken.events)).at(genesis.seq).ok).toBe(false);
  expect(broken.events).toContain(conflictingGenesis);
});

test('projectable conflicts still cannot authorize actions; empty and before-genesis cursors fail safely', () => {
  const changedGenesis = helixEventSchema.parse({
    ...genesis,
    payload: { project: { ...fixtures.passwordResetProject, name: 'Conflicting name' } },
  });
  const timing = accountTime([genesis, changedGenesis]);
  expect(() => createProjector(timing.events)).not.toThrow();
  expect(createSafeProjector(timing).at(1).ok).toBe(false);
  expect(createSafeProjector(accountTime([])).at(0).ok).toBe(false);
  const valid = createSafeProjector(accountTime(events));
  expect(valid.at(0).ok).toBe(false);
  expect(valid.at(events.at(-1)!.seq).ok).toBe(true);
});
