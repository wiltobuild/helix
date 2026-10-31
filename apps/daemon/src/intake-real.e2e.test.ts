import { expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test.skipIf(process.env.HELIX_INTAKE_CONVERSATION_SMOKE !== '1')(
  'real Codex develops a concept and adapts to a change of direction',
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'helix-conversation-e2e-'));
    const projectId = projectIdSchema.parse('project_conversation_smoke');
    const draft: IntakeDraft = {
      id: 'conversation-smoke',
      revision: 1,
      title: 'A calmer shared home',
      originalGoal:
        'I want to design something that makes living with housemates feel calmer. I do not have a product concept yet. Help me come up with one.',
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
      const first = await writer.generate(draft, new AbortController().signal, projectId);
      expect(first.message?.length).toBeGreaterThan(30);
      expect(first.question.trim().length).toBeGreaterThan(10);
      const reply =
        'I like the focus on a calmer home, but definitely not chore tracking or splitting bills. Explore a few ideas around quiet hours and guests instead. It should feel welcoming rather than like a rulebook. This is for four adult housemates.';
      const secondDraft: IntakeDraft = {
        ...draft,
        revision: 2,
        answers: [
          {
            id: 'direction-change',
            question: first.question,
            answer: reply,
            source: 'user',
            ...(first.message ? { assistantMessage: first.message } : {}),
          },
        ],
      };
      const second = await writer.generate(secondDraft, new AbortController().signal, projectId);
      expect(second.message?.length).toBeGreaterThan(30);
      expect(second.choices.length).toBeGreaterThanOrEqual(2);
      expect(
        second.confirmed.every((item) =>
          item.answerIds.every((id) => ['original-goal', 'direction-change'].includes(id)),
        ),
      ).toBe(true);
      const evidence = {
        conversationDemo: {
          mode: 'REAL CODEX / isolated scratch / no build created',
          originalGoal: draft.originalGoal,
          first,
          reply,
          second,
        },
      };
      console.info(JSON.stringify(evidence));
      if (process.env.HELIX_INTAKE_DEMO_RECEIPT)
        await writeFile(process.env.HELIX_INTAKE_DEMO_RECEIPT, JSON.stringify(evidence, null, 2));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  480000,
);
