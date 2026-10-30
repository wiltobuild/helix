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
  generate(
    draft: IntakeDraft,
    signal: AbortSignal,
    projectId?: ProjectId,
  ): Promise<IntakeSynthesis>;
}

/** Durable pre-build workspace. No worker, plan or design session exists until approval. */
export function createIntakeService(store: HelixStore, core: HelixCore, writer: IntakeWriter) {
  const DISCOVERY = Symbol('independent discovery');
  type Scope = ProjectId | typeof DISCOVERY;
  const jobs = new Map<string, AbortController>();
  const locks = new Map<string, Promise<unknown>>();
  function serial<T>(_id: Scope, action: () => Promise<T>): Promise<T> {
    const next = (locks.get('intake') ?? Promise.resolve()).catch(() => {}).then(action);
    locks.set('intake', next);
    return next;
  }
  const read = async (id: Scope) => {
    const pointer = id === DISCOVERY ? await store.getMeta('discovery-current', 'draft') : null;
    const value =
      id === DISCOVERY
        ? typeof pointer === 'string'
          ? await store.getMeta('discovery-drafts', pointer)
          : null
        : await store.getMeta('build-intake', id);
    return value ? intakeDraftSchema.parse(value) : null;
  };
  const save = async (id: Scope, draft: IntakeDraft) => {
    const value = JSON.parse(JSON.stringify(draft)) as MetaValue;
    if (id === DISCOVERY) {
      await store.setMeta('discovery-drafts', draft.id, value);
      await store.setMeta('discovery-current', 'draft', draft.id);
    } else await store.setMeta('build-intake', id, value);
  };
  const conflict = () =>
    new HelixError('CONFLICT', 'The brief changed. Reload it before continuing.');
  async function get(id: Scope) {
    if (id !== DISCOVERY && !(await core.listProjects()).some((p) => p.id === id))
      throw new HelixError('NOT_FOUND', 'Project not found');
    const draft = await read(id);
    if (draft?.status === 'generating' && !jobs.has(draft.id)) {
      draft.status = 'failed';
      draft.error = 'Draft generation was interrupted. Review your saved answers and retry.';
      await save(id, draft);
    }
    return draft;
  }
  const change = (id: Scope, raw: IntakeRequest) =>
    serial(id, async () => {
      const request = intakeRequestSchema.parse(raw);
      let draft = await get(id);
      const hash = JSON.stringify(request);
      const receiptScope = id === DISCOVERY ? 'discovery-command' : `intake-command:${id}`;
      const receipt = await store.recall(receiptScope, request.requestId, hash);
      if (receipt) {
        const acceptedId = (receipt as { draftId?: string }).draftId;
        if (!draft || (acceptedId ? acceptedId !== draft.id : request.id !== draft.id))
          throw conflict();
        return { draft };
      }
      if (id !== DISCOVERY) {
        const independent = await read(DISCOVERY);
        if (independent?.destinationProjectId === id && independent.status !== 'launched')
          throw new HelixError(
            'CONFLICT',
            'An independent discovery draft is already bound to this destination.',
          );
      }
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
          const destination = id === DISCOVERY ? draft.destinationProjectId : id;
          if (!destination || !(await core.listProjects()).some((p) => p.id === destination))
            throw new HelixError(
              'INVALID_REQUEST',
              'Choose a registered destination before approving.',
            );
          if (id === DISCOVERY) {
            const existing = await read(destination);
            if (
              existing &&
              existing.status !== 'launched' &&
              (existing.originalGoal.trim() || existing.status === 'launching')
            )
              throw new HelixError('CONFLICT', 'This destination already has an active draft.');
          }
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
            destination,
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
          if (request.action === 'bind') {
            if (id !== DISCOVERY)
              throw new HelixError(
                'INVALID_REQUEST',
                'Only independent discovery drafts can change destination.',
              );
            if (!(await core.listProjects()).some((p) => p.id === request.projectId))
              throw new HelixError('NOT_FOUND', 'Destination project not found');
            const existing = await read(request.projectId);
            if (
              existing &&
              existing.status !== 'launched' &&
              (existing.originalGoal.trim() || existing.status === 'launching')
            )
              throw new HelixError(
                'CONFLICT',
                'This destination already has a draft. Finish or replace that draft explicitly first.',
              );
          }
          jobs.get(draft.id)?.abort();
          jobs.delete(draft.id);
          delete draft.error;
          delete draft.approved;
          draft.revision++;
          if (request.action === 'bind') {
            draft.destinationProjectId = request.projectId;
            draft.status = draft.synthesis ? 'review' : 'editing';
          } else if (request.action === 'edit') {
            draft.title = request.title;
            draft.originalGoal = request.originalGoal;
            draft.answers = request.answers;
            draft.synthesis = null;
            draft.status = 'editing';
          } else if (request.action === 'cancel') {
            draft.status = 'editing';
          } else if (request.action === 'brief') {
            draft.synthesis = {
              ...(draft.synthesis?.message ? { message: draft.synthesis.message } : {}),
              brief: request.text,
              question: draft.synthesis?.question ?? '',
              choices: draft.synthesis?.choices ?? [],
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
              .then(() =>
                writer.generate(snapshot, controller.signal, id === DISCOVERY ? undefined : id),
              )
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
      await store.remember(receiptScope, request.requestId, hash, {
        accepted: true,
        draftId: draft.id,
      });
      return { draft };
    });
  return {
    projectIntake: (id: ProjectId) => serial(id, async () => ({ draft: await get(id) })),
    changeIntake: (id: ProjectId, request: IntakeRequest) => change(id, request),
    discoveryIntake: () => serial(DISCOVERY, async () => ({ draft: await get(DISCOVERY) })),
    changeDiscovery: (request: IntakeRequest) => change(DISCOVERY, request),
    closeIntake: () => {
      for (const job of jobs.values()) job.abort();
    },
  };
}
