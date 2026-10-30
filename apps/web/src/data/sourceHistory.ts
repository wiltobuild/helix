import type { HelixEvent } from '@helix/contracts';
import type { EventStreamStatus } from '@helix/api-client';
import { mergeEventHistory } from './activeTime';

/** Identity comes from source selection, never the earliest event or the current backfill. */
export const sourceIdentity = (kind: 'live' | 'demo', id: string, revision = 0) =>
  JSON.stringify([kind, id, revision]);
export interface SourceHistory {
  projectId: string;
  events: readonly HelixEvent[];
  status: EventStreamStatus;
}
export const emptyHistory = (projectId: string): SourceHistory => ({
  projectId,
  events: [],
  status: 'connecting',
});
export function selectHistory(state: SourceHistory, projectId: string): SourceHistory {
  return state.projectId === projectId ? state : emptyHistory(projectId);
}
export function receiveEvent(
  state: SourceHistory,
  projectId: string,
  event: HelixEvent,
): SourceHistory {
  // A callback from a closed subscription must never switch the current project back.
  if (state.projectId !== projectId || event.projectId !== projectId) return state;
  const events = mergeEventHistory(state.events, [event]);
  return events === state.events ? state : { ...state, events };
}
export function receiveStatus(
  state: SourceHistory,
  projectId: string,
  status: EventStreamStatus,
): SourceHistory {
  return state.projectId === projectId ? { ...state, status } : state;
}
