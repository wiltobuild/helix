import { projectUpTo, type Helixlog, type ProjectState } from '@helix/contracts';

export interface RecordingExportOptions {
  repoPath?: string;
}

/**
 * Computes the canonical project state projection from a recording.
 */
export function projectRecording(log: Helixlog): ProjectState {
  return projectUpTo(log.events, Number.MAX_SAFE_INTEGER, { strict: true });
}
