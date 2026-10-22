import { afterEach, expect, it, vi } from 'vitest';
import {
  fixtures,
  eventSchemas,
  type HarnessEmission,
  type HarnessStartOptions,
} from '@helix/contracts';
import { createFakeHarness, passwordResetApiScript } from './index.js';

const created = fixtures.passwordResetRun.find(
  (event) =>
    event.type === 'session.created' && event.payload.session.id === fixtures.passwordResetIds.api,
);
if (!created || created.type !== 'session.created') throw new Error('Missing fixture');
const options: HarnessStartOptions = { cwd: '.', session: created.payload.session };
const message = (text: string): HarnessEmission => ({
  type: 'chat.item',
  payload: { item: { kind: 'message', role: 'assistant', text } },
});
afterEach(() => vi.useRealTimers());

it('starts without a turn, runs explicit sends, supports unsubscribe, and stops once', async () => {
  vi.useFakeTimers();
  const session = await createFakeHarness({
    turns: [[{ delayMs: 100, emission: message('first') }], [{ emission: message('second') }]],
  }).start(options);
  const events: HarnessEmission[] = [];
  const unsubscribe = session.onEvent((event) => events.push(event));
  await vi.runAllTimersAsync();
  expect(events).toEqual([
    { type: 'activity.changed', payload: { activity: 'starting' } },
    { type: 'activity.changed', payload: { activity: 'idle' } },
  ]);
  await session.send('next', 'queue');
  await expect(session.send('too soon', 'queue')).rejects.toMatchObject({ code: 'CONFLICT' });
  await vi.advanceTimersByTimeAsync(99);
  expect(events.filter((event) => event.type === 'chat.item')).toHaveLength(0);
  await vi.runAllTimersAsync();
  expect(events.filter((event) => event.type === 'chat.item')).toEqual([message('first')]);
  await session.send('second', 'queue');
  await vi.runAllTimersAsync();
  expect(events.filter((event) => event.type === 'chat.item')).toEqual([
    message('first'),
    message('second'),
  ]);
  await session.stop();
  await session.stop();
  expect(
    events.filter(
      (event) => event.type === 'activity.changed' && event.payload.activity === 'exited',
    ),
  ).toHaveLength(1);
  unsubscribe();
});

it('interrupts the delayed turn and cancels timers on stop', async () => {
  vi.useFakeTimers();
  const session = await createFakeHarness({
    turns: [
      [{ delayMs: 100, emission: message('cancelled') }],
      [{ emission: message('replacement') }],
    ],
  }).start(options);
  const events: HarnessEmission[] = [];
  session.onEvent((event) => events.push(event));
  await session.send('first', 'queue');
  await session.send('replace', 'interrupt');
  await vi.runAllTimersAsync();
  expect(events.filter((event) => event.type === 'chat.item')).toEqual([message('replacement')]);
  await session.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('reproduces every API-worker harness emission from the frozen fixture', async () => {
  vi.useFakeTimers();
  const events: HarnessEmission[] = [];
  const session = await createFakeHarness(passwordResetApiScript).start(options);
  session.onEvent((event) => {
    events.push(event);
    if (event.type === 'approval.requested')
      void session.decide(event.payload.approval.id, 'approved');
  });
  await session.send(options.session.prompt, 'queue');
  await vi.runAllTimersAsync();
  for (const step of passwordResetApiScript) expect(events).toContainEqual(step.emission);
  for (const event of events)
    expect(eventSchemas[event.type].shape.payload.safeParse(event.payload).success).toBe(true);
  expect(passwordResetApiScript.length).toBeGreaterThan(0);
  await session.stop();
});

it('pauses for approvals and uses the shared approval interface', async () => {
  vi.useFakeTimers();
  const requested = fixtures.passwordResetRun.find((event) => event.type === 'approval.requested');
  if (!requested || requested.type !== 'approval.requested')
    throw new Error('Missing approval fixture');
  const approval: HarnessEmission = { type: requested.type, payload: requested.payload };
  const session = await createFakeHarness([
    { emission: approval },
    { emission: message('after approval') },
  ]).start(options);
  const events: HarnessEmission[] = [];
  session.onEvent((event) => events.push(event));
  await session.send(options.session.prompt, 'queue');
  await vi.runAllTimersAsync();
  expect(events).not.toContainEqual(message('after approval'));
  await session.decide(requested.payload.approval.id, 'approved');
  await vi.runAllTimersAsync();
  expect(events).toContainEqual(message('after approval'));
  await expect(session.decide(requested.payload.approval.id, 'approved')).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await session.stop();
});
