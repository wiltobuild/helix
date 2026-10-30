import { randomUUID } from 'node:crypto';
import {
  HelixError,
  intakeDraftSchema,
  intakeRequestSchema,
  intakeSynthesisSchema,
  type IntakeDraft,
  type IntakeRequest,
  type IntakeSynthesis,
  type HelixStore,
  type HelixCore,
  type ProjectId,
  type MetaValue,
} from '@helix/contracts';

export interface IntakeWriter {
  generate(draft: IntakeDraft, signal: AbortSignal, projectId: ProjectId): Promise<IntakeSynthesis>;
}

/** Durable pre-build workspace. No worker, plan or design session exists until approval. */
export function createIntakeService(store: HelixStore, core: HelixCore, writer: IntakeWriter) {
  const jobs = new Map<string, AbortController>();
  const locks = new Map<string, Promise<unknown>>();
  function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    locks.set(id, next);
    return next;
  }
  const read = async (id: ProjectId) => {
    const value = await store.getMeta('build-intake', id);
    return value ? intakeDraftSchema.parse(value) : null;
  };
  const save = (id: ProjectId, draft: IntakeDraft) =>
    store.setMeta('build-intake', id, JSON.parse(JSON.stringify(draft)) as MetaValue);
  const conflict = () =>
    new HelixError('CONFLICT', 'The brief changed. Reload it before continuing.');
  async function get(id: ProjectId) {
    if (!(await core.listProjects()).some((p) => p.id === id))
      throw new HelixError('NOT_FOUND', 'Project not found');
    const draft = await read(id);
    if (draft?.status === 'generating' && !jobs.has(draft.id)) {
      draft.status = 'failed';
      draft.error = 'Draft generation was interrupted. Review your saved answers and retry.';
      await save(id, draft);
    }
    return draft;
  }
  return {
    projectIntake: (id: ProjectId) => serial(id, async () => ({ draft: await get(id) })),
    changeIntake: (id: ProjectId, raw: IntakeRequest) =>
      serial(id, async () => {
        const request = intakeRequestSchema.parse(raw);
        let draft = await get(id);
        const hash = JSON.stringify(request);
        const receipt = await store.recall(`intake-command:${id}`, request.requestId, hash);
        if (receipt) return { draft };
        if (request.action === 'new') {
          if (draft && (draft.id !== request.id || draft.revision !== request.revision))
            throw conflict();
          if (draft?.status === 'launching') throw conflict();
          if (draft) jobs.get(draft.id)?.abort();
          draft = {
            id: randomUUID(),
            revision: 1,
            title: '',
            originalGoal: '',
            mode: request.mode,
            answers: [],
            synthesis: null,
            versions: [],
            status: 'editing',
          };
        } else {
          if (!draft || draft.id !== request.id || draft.revision !== request.revision)
            throw conflict();
          if (draft.status === 'launched') return { draft };
          if (draft.status === 'launching' && request.action !== 'approve') throw conflict();
          if (request.action === 'approve') {
            if (
              !draft.title.trim() ||
              !draft.originalGoal.trim() ||
              !draft.synthesis?.brief ||
              draft.synthesis.unknowns.length ||
              !['review', 'launching'].includes(draft.status)
            ) {
              throw new HelixError(
                'INVALID_REQUEST',
                'Review a complete brief and resolve consequential questions before approving.',
              );
            }
            // Save exact authorization before launching. An uncertain response retries the same creation key.
            draft.approved ??= {
              intakeId: draft.id,
              revision: draft.revision,
              text: draft.synthesis.brief,
              approvedAt: new Date().toISOString(),
              answers: draft.answers,
              assumptions: draft.synthesis.assumptions,
            };
            draft.status = 'launching';
            await save(id, draft);
            const session = await core.createSession(
              id,
              {
                title: draft.title,
                prompt: draft.originalGoal,
                reviewedBrief: draft.approved,
                agent: 'claude-code',
                interface: 'chat',
                planWithOrchestrator: true,
              },
              `intake:${draft.id}:${draft.approved.revision}`,
            );
            draft.sessionId = session.id;
            draft.status = 'launched';
          } else {
            jobs.get(draft.id)?.abort();
            jobs.delete(draft.id);
            delete draft.error;
            delete draft.approved;
            draft.revision++;
            if (request.action === 'edit') {
              draft.title = request.title;
              draft.originalGoal = request.originalGoal;
              draft.answers = request.answers;
              draft.synthesis = null;
              draft.status = 'editing';
            } else if (request.action === 'cancel') {
              draft.status = 'editing';
            } else if (request.action === 'brief') {
              draft.synthesis = {
                brief: request.text,
                question: draft.synthesis?.question ?? '',
                choices: [],
                unknowns: draft.synthesis?.unknowns ?? [],
                assumptions: draft.synthesis?.assumptions ?? [],
                confirmed: draft.synthesis?.confirmed ?? [],
              };
              draft.versions.push({ revision: draft.revision, text: request.text, source: 'user' });
              draft.status = 'review';
            } else {
              if (!draft.originalGoal.trim())
                throw new HelixError('INVALID_REQUEST', 'Describe your intended outcome first.');
              draft.status = 'generating';
              const controller = new AbortController();
              jobs.set(draft.id, controller);
              const snapshot = structuredClone(draft);
              // Generation runs outside the mutation lock. Edits/cancel invalidate this revision immediately.
              void Promise.resolve()
                .then(() => writer.generate(snapshot, controller.signal, id))
                .then((result) =>
                  serial(id, async () => {
                    const current = await read(id);
                    if (
                      !current ||
                      current.id !== snapshot.id ||
                      current.revision !== snapshot.revision ||
                      controller.signal.aborted
                    )
                      return;
                    const synthesis = intakeSynthesisSchema.parse(result);
                    const answerIds = new Set([
                      'original-goal',
                      ...snapshot.answers.map((a) => a.id),
                    ]);
                    if (
                      synthesis.confirmed.some(
                        (f) => !f.answerIds.length || f.answerIds.some((a) => !answerIds.has(a)),
                      )
                    )
                      throw new Error('Invalid answer provenance');
                    if (synthesis.unknowns.length && !synthesis.question.trim())
                      throw new Error('Missing discovery question');
                    current.synthesis = synthesis;
                    current.versions.push({
                      revision: current.revision,
                      text: synthesis.brief,
                      source: 'agent',
                    });
                    current.status = 'review';
                    await save(id, current);
                  }),
                )
                .catch(() =>
                  serial(id, async () => {
                    const current = await read(id);
                    if (
                      !current ||
                      current.id !== snapshot.id ||
                      current.revision !== snapshot.revision ||
                      controller.signal.aborted
                    )
                      return;
                    current.status = 'failed';
                    current.error =
                      'The brief writer could not complete a valid response. Your answers are saved. Check the configured Codex CLI and retry.';
                    await save(id, current);
                  }),
                )
                .finally(() => {
                  if (jobs.get(snapshot.id) === controller) jobs.delete(snapshot.id);
                });
            }
          }
        }
        await save(id, draft);
        await store.remember(`intake-command:${id}`, request.requestId, hash, { accepted: true });
        return { draft };
      }),
    closeIntake: () => {
      for (const job of jobs.values()) job.abort();
    },
  };
}
