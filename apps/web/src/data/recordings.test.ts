import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { applyEvent, createProjector, projectUpTo, type ProjectState } from '@helix/contracts';
import { readRecording } from './recordings';

const load = (name: string) => {
  const url = new URL(`../../public/recordings/${name}.helixlog`, import.meta.url);
  return readRecording(name, readFileSync(url, 'utf8')).events;
};

// Replay determinism (PLAN §6): the screen at any moment of a real recording is the same whether
// you watched it arrive event by event (live) or jumped there on the timeline (replay).
test.each(['discount-codes', 'github-ci-repair'])(
  '%s: live state equals replayed state at every cursor',
  (name) => {
    const events = load(name);
    const projector = createProjector(events);
    let live: ProjectState | undefined;
    for (const e of events) {
      live = applyEvent(live, e);
      expect(projector.at(e.seq), `seq ${e.seq}`).toEqual(live);
    }
    // Jumping backwards and forwards lands on the same states again.
    const mid = events[Math.floor(events.length / 2)]!.seq;
    const last = events.at(-1)!.seq;
    expect(projector.at(mid)).toEqual(projectUpTo(events, mid));
    expect(projector.at(last)).toEqual(live);
    expect(projector.at(mid)).toEqual(projectUpTo(events, mid));
  },
);

test.each(['discount-codes', 'github-ci-repair'])(
  '%s: replays without anomalies and every cause points backwards',
  (name) => {
    const events = load(name);
    const state = createProjector(events).at(events.at(-1)!.seq);
    expect(state.anomalies).toEqual([]);
    const seen = new Set<number>();
    for (const e of events) {
      if (e.causedBy !== undefined) expect(seen.has(e.causedBy), `#${e.seq}`).toBe(true);
      seen.add(e.seq);
    }
  },
);
