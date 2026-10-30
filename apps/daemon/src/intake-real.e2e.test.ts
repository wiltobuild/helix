import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarness } from '@helix/harness';
import { projectIdSchema, type IntakeDraft } from '@helix/contracts';
import { createIntakeWriter } from './intake-writer.js';

test.skipIf(process.env.HELIX_E2E !== '1')(
  'real Codex writes a grounded brief without starting a build',
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'helix-intake-e2e-'));
    const projectId = projectIdSchema.parse('project_intake_smoke');
    const draft: IntakeDraft = {
      id: 'smoke',
      revision: 1,
      title: 'Personal reading list',
      originalGoal:
        'A simple local-only reading list for one adult reader, with adding book titles, marking a book read, and filtering unread books. A calm plain appearance. No accounts, cloud services, social features or recommendations. Done means a book can be added, survives reload, is marked read and hidden by unread filter. Avoid clutter and any login screen. Keep scope to those functions.',
      mode: 'interview',
      answers: [],
      synthesis: null,
      versions: [],
      status: 'generating',
    };
    try {
      const writer = createIntakeWriter(
        createHarness('codex', {
          codexSandbox: 'read-only',
          codexApprovalPolicy: 'never',
          autoApproveSafeCommands: false,
        }),
        dir,
        projectId,
      );
      const result = await writer.generate(draft, new AbortController().signal, projectId);
      expect(result.brief.length).toBeGreaterThan(100);
      expect(result.confirmed.every((c) => c.answerIds.every((id) => id === 'original-goal'))).toBe(
        true,
      );
      expect(result.brief.toLowerCase()).toContain('reading');
      console.info(
        JSON.stringify({
          briefWriterSmoke: {
            unknowns: result.unknowns,
            assumptions: result.assumptions,
            confirmedCount: result.confirmed.length,
            brief: result.brief,
          },
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  240000,
);
