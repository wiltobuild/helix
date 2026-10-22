import { describe, expect, it } from 'vitest';
import {
  fixtures,
  parseHelixlog,
  projectUpTo,
  serializeHelixlog,
  type HelixEvent,
  type Helixlog,
  type Project,
} from '@helix/contracts';
import { openStore } from '@helix/storage';
import { verifyRecordingRoundTrip } from './recordings.js';

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
      const realLocalProject: Project = {
        id: 'proj_real_codex',
        name: 'real-codex-run',
        repoPath: '/Users/developer/projects/real-codex',
        defaultBranch: 'main',
        defaultAgent: 'codex',
        createdAt: '2026-10-01T10:00:00.000Z',
      };

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
          sessionId: 'sess_codex_1' as any,
          type: 'chat.item',
          ts: '2026-10-01T10:01:00.000Z',
          v: 1,
          payload: {
            item: {
              id: 'chat_1',
              role: 'assistant',
              text: 'Pushing with ghp_11223344556677889900aabbccddeeff0011 to git remote for user developer@corp.com',
            },
          },
        },
        {
          seq: 3,
          projectId: realLocalProject.id,
          sessionId: 'sess_codex_1' as any,
          type: 'worktree.created',
          ts: '2026-10-01T10:02:00.000Z',
          v: 1,
          payload: {
            sessionId: 'sess_codex_1' as any,
            branch: 'helix/sess_codex_1',
            worktreePath: '/Users/developer/projects/real-codex/.helix/worktrees/sess_codex_1',
            baseSha: '0123456789abcdef0123456789abcdef01234567',
          },
        },
        {
          seq: 4,
          projectId: realLocalProject.id,
          sessionId: 'sess_codex_1' as any,
          type: 'explain.note',
          ts: '2026-10-01T10:03:00.000Z',
          v: 1,
          payload: {
            text: 'Committed in /Users/developer/projects/real-codex by dev@example.com',
          },
        },
      ];

      await store.append(realCodexEvents.map((e) => {
        const { seq, ...rest } = e;
        return rest;
      }));

      const exportedText = await store.exportProject(realLocalProject.id);
      const parsed = parseHelixlog(exportedText);

      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error(parsed.error.message);

      const log = parsed.data;

      // Header checks
      expect(log.header.format).toBe('helixlog');
      expect(log.header.version).toBe(1);
      expect(log.header.project.repoPath).toBe('<repo>');
      expect(log.header.redactions).toEqual(
        expect.arrayContaining(['email', 'path:repo', 'token']),
      );

      // Event content checks: no raw paths or tokens or emails leaked
      const rawText = JSON.stringify(log.events);
      expect(rawText).not.toContain('/Users/developer');
      expect(rawText).not.toContain('ghp_11223344556677889900aabbccddeeff0011');
      expect(rawText).not.toContain('developer@corp.com');
      expect(rawText).not.toContain('dev@example.com');

      // Import checks: stores as replay-only
      const importResult = await store.importRecording(exportedText);
      expect(importResult.eventCount).toBe(4);

      const recordings = await store.listRecordings();
      expect(recordings).toHaveLength(1);
      expect(recordings[0]?.eventCount).toBe(4);

      // Verify projection of imported recording matches projection of sanitized original
      const originalProj = projectUpTo(realCodexEvents, Number.MAX_SAFE_INTEGER, {
        strict: true,
      });
      const replayed = await store.readRecording(recordings[0]!.id);
      expect(replayed).toBeDefined();

      const replayedProj = projectUpTo(replayed!.events, Number.MAX_SAFE_INTEGER, {
        strict: true,
      });

      // Session states, activities, and counts match
      expect(replayedProj.lastSeq).toBe(originalProj.lastSeq);
      expect(Object.keys(replayedProj.sessions)).toEqual(Object.keys(originalProj.sessions));
    } finally {
      await store.close();
    }
  });
});
