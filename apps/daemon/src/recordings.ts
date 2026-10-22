import {
  parseHelixlog,
  projectUpTo,
  serializeHelixlog,
  type HelixEvent,
  type Helixlog,
  type ProjectId,
  type ProjectState,
} from '@helix/contracts';
import { openStore, sanitizeForExport, type OpenStoreOptions, type RecordingInfo, type StorageStore } from '@helix/storage';

export interface RecordingExportOptions {
  repoPath?: string;
}

/**
 * Exports a project's history from the storage store as a sanitized .helixlog string.
 * Redacts absolute paths, usernames in paths, tokens, and email addresses.
 */
export async function exportRecordingFromStore(
  store: StorageStore,
  projectId: ProjectId,
): Promise<string> {
  return store.exportProject(projectId);
}

/**
 * Imports a .helixlog string into the storage store as a replay-only recording.
 */
export async function importRecordingIntoStore(
  store: StorageStore,
  text: string,
) {
  return store.importRecording(text);
}

/**
 * Computes the canonical project state projection from a recording.
 */
export function projectRecording(log: Helixlog): ProjectState {
  return projectUpTo(log.events, Number.MAX_SAFE_INTEGER, { strict: true });
}

/**
 * Verifies that exporting and importing a recorded run preserves identical state projection.
 */
export async function verifyRecordingRoundTrip(
  originalEvents: HelixEvent[],
  storeOptions: OpenStoreOptions = { memory: true },
): Promise<{
  originalProjection: ProjectState;
  replayedProjection: ProjectState;
  isIdentical: boolean;
  redactions: string[];
}> {
  const store = openStore(storeOptions);
  try {
    const first = originalEvents[0];
    if (!first || first.type !== 'project.added') {
      throw new Error('Events must begin with project.added');
    }

    const originalProjection = projectUpTo(originalEvents, Number.MAX_SAFE_INTEGER, {
      strict: true,
    });

    const sanitized = sanitizeForExport(first.payload.project, originalEvents);
    const log: Helixlog = {
      header: {
        format: 'helixlog',
        version: 1,
        project: sanitized.project,
        recordedAt: originalEvents.at(-1)!.ts,
        redactions: sanitized.redactions,
      },
      events: sanitized.events as HelixEvent[],
    };

    const text = serializeHelixlog(log);
    const parsed = parseHelixlog(text);
    if (!parsed.success) {
      throw new Error(`Failed to parse exported helixlog: ${parsed.error.message}`);
    }

    await store.importRecording(text);
    const recordings = await store.listRecordings();
    if (recordings.length === 0) {
      throw new Error('Recording was not stored in store.listRecordings()');
    }

    const replayed = await store.readRecording(recordings[0]!.id);
    if (!replayed) {
      throw new Error('Could not read imported recording');
    }

    const replayedProjection = projectUpTo(replayed.events, Number.MAX_SAFE_INTEGER, {
      strict: true,
    });

    // Strip volatile fields (like repoPath which is sanitized to <repo>) before deep equality
    const normOriginal = {
      ...originalProjection,
      project: { ...originalProjection.project, repoPath: '<repo>' },
    };
    const normReplayed = {
      ...replayedProjection,
      project: { ...replayedProjection.project, repoPath: '<repo>' },
    };

    const isIdentical = JSON.stringify(normOriginal) === JSON.stringify(normReplayed);

    return {
      originalProjection,
      replayedProjection,
      isIdentical,
      redactions: log.header.redactions,
    };
  } finally {
    await store.close();
  }
}
