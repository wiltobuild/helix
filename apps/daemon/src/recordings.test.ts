import { describe, expect, it } from 'vitest';
import {
  fixtures,
  parseEvent,
  parseHelixlog,
  projectSchema,
  projectUpTo,
  serializeHelixlog,
  type HelixEvent,
  type Helixlog,
  type ProjectState,
  type UnsequencedEvent,
} from '@helix/contracts';
import { openStore, sanitizeForExport, type OpenStoreOptions } from '@helix/storage';

function unsequence(events: readonly HelixEvent[]): UnsequencedEvent[] {
  return events.map((event) => {
    const { seq, ...input } = event;
    void seq;
    return input;
  });
}

function toEvent(value: unknown): HelixEvent {
  const result = parseEvent(value);
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

/**
 * Verifies that exporting and importing a recorded run preserves identical state projection.
 */
async function verifyRecordingRoundTrip(
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

describe('daemon recordings round-trip and redaction', () => {
  it('round-trips full run through export and import with identical projection', async () => {
    const runEvents = [...fixtures.passwordResetRun];
    const result = await verifyRecordingRoundTrip(runEvents);

    expect(result.isIdentical).toBe(true);
    expect(result.replayedProjection.lastSeq).toBe(result.originalProjection.lastSeq);
    expect(Object.keys(result.replayedProjection.sessions)).toEqual(
      Object.keys(result.originalProjection.sessions),
    );
  });

  it('redacts sensitive tokens, emails, usernames and paths in exported .helixlog', async () => {
    const store = openStore({ memory: true });
    try {
      const realLocalProject = projectSchema.parse({
        id: 'proj_real_codex',
        name: 'real-codex-run',
        repoPath: '/Users/developer/projects/real-codex',
        defaultBranch: 'main',
        defaultAgent: 'codex',
        createdAt: '2026-10-01T10:00:00.000Z',
      });

      const realCodexEvents: HelixEvent[] = [
        {
          seq: 1,
          projectId: realLocalProject.id,
          type: 'project.added',
          ts: '2026-10-01T10:00:00.000Z',
          v: 1,
          payload: { project: realLocalProject },
        },
        {
          seq: 2,
          projectId: realLocalProject.id,
          sessionId: 'sess_codex_1',
          type: 'session.created',
          ts: '2026-10-01T10:00:30.000Z',
          v: 1,
          payload: {
            session: {
              id: 'sess_codex_1',
              projectId: realLocalProject.id,
              role: 'orchestrator',
              agent: 'codex',
              title: 'Real Codex run',
              prompt: 'Push the fix',
              interface: 'chat',
              createdAt: '2026-10-01T10:00:30.000Z',
            },
          },
        },
        {
          seq: 3,
          projectId: realLocalProject.id,
          sessionId: 'sess_codex_1',
          type: 'chat.item',
          ts: '2026-10-01T10:01:00.000Z',
          v: 1,
          payload: {
            item: {
              kind: 'message',
              role: 'assistant',
              text: 'Pushing with ghp_11223344556677889900aabbccddeeff0011 for user dev@corp.com',
            },
          },
        },
        {
          seq: 4,
          projectId: realLocalProject.id,
          sessionId: 'sess_codex_1',
          type: 'worktree.created',
          ts: '2026-10-01T10:02:00.000Z',
          v: 1,
          payload: {
            branch: 'helix/sess_codex_1',
            path: '/Users/developer/projects/real-codex/.helix/worktrees/sess_codex_1',
            baseSha: '0123456789abcdef0123456789abcdef01234567',
          },
        },
        {
          seq: 5,
          projectId: realLocalProject.id,
          sessionId: 'sess_codex_1',
          type: 'explain.note',
          ts: '2026-10-01T10:03:00.000Z',
          v: 1,
          payload: {
            text: 'Committed in /Users/developer/projects/real-codex by dev@example.com',
          },
        },
      ].map(toEvent);

      await store.append(unsequence(realCodexEvents));

      const exportedText = await store.exportProject(realLocalProject.id);
      const parsed = parseHelixlog(exportedText);

      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error(parsed.error.message);

      const log = parsed.data;

      expect(log.header.format).toBe('helixlog');
      expect(log.header.version).toBe(1);
      expect(log.header.project.repoPath).toBe('<repo>');
      expect(log.header.redactions).toEqual(
        expect.arrayContaining(['email', 'path:repo', 'token']),
      );

      const rawText = JSON.stringify(log.events);
      expect(rawText).not.toContain('/Users/developer');
      expect(rawText).not.toContain('ghp_11223344556677889900aabbccddeeff0011');
      expect(rawText).not.toContain('dev@corp.com');
      expect(rawText).not.toContain('dev@example.com');

      const importResult = await store.importRecording(exportedText);
      expect(importResult.eventCount).toBe(5);

      const recordings = await store.listRecordings();
      expect(recordings).toHaveLength(1);
      expect(recordings[0]?.eventCount).toBe(5);

      const originalProj = projectUpTo(realCodexEvents, Number.MAX_SAFE_INTEGER, {
        strict: true,
      });
      const replayed = await store.readRecording(recordings[0]!.id);
      expect(replayed).toBeDefined();

      const replayedProj = projectUpTo(replayed!.events, Number.MAX_SAFE_INTEGER, {
        strict: true,
      });

      expect(replayedProj.lastSeq).toBe(originalProj.lastSeq);
      expect(Object.keys(replayedProj.sessions)).toEqual(Object.keys(originalProj.sessions));
    } finally {
      await store.close();
    }
  });
});
