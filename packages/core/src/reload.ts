import {
  applyEvent,
  parseEvent,
  projectUpTo,
  type HelixEvent,
  type ProjectState,
} from '@helix/contracts';
import type { CoreLog } from './core.js';

/** Fast normal replay; damaged histories also need a list safe for outbox recovery. */
export function reload(
  events: HelixEvent[],
  log: CoreLog,
): {
  state: ProjectState | undefined;
  events: HelixEvent[];
} {
  try {
    const state = projectUpTo(events, events.at(-1)!.seq);
    if (!state.anomalies.length) return { state, events };
  } catch {
    /* Missing genesis or mixed project identity also needs isolation. */
  }
  let state: ProjectState | undefined;
  const valid: HelixEvent[] = [];
  let count = 0;
  const reasons: string[] = [];
  for (const event of events) {
    let reason: string | undefined;
    try {
      const next = applyEvent(state, event);
      if (next.anomalies.at(-1)?.seq === event.seq) {
        reason = parseEvent(event).success
          ? next.anomalies.at(-1)!.reason.replace(/:.*$/s, '')
          : 'Invalid event payload';
      } else valid.push(event);
      state = next;
    } catch {
      reason = 'Missing or mismatched project genesis';
    }
    if (reason) {
      count++;
      if (reasons.length < 5) reasons.push(`#${event.seq}: ${reason}`);
    }
  }
  // CONTRACT-REQUEST: HealthResponse should allow an optional anomalies count.
  // Frozen v1 is strict {status, version}; keep diagnostics in the daemon log.
  log.error(`Startup replay skipped ${count} anomalous events; ${reasons.join('; ')}`);
  return { state, events: valid };
}
