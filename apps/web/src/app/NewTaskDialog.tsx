import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  ArrowRight,
  Check,
  CircleX,
  FileText,
  FolderGit2,
  FolderPlus,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { HelixClient } from '@helix/api-client';
import type { HarnessInfo, IntakeDraft, IntakeRequest, Project } from '@helix/contracts';
import { Button, Dialog, HelixLogo, TextArea, TextField } from '@helix/ui';
import {
  approvalBlockers,
  briefSurvivesRename,
  citationLabel,
  clearIfUnchanged,
  editLocks,
  intakeStage,
  intakeScopeSwitchHeld,
  pendingAnswerNote,
  provisionalTitle,
  reconcileDraft,
  unsavedBriefProblem,
  writerReadiness,
  type IntakeStage,
  type PendingAnswer,
  type WriterReadiness,
} from './intakeModel';
import s from './NewTaskDialog.module.css';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client?: HelixClient;
  project?: Project;
  /** Repositories the user can switch between (existing app project selection). */
  projects?: readonly Project[];
  onSelectProject?: (id: string) => void;
  onAddProject?: () => void;
  onCreated: (id: string, projectId?: Project['id']) => void;
}

export function NewTaskDialog(props: Props) {
  // Unsent words outlive a repository switch or a close; durable state lives in the draft.
  // Neither is ever submitted on the user's behalf.
  const [idea, setIdea] = useState('');
  const [discovery, setDiscovery] = useState(true);
  const [intent, setIntent] = useState<'new' | 'existing'>('new');
  const [pendingAnswers, setPendingAnswers] = useState<Record<string, PendingAnswer>>({});
  return (
    <BuildIntake
      key={discovery ? 'discovery' : (props.project?.id ?? 'demo')}
      {...props}
      discovery={discovery}
      onDiscovery={setDiscovery}
      intent={intent}
      onIntent={setIntent}
      idea={idea}
      onIdea={setIdea}
      pendingAnswers={pendingAnswers}
      onPendingAnswers={setPendingAnswers}
    />
  );
}

/** Omit applied per union member, so each action keeps its own fields (plain Omit collapses them). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An intake request before the revision/request-ID envelope is added by `call`. */
type Action = DistributiveOmit<IntakeRequest, 'id' | 'revision' | 'requestId'>;

function BuildIntake({
  discovery,
  onDiscovery,
  open,
  onOpenChange,
  client,
  project,
  projects,
  onSelectProject,
  onAddProject,
  onCreated,
  intent,
  onIntent,
  idea,
  onIdea,
  pendingAnswers,
  onPendingAnswers,
}: Props & {
  discovery: boolean;
  onDiscovery: (value: boolean) => void;
  intent: 'new' | 'existing';
  onIntent: (intent: 'new' | 'existing') => void;
  idea: string;
  onIdea: Dispatch<SetStateAction<string>>;
  pendingAnswers: Record<string, PendingAnswer>;
  onPendingAnswers: Dispatch<SetStateAction<Record<string, PendingAnswer>>>;
}) {
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [answers, setAnswers] = useState<IntakeDraft['answers']>([]);
  const [brief, setBrief] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** An approval whose outcome is unknown: everything stays frozen until the daemon says. */
  const [uncertain, setUncertain] = useState<{ id: string; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [startingOver, setStartingOver] = useState(false);
  const [beginning, setBeginning] = useState<'direct' | 'interview' | null>(null);
  const [harnesses, setHarnesses] = useState<readonly HarnessInfo[]>();
  const gate = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const projectId = project?.id;
  const demo = !client || (!discovery && !project);
  const adopt = (next: IntakeDraft | null) => {
    if (!alive.current) return;
    setDraft(next);
    setTitle(next?.title ?? '');
    setGoal(next?.originalGoal ?? '');
    setAnswers(next?.answers ?? []);
    setBrief(next?.synthesis?.brief ?? '');
  };
  useEffect(() => {
    if (!open || !client || (!discovery && !projectId) || loaded) return;
    let cancelled = false;
    void (discovery ? client.discoveryIntake() : client.projectIntake(projectId!))
      .then(({ draft: next }) => {
        if (!cancelled) {
          adopt(next);
          setUncertain(null);
          setLoaded(true);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, client, projectId, loaded, discovery]);
  useEffect(() => {
    if (!open || !client) return;
    let cancelled = false;
    // Detection only informs copy; without it Helix claims nothing about the writer.
    void Promise.resolve()
      .then(() => client.harnesses())
      .then((list) => {
        if (!cancelled) setHarnesses(list);
      })
      .catch(() => {
        if (!cancelled) setHarnesses(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [open, client]);
  useEffect(() => {
    if (!open || !client || (!discovery && !projectId) || draft?.status !== 'generating') return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (discovery ? client.discoveryIntake() : client.projectIntake(projectId!))
        .then(({ draft: next }) => {
          if (
            !cancelled &&
            alive.current &&
            next?.id === draft.id &&
            next.revision === draft.revision &&
            next.status !== 'generating'
          )
            adopt(next);
        })
        .catch((err) => setError(String(err)));
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, client, projectId, draft, discovery]);
  const dirty =
    !!draft &&
    (title !== draft.title ||
      goal !== draft.originalGoal ||
      JSON.stringify(answers) !== JSON.stringify(draft.answers));
  const briefEdited = !!draft?.synthesis && brief !== draft.synthesis.brief;
  const question = draft?.synthesis?.question ?? '';
  const pendingAnswer = draft ? pendingAnswers[draft.id] : undefined;
  const answer = pendingAnswer?.text ?? '';
  const setAnswer = (text: string) => {
    if (!draft) return;
    // Re-typing attaches the text to the question now showing; it is still only a draft answer.
    onPendingAnswers((all) => ({ ...all, [draft.id]: { question, text } }));
  };
  const clearAnswer = (draftId: string, submitted: string) =>
    onPendingAnswers((all) => {
      const current = all[draftId];
      if (!current || clearIfUnchanged(current.text, submitted)) return all;
      const rest = { ...all };
      delete rest[draftId];
      return rest;
    });
  const retry = useRef<{ hash: string; requestId: string } | undefined>(undefined);
  const call = async (current: IntakeDraft | null, action: Action) => {
    if (!client || (!discovery && !project)) throw new Error('Connect to Helix before continuing.');
    const body = { ...action, id: current?.id ?? 'new', revision: current?.revision ?? 0 };
    const hash = JSON.stringify(body);
    // The same intended mutation keeps its request ID across retries, so the daemon dedupes it.
    if (retry.current?.hash !== hash) retry.current = { hash, requestId: crypto.randomUUID() };
    const request = { ...body, requestId: retry.current.requestId };
    const result = await (discovery
      ? client.changeDiscovery(request)
      : client.changeIntake(project!.id, request));
    retry.current = undefined;
    if (!result.draft) throw new Error('No draft returned');
    return result.draft;
  };
  /** After a failed request, learn the saved draft without discarding valid local words. */
  const reconcile = async () => {
    if (!client || (!discovery && !projectId)) return false;
    try {
      const { draft: next } = await (discovery
        ? client.discoveryIntake()
        : client.projectIntake(projectId!));
      if (!alive.current) return true;
      setUncertain(null);
      const decision = reconcileDraft(draft, next, dirty || briefEdited);
      if (decision.action === 'adopt') adopt(next);
      if (decision.action === 'keepLocal') setDraft(next);
      if (decision.discardsLocal)
        setNotice(
          next?.status === 'launching' || next?.status === 'launched'
            ? 'Your approval was recorded before these edits, so the build uses the approved brief. Unsaved edits were not applied.'
            : 'This repository’s draft changed elsewhere, so your unsaved edits could not be applied.',
        );
      return true;
    } catch {
      // The original error is already shown; an uncertain approval stays frozen.
      return false;
    }
  };
  const run = async (operation: () => Promise<void>) => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (err) {
      if (alive.current) {
        setError(err instanceof Error ? err.message : String(err));
        await reconcile();
      }
    } finally {
      gate.current = false;
      if (alive.current) {
        setBusy(false);
        setBeginning(null);
      }
    }
  };
  const save = async (nextAnswers = answers) => {
    if (!draft) throw new Error('Describe what you want to build first.');
    if (!dirty && nextAnswers === answers) return draft;
    const next = await call(draft, {
      action: 'edit',
      title,
      originalGoal: goal,
      answers: nextAnswers,
    });
    adopt(next);
    return next;
  };
  const generate = (nextAnswers = answers, submitted?: string) =>
    run(async () => {
      const saved = await save(nextAnswers);
      adopt(await call(saved, { action: 'generate' }));
      // Only the answer that was actually sent is cleared; "Ask me questions" keeps typed text.
      if (submitted !== undefined) clearAnswer(saved.id, submitted);
    });
  const respond = (text: string, source: 'user' | 'recommendation-accepted' = 'user') => {
    if (!text.trim()) return;
    void generate(
      [
        ...answers,
        {
          id: crypto.randomUUID(),
          question: question || 'Anything else to refine',
          answer: text.trim(),
          source,
          ...(draft?.synthesis?.choices.length ? { offeredChoices: draft.synthesis.choices } : {}),
          ...(draft?.synthesis?.message ? { assistantMessage: draft.synthesis.message } : {}),
        },
      ],
      source === 'user' ? text : undefined,
    );
  };
  /** Start from the composer. Each step is revision-bound; a failure leaves the words in place. */
  const begin = (mode: 'direct' | 'interview', intent?: 'new' | 'existing') =>
    void run(async () => {
      const text = idea.trim();
      if (!text) return;
      setBeginning(mode);
      const created = await call(draft, { action: 'new', mode });
      adopt(created);
      const saved = await call(created, {
        action: 'edit',
        title: provisionalTitle(text),
        originalGoal: text,
        answers:
          intent && mode === 'interview'
            ? [
                {
                  id: crypto.randomUUID(),
                  question: 'Starting context',
                  answer:
                    intent === 'new'
                      ? 'Develop a new product concept. No repository context has been inspected.'
                      : 'Improve the selected existing project. Ask me for relevant context; you have not inspected its files.',
                  source: 'user' as const,
                },
              ]
            : [],
      });
      adopt(saved);
      // The composer is locked while starting; this also guards text typed by any other path.
      onIdea((current) => clearIfUnchanged(current, text));
      setStartingOver(false);
      adopt(
        await call(
          saved,
          mode === 'interview' ? { action: 'generate' } : { action: 'brief', text },
        ),
      );
    });
  /** Save edits before close/switch. Unsent answers are kept locally, never submitted here. */
  const persistLocal = async () => {
    if (!draft || ['launching', 'launched', 'generating'].includes(draft.status)) return;
    if (dirty && briefEdited)
      throw new Error('Save or discard your brief edits first; saving other edits replaces them.');
    // Never close over unsaved prose: an empty brief can't be saved, so the user must decide.
    const blocked = unsavedBriefProblem({ briefEdited, brief, status: draft.status });
    if (blocked) throw new Error(blocked);
    if (dirty) await save();
    else if (briefEdited) adopt(await call(draft, { action: 'brief', text: brief }));
  };
  const close = () =>
    void run(async () => {
      await persistLocal();
      onOpenChange(false);
      // Everything local is saved; reopening re-reads the daemon so status is never stale.
      setLoaded(false);
    });
  const switchProject = (id: string) =>
    void run(async () => {
      // Save first so a pending edit is never dropped by remounting on another repository.
      await persistLocal();
      onSelectProject?.(id);
    });
  const addProject = () =>
    void run(async () => {
      await persistLocal();
      onOpenChange(false);
      onAddProject?.();
    });
  const rename = () =>
    void run(async () => {
      if (!draft) return;
      const carry = draft.status === 'review' && briefSurvivesRename(draft.synthesis);
      const prose = draft.synthesis?.brief;
      const saved = await save();
      adopt(saved);
      if (carry && prose) adopt(await call(saved, { action: 'brief', text: prose }));
    });
  const approve = () =>
    void run(async () => {
      if (!draft) return;
      // Until the daemon answers, the outcome is unknown: freeze edits so a retry can only resend
      // this exact approval (same revision, same request ID), never approve something edited.
      setUncertain({ id: draft.id, revision: draft.revision });
      const next = await call(draft, { action: 'approve' });
      setUncertain(null);
      adopt(next);
      if (next.sessionId && alive.current) {
        onCreated(next.sessionId, next.destinationProjectId ?? project?.id);
        onOpenChange(false);
      }
    });

  const stage = startingOver ? 'start' : intakeStage(draft);
  const approvalUnknown =
    !!uncertain && uncertain.id === draft?.id && uncertain.revision === draft?.revision;
  const locked =
    busy ||
    !loaded ||
    approvalUnknown ||
    ['generating', 'launching', 'launched'].includes(draft?.status ?? '');
  const blockers = approvalBlockers({ draft, dirty, briefEdited, title, goal });
  if (discovery && !draft?.destinationProjectId)
    blockers.push('Choose a destination when you are ready to turn this concept into a plan.');
  const scopeSwitchHeld = intakeScopeSwitchHeld({
    busy,
    loaded,
    approvalUnknown,
    status: draft?.status,
  });
  const context = discovery ? (
    <section className={s.context} aria-label="Discovery workspace">
      <div className={s.contextText}>
        <strong>Saved in Helix</strong>
        <span className={s.contextHint}>
          Your conversation is saved independently. No repository is needed to develop the idea.
        </span>
      </div>
      {project && (
        <Button
          size="sm"
          variant="ghost"
          disabled={scopeSwitchHeld}
          onClick={() =>
            void run(async () => {
              await persistLocal();
              onDiscovery(false);
            })
          }
        >
          Resume this repository’s earlier draft
        </Button>
      )}
    </section>
  ) : (
    <div>
      <Button
        size="sm"
        variant="ghost"
        disabled={scopeSwitchHeld}
        onClick={() =>
          void run(async () => {
            await persistLocal();
            onDiscovery(true);
          })
        }
      >
        Return to independent conversation
      </Button>
      <ProjectContext
        {...(project ? { project } : {})}
        projects={projects ?? []}
        disabled={scopeSwitchHeld}
        demo={demo}
        {...(onSelectProject ? { onSelect: switchProject } : {})}
        {...(onAddProject ? { onAdd: addProject } : {})}
      />
    </div>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      wide
      title={<span className={s.srOnly}>New build</span>}
    >
      <div className={s.root} data-stage={stage}>
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className={s.notice}>
            {notice}
          </p>
        )}
        {stage === 'start' ? (
          <IntakeStart
            context={context}
            intent={intent}
            onIntent={onIntent}
            idea={idea}
            onIdea={onIdea}
            disabled={demo || busy || !loaded}
            composerLocked={demo || busy}
            {...(beginning ? { pending: beginning } : {})}
            demo={demo}
            readiness={writerReadiness(harnesses)}
            onBegin={begin}
            {...(draft?.status === 'launched' && draft.sessionId && !startingOver
              ? {
                  launched: {
                    title: draft.title,
                    onOpen: () => {
                      onCreated(draft.sessionId!, draft.destinationProjectId ?? project?.id);
                      onOpenChange(false);
                    },
                  },
                }
              : {})}
            {...(startingOver ? { onBack: () => setStartingOver(false) } : {})}
          />
        ) : draft ? (
          <IntakeWorkspace
            context={context}
            destination={
              discovery ? (
                <DiscoveryDestination
                  draft={draft}
                  projects={projects ?? []}
                  disabled={locked || busy || dirty || briefEdited}
                  onBind={(projectId) =>
                    void run(async () => {
                      const saved = await save();
                      adopt(await call(saved, { action: 'bind', projectId }));
                    })
                  }
                />
              ) : undefined
            }
            draft={draft}
            stage={stage}
            title={title}
            onTitle={setTitle}
            goal={goal}
            onGoal={setGoal}
            answers={answers}
            onAnswers={setAnswers}
            answer={answer}
            onAnswer={setAnswer}
            answerNote={pendingAnswerNote(pendingAnswer, question)}
            brief={brief}
            onBrief={setBrief}
            dirty={dirty}
            briefEdited={briefEdited}
            approvalUnknown={approvalUnknown}
            locked={locked}
            busy={busy}
            demo={demo}
            blockers={blockers}
            pendingIdea={idea}
            onDiscardPendingIdea={() => onIdea('')}
            actions={{
              respond,
              generate: () => void generate(),
              useAsWritten: () =>
                void run(async () => {
                  const saved = await save();
                  adopt(await call(saved, { action: 'brief', text: goal }));
                }),
              saveInputs: () =>
                void run(async () => {
                  await save();
                }),
              discardInputs: () => adopt(draft),
              rename,
              cancel: () => void run(async () => adopt(await call(draft, { action: 'cancel' }))),
              saveBrief: () =>
                void run(async () => adopt(await call(draft, { action: 'brief', text: brief }))),
              discardBrief: () => setBrief(draft.synthesis?.brief ?? ''),
              approve,
              checkApproval: () =>
                void run(async () => {
                  if (!(await reconcile()))
                    throw new Error(
                      'Still can’t reach helixd. Your approval request is unchanged.',
                    );
                }),
              close,
              startOver: () => setStartingOver(true),
            }}
          />
        ) : null}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Presentational views. Exported for render tests; all state and requests live above.         */
/* ------------------------------------------------------------------------------------------ */

export function ProjectContext({
  project,
  projects,
  disabled,
  demo,
  onSelect,
  onAdd,
}: {
  project?: Project;
  projects: readonly Project[];
  disabled: boolean;
  demo: boolean;
  onSelect?: (id: string) => void;
  onAdd?: () => void;
}) {
  const others = projects.filter((p) => p.id !== project?.id);
  return (
    <section className={s.context} aria-label="Repository for this build">
      <FolderGit2 size={16} aria-hidden className={s.contextIcon} />
      <div className={s.contextText}>
        {project && !demo ? (
          <>
            <span className={s.contextLabel}>Builds in</span>{' '}
            <strong className={s.contextName}>{project.name}</strong>
            <span className={s.contextPath} title={project.repoPath}>
              {project.repoPath}
            </span>
            <span className={s.contextHint}>
              This is where the code goes. It doesn’t decide what you build.
            </span>
          </>
        ) : (
          <>
            <strong className={s.contextName}>No repository connected</strong>
            <span className={s.contextHint}>
              {demo
                ? 'You’re viewing a recorded demo. Start helixd and add a local git repository to create a build.'
                : 'Add a local git repository so Helix has somewhere to build.'}
            </span>
          </>
        )}
      </div>
      <div className={s.contextActions}>
        {onSelect && others.length > 0 && project && !demo && (
          <label className={s.switcher}>
            <span className={s.srOnly}>Change repository</span>
            <select
              value={project.id}
              disabled={disabled}
              onChange={(e) => onSelect(e.target.value)}
            >
              {[project, ...others].map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === project.id ? `${p.name} (current)` : p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {onAdd && !demo && (
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderPlus size={14} aria-hidden />}
            disabled={disabled}
            onClick={onAdd}
          >
            {project ? 'Add another' : 'Add repository'}
          </Button>
        )}
      </div>
    </section>
  );
}

const READINESS: Record<WriterReadiness, string> = {
  ready: 'Guided shaping uses your local Codex CLI, detected as installed and signed in.',
  signin: 'Guided shaping uses your local Codex CLI, which reports it needs sign-in first.',
  missing:
    'Guided shaping needs the Codex CLI, which Helix did not detect. Review as written works.',
  unknown: 'Guided shaping uses your local Codex CLI. If it can’t run, you’ll see why; words stay.',
};

/** The PRD's paired dot strands, in their own field beside the writing. */
function StudioHelix() {
  const [paused, setPaused] = useState(false);
  return (
    <div className={s.helixArtwork} data-paused={paused || undefined}>
      <svg className={s.helix} viewBox="0 0 360 160" fill="none" aria-hidden>
        {Array.from({ length: 25 }, (_, i) => {
          const style = {
            '--phase': -i * 0.36 + 's',
            '--offset': Math.sin(i * 0.52) * 48 + 'px',
            '--static-rung': Math.sin(i * 0.52),
          } as CSSProperties;
          return (
            <g key={i} style={style}>
              <line className={s.helixRung} x1={12 + i * 14} x2={12 + i * 14} y1="32" y2="128" />
              <circle className={s.helixTeal} cx={12 + i * 14} cy="80" r="3.8" />
              <circle className={s.helixRust} cx={12 + i * 14} cy="80" r="3.8" />
            </g>
          );
        })}
      </svg>
      <button
        type="button"
        className={s.motionControl}
        aria-pressed={paused}
        onClick={() => setPaused(!paused)}
      >
        {paused ? 'Play animation' : 'Pause animation'}
      </button>
    </div>
  );
}

export function IntakeStart({
  context,
  intent,
  onIntent,
  idea,
  onIdea,
  disabled,
  composerLocked,
  pending,
  readiness,
  onBegin,
  launched,
  onBack,
}: {
  context: ReactNode;
  intent: 'new' | 'existing';
  onIntent: (intent: 'new' | 'existing') => void;
  idea: string;
  onIdea: (idea: string) => void;
  disabled: boolean;
  /** Typing and examples pause while a request runs, so what is sent is what is shown. */
  composerLocked: boolean;
  pending?: 'direct' | 'interview';
  demo: boolean;
  readiness: WriterReadiness;
  onBegin: (mode: 'direct' | 'interview', intent?: 'new' | 'existing') => void;
  launched?: { title: string; onOpen: () => void };
  onBack?: () => void;
}) {
  const empty = !idea.trim();
  return (
    <div className={s.start}>
      {launched && (
        <div className={s.notice} role="status">
          <Check size={14} aria-hidden />
          <span>
            <strong>{launched.title || 'Your last build'}</strong> was approved and started.
          </span>
          <Button size="sm" variant="outline" onClick={launched.onOpen}>
            Open build
          </Button>
        </div>
      )}
      {onBack && (
        <div className={s.notice} role="status">
          <span>
            Your current draft stays saved until you start this new one, which replaces it.
          </span>
          <Button size="sm" variant="ghost" onClick={onBack}>
            Back to current draft
          </Button>
        </div>
      )}
      <header className={s.hero}>
        <div className={s.heroCopy}>
          <p className={s.eyebrow}>HELIX / THE IDEA STUDIO</p>
          <h2 className={s.headline}>
            A spark is enough.
            <br />
            <em>Let's give it shape.</em>
          </h2>
          <p className={s.lede}>Bring the half-formed idea. We'll find its shape together.</p>
        </div>
        <div className={s.helixField}>
          <StudioHelix />
          <span>Two strands. One shared direction.</span>
        </div>
      </header>
      <div className={s.writingDesk}>
        <div className={s.promptIntro}>
          <div className={s.intentChoices} role="group" aria-label="Starting context">
            <button
              type="button"
              aria-pressed={intent === 'new'}
              disabled={composerLocked}
              onClick={() => onIntent('new')}
            >
              <Sparkles size={20} aria-hidden />
              <strong>A new project</strong>
              <span>Find the idea and shape it together</span>
            </button>
            <button
              type="button"
              aria-pressed={intent === 'existing'}
              disabled={composerLocked}
              onClick={() => onIntent('existing')}
            >
              <FolderGit2 size={20} aria-hidden />
              <strong>An existing project</strong>
              <span>Explore what could be better</span>
            </button>
          </div>
          <div className={s.welcome}>
            <span className={s.agentMark}>
              <HelixLogo size={24} />
            </span>
            <div>
              <strong>Helix</strong>
              <p>
                {intent === 'new'
                  ? 'What have you been imagining? Start with a problem, a feeling, or a half-formed idea.'
                  : 'What would you like to change? Tell me what exists today and what you wish it could do.'}
              </p>
            </div>
          </div>
        </div>
        <div className={s.composer}>
          <label htmlFor="build-idea" className={s.srOnly}>
            Describe what you want to build
          </label>
          <textarea
            id="build-idea"
            className={s.composerInput}
            value={idea}
            disabled={composerLocked}
            rows={3}
            placeholder="I’ve been thinking about…"
            aria-describedby="build-idea-tips"
            onChange={(e) => onIdea(e.target.value)}
          />
          <div className={s.composerBar}>
            <p id="build-idea-tips" className={s.tips}>
              No polished brief needed. You can ask for ideas, too.
            </p>
            <div className={s.composerActions}>
              <Button
                variant="secondary"
                icon={<FileText size={14} aria-hidden />}
                disabled={disabled || empty}
                loading={pending === 'direct'}
                onClick={() => onBegin('direct', intent)}
              >
                Review as written
              </Button>
              <Button
                variant="primary"
                icon={<Sparkles size={14} aria-hidden />}
                disabled={disabled || empty}
                loading={pending === 'interview'}
                onClick={() => onBegin('interview', intent)}
              >
                Let’s talk
              </Button>
            </div>
          </div>
        </div>
      </div>
      <details className={s.setupDetails}>
        <summary>
          <FolderGit2 size={14} aria-hidden /> Where this conversation is saved
        </summary>
        <p>
          Choosing a context creates nothing. This discussion is saved in Helix. A repository is
          only needed later, when you approve a plan. No files have been read.
        </p>
        {context}
      </details>
      <p className={s.safetyLine}>
        <ShieldCheck size={14} aria-hidden /> Conversation → concept → your approval → plan.
        Building comes after approval.
      </p>
      <p className={s.footnote}>{READINESS[readiness]}</p>
    </div>
  );
}

interface WorkspaceActions {
  respond: (text: string, source?: 'user' | 'recommendation-accepted') => void;
  generate: () => void;
  useAsWritten: () => void;
  saveInputs: () => void;
  discardInputs: () => void;
  rename: () => void;
  cancel: () => void;
  saveBrief: () => void;
  discardBrief: () => void;
  approve: () => void;
  checkApproval: () => void;
  close: () => void;
  startOver: () => void;
}

const UNSURE =
  'I am unsure. Recommend concrete options and explain their tradeoffs; do not choose for me.';

export function IntakeWorkspace({
  context,
  destination,
  draft,
  stage,
  title,
  onTitle,
  goal,
  onGoal,
  answers,
  onAnswers,
  answer,
  onAnswer,
  answerNote,
  brief,
  onBrief,
  dirty,
  briefEdited,
  approvalUnknown = false,
  locked,
  busy,
  demo,
  blockers,
  pendingIdea,
  onDiscardPendingIdea,
  actions,
}: {
  context: ReactNode;
  destination?: ReactNode;
  draft: IntakeDraft;
  stage: Exclude<IntakeStage, 'start'>;
  title: string;
  onTitle: (v: string) => void;
  goal: string;
  onGoal: (v: string) => void;
  answers: IntakeDraft['answers'];
  onAnswers: (v: IntakeDraft['answers']) => void;
  answer: string;
  onAnswer: (v: string) => void;
  /** Shown when the unsent answer was typed for a different question. */
  answerNote?: string | undefined;
  brief: string;
  onBrief: (v: string) => void;
  dirty: boolean;
  briefEdited: boolean;
  approvalUnknown?: boolean;
  locked: boolean;
  busy: boolean;
  demo: boolean;
  blockers: string[];
  pendingIdea: string;
  onDiscardPendingIdea: () => void;
  actions: WorkspaceActions;
}) {
  const synthesis = draft.synthesis;
  const titleChanged = title !== draft.title;
  const onlyTitleChanged =
    titleChanged &&
    goal === draft.originalGoal &&
    JSON.stringify(answers) === JSON.stringify(draft.answers);
  const holds = editLocks({ dirty, briefEdited });
  const inputsLocked = locked || stage === 'launching' || holds.inputs;
  return (
    <div className={s.workspace}>
      <header className={s.studioHeader}>
        <div className={s.workspaceIdentity}>
          <HelixLogo size={42} active={stage === 'generating'} />
          <div>
            <p className={s.eyebrow}>HELIX / THE IDEA STUDIO</p>
            <h2>Let’s shape your idea.</h2>
          </div>
        </div>
        <span>
          Explore <ArrowRight size={12} aria-hidden /> Review concept{' '}
          <ArrowRight size={12} aria-hidden /> Approve plan
        </span>
      </header>
      <details className={s.setupDetails}>
        <summary>Workspace & conversation settings</summary>
        {context}
        <div className={s.nameRow}>
          <TextField
            id="build-name"
            label="Build name"
            hint={
              onlyTitleChanged && stage === 'review'
                ? briefSurvivesRename(synthesis)
                  ? 'Saving the new name keeps your brief as written.'
                  : 'A name is part of what you approve, so renaming asks for the brief to be written again.'
                : 'Suggested from your idea. Rename it any time before approval.'
            }
            value={title}
            disabled={inputsLocked}
            onChange={(e) => onTitle(e.target.value)}
          />
          {onlyTitleChanged && (
            <div className={s.inlineActions}>
              <Button
                size="sm"
                disabled={busy || locked || holds.inputs || !title.trim()}
                onClick={actions.rename}
              >
                Save name
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onTitle(draft.title)}
              >
                Undo
              </Button>
            </div>
          )}
        </div>
      </details>
      {pendingIdea.trim() && (
        <div className={s.notice} role="status">
          <span>
            This repository already has a build in progress, so your new idea wasn’t started:{' '}
            <q className={s.pendingIdea}>{pendingIdea.trim()}</q>
          </span>
          <span className={s.inlineActions}>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || stage === 'launching'}
              onClick={actions.startOver}
            >
              Start it instead
            </Button>
            <Button size="sm" variant="ghost" onClick={onDiscardPendingIdea}>
              Dismiss
            </Button>
          </span>
        </div>
      )}
      <div className={s.columns}>
        <section className={s.conversation} aria-label="Shaping the build">
          <div className={s.transcript} aria-label="Conversation so far">
            <article className={s.userMessage}>
              <span>You</span>
              <p>{draft.originalGoal}</p>
            </article>
            {draft.answers
              .filter((item) => item.question !== 'Starting context')
              .map((item) => (
                <div key={item.id} className={s.turn}>
                  <article className={s.agentMessage}>
                    <span>Helix</span>
                    {item.assistantMessage && <p>{item.assistantMessage}</p>}
                    <p>{item.question}</p>
                    {!!item.offeredChoices?.length && (
                      <ul>
                        {item.offeredChoices.map((choice) => (
                          <li key={choice.label}>
                            <strong>{choice.label}</strong> — {choice.tradeoff}
                          </li>
                        ))}
                      </ul>
                    )}
                  </article>
                  <article className={s.userMessage}>
                    <span>You</span>
                    <p>{item.answer}</p>
                  </article>
                </div>
              ))}
          </div>
          <details className={s.idea}>
            <summary>
              <span className={s.sectionLabel}>Your idea</span>
              <span className={s.ideaPreview}>{goal || draft.originalGoal}</span>
            </summary>
            <TextArea
              id="build-goal"
              label="Your idea"
              hint="Edit your original words. Saving changes what the brief is based on."
              value={goal}
              disabled={inputsLocked}
              onChange={(e) => onGoal(e.target.value)}
            />
          </details>

          {holds.inputs && (
            <div className={s.notice} role="status">
              <span>
                Your brief has unsaved edits. Save or discard them before changing the idea, name or
                answers, because those changes set the brief aside.
              </span>
            </div>
          )}

          <CurrentStep
            draft={draft}
            stage={stage}
            answer={answer}
            onAnswer={onAnswer}
            answerNote={answerNote}
            dirty={dirty || holds.inputs}
            locked={locked}
            busy={busy}
            demo={demo}
            goalEmpty={!goal.trim()}
            answersIncomplete={answers.some((a) => !a.answer.trim())}
            actions={actions}
          />

          {dirty && !onlyTitleChanged && (
            <div className={s.notice} role="status">
              <span>
                You changed your saved inputs. Saving them sets the current brief aside until it is
                written again.
              </span>
              <span className={s.inlineActions}>
                <Button
                  size="sm"
                  disabled={busy || !goal.trim() || answers.some((a) => !a.answer.trim())}
                  onClick={actions.saveInputs}
                >
                  Save changes
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={actions.discardInputs}>
                  Discard
                </Button>
              </span>
            </div>
          )}

          {answers.length > 0 && (
            <details className={s.history}>
              <summary>
                <MessageSquare size={14} aria-hidden />
                {`Your answers so far (${answers.length}) — revisit or edit`}
              </summary>
              <ol className={s.historyList}>
                {answers.map((item, index) => (
                  <li key={item.id}>
                    <TextArea
                      id={`answer-${item.id}`}
                      label={`${index + 1}. ${item.question}`}
                      hint={
                        item.source === 'recommendation-accepted'
                          ? 'A recommendation you chose'
                          : 'Your answer'
                      }
                      value={item.answer}
                      disabled={inputsLocked}
                      onChange={(e) =>
                        onAnswers(
                          answers.map((a, i) =>
                            i === index
                              ? { ...a, answer: e.target.value, source: 'user' as const }
                              : a,
                          ),
                        )
                      }
                    />
                  </li>
                ))}
              </ol>
            </details>
          )}
        </section>

        <aside className={s.briefPanel} aria-label="Living brief">
          <div className={s.conceptCard}>
            <p className={s.eyebrow}>OUR WORKING CONCEPT</p>
            <h3>{draft.title || 'Taking shape'}</h3>
            <p className={s.conceptIntro}>
              {synthesis
                ? 'Here’s where we are. Nothing is committed until you approve.'
                : 'As we talk, the decisions we make will collect here.'}
            </p>
            <h4>What we know</h4>
            <ul>
              {synthesis?.confirmed.length ? (
                synthesis.confirmed
                  .slice(0, 4)
                  .map((item) => <li key={item.statement}>{item.statement}</li>)
              ) : (
                <li>{draft.originalGoal}</li>
              )}
            </ul>
            {!!synthesis?.unknowns.length && (
              <>
                <h4>Still exploring</h4>
                <ul>
                  {synthesis.unknowns.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            )}
            <div className={s.nextStep}>
              <strong>Next step</strong>
              <p>
                {stage === 'generating'
                  ? 'Helix is considering your idea.'
                  : synthesis?.unknowns.length
                    ? 'Keep talking. We’ll review the concept when the important choices are clear.'
                    : synthesis
                      ? 'Review the full concept below, refine it, then approve when it feels right.'
                      : 'Explore the first useful direction together.'}
              </p>
            </div>
          </div>
          {destination}
          <details
            className={s.conceptDetails}
            open={
              stage === 'launching' ||
              approvalUnknown ||
              (!!synthesis && !synthesis.unknowns.length && stage === 'review')
            }
          >
            <summary>Review & edit full concept</summary>
            <LivingBrief
              draft={draft}
              stage={stage}
              answers={answers}
              brief={brief}
              onBrief={onBrief}
              briefEdited={briefEdited}
              dirty={holds.brief}
              approvalUnknown={approvalUnknown}
              locked={locked}
              busy={busy}
              demo={demo}
              blockers={blockers}
              actions={actions}
            />
          </details>
        </aside>
      </div>

      <div className={s.workspaceFooter}>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || stage === 'launching' || stage === 'generating'}
          onClick={actions.startOver}
        >
          Start a different build
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={actions.close}>
          Save and close
        </Button>
      </div>
    </div>
  );
}

function CurrentStep({
  draft,
  stage,
  answer,
  onAnswer,
  answerNote,
  dirty,
  locked,
  busy,
  demo,
  goalEmpty,
  answersIncomplete,
  actions,
}: {
  draft: IntakeDraft;
  stage: Exclude<IntakeStage, 'start'>;
  answer: string;
  onAnswer: (v: string) => void;
  answerNote?: string | undefined;
  /** Any unsaved edit that answering would either include or discard. */
  dirty: boolean;
  locked: boolean;
  busy: boolean;
  demo: boolean;
  goalEmpty: boolean;
  answersIncomplete: boolean;
  actions: WorkspaceActions;
}) {
  const cannotWrite = locked || demo || goalEmpty || answersIncomplete;
  if (stage === 'generating')
    return (
      <div className={s.step} role="status" aria-live="polite">
        <p className={s.stepLabel}>
          <LoaderCircle size={14} aria-hidden className={s.spin} /> Helix is thinking
        </p>
        <h3 className={s.question}>Finding the next useful direction…</h3>
        <p className={s.stepHint}>
          It will come back with the next useful question, if one matters, and an updated brief.
          This can take a minute. Stop it to edit your inputs.
        </p>
        <div className={s.inlineActions}>
          <Button disabled={busy} onClick={actions.cancel}>
            Stop writing
          </Button>
        </div>
      </div>
    );
  if (stage === 'launching')
    return (
      <div className={s.step} role="status">
        <p className={s.stepLabel}>
          <ShieldCheck size={14} aria-hidden /> Approved
        </p>
        <h3 className={s.question}>Your approved brief is starting a build</h3>
        <p className={s.stepHint}>
          The approved revision is frozen. If starting didn’t finish, retrying uses exactly the same
          approval and can’t create a second build.
        </p>
      </div>
    );
  if (stage === 'failed')
    return (
      <div className={s.step}>
        <p className={s.stepLabel}>
          <CircleX size={14} aria-hidden /> Couldn’t finish
        </p>
        <h3 className={s.question}>The brief writer didn’t return a usable answer</h3>
        {draft.error && (
          <p role="alert" className={s.error}>
            {draft.error}
          </p>
        )}
        <div className={s.inlineActions}>
          <Button variant="primary" disabled={cannotWrite} onClick={actions.generate}>
            Try again
          </Button>
          <Button disabled={locked || demo || goalEmpty} onClick={actions.useAsWritten}>
            Use my idea as the brief
          </Button>
        </div>
      </div>
    );
  if (stage === 'compose')
    return (
      <div className={s.step}>
        <p className={s.stepLabel}>
          <ListChecks size={14} aria-hidden /> Next
        </p>
        <h3 className={s.question}>
          {draft.answers.length
            ? 'Your answers are saved. Write the brief from them?'
            : 'How would you like to continue?'}
        </h3>
        <p className={s.stepHint}>
          Shaping asks one question at a time; using your words skips straight to review.
        </p>
        <div className={s.inlineActions}>
          <Button
            variant="primary"
            icon={<Sparkles size={14} aria-hidden />}
            disabled={cannotWrite}
            onClick={actions.generate}
          >
            {draft.answers.length ? 'Write the brief' : 'Help me shape it'}
          </Button>
          {draft.mode === 'direct' && (
            <Button disabled={locked || demo || goalEmpty} onClick={actions.useAsWritten}>
              Review as written
            </Button>
          )}
        </div>
      </div>
    );
  // review
  const synthesis = draft.synthesis;
  const question = synthesis?.question.trim();
  const fromUser = draft.versions.at(-1)?.source === 'user';
  return (
    <div className={s.step}>
      <p className={s.stepLabel}>
        <MessageSquare size={14} aria-hidden />
        Helix
      </p>
      {synthesis?.message && <p className={s.agentReflection}>{synthesis.message}</p>}
      <h3 className={s.question} id="current-question">
        {question ||
          (fromUser && !draft.answers.length
            ? 'Want questions and suggestions before you approve?'
            : 'Nothing essential is open. Add anything else, or review the brief.')}
      </h3>
      {!!synthesis?.choices.length && (
        <ul className={s.choices} aria-label="Recommended options">
          {synthesis.choices.map((choice) => (
            <li key={choice.label} className={s.choice}>
              <div>
                <strong>{choice.label}</strong>
                <p>{choice.tradeoff}</p>
              </div>
              <Button
                size="sm"
                disabled={locked || dirty || demo}
                aria-label={`Choose: ${choice.label}`}
                onClick={() =>
                  actions.respond(`${choice.label}: ${choice.tradeoff}`, 'recommendation-accepted')
                }
              >
                Choose
              </Button>
            </li>
          ))}
        </ul>
      )}
      <details className={s.setupDetails}>
        <summary>Share a reference or project context</summary>
        <p>
          Paste relevant text, describe a screenshot, or tell me what to take from a reference site
          in your reply. I can discuss what you share here; I haven’t opened links or inspected
          repository files. Image upload is available later in design review.
        </p>
      </details>
      <TextArea
        id="discovery-answer"
        label="Your reply"
        hint={answerNote ?? 'Kept as a draft until you send it, even if you close or switch.'}
        aria-describedby="current-question discovery-answer-msg"
        value={answer}
        rows={3}
        disabled={locked || demo}
        onChange={(e) => onAnswer(e.target.value)}
      />
      <div className={s.inlineActions}>
        <Button
          variant="primary"
          icon={<ArrowRight size={14} aria-hidden />}
          disabled={locked || demo || dirty || !answer.trim()}
          onClick={() => actions.respond(answer)}
        >
          Send reply
        </Button>
        {question && (
          <Button disabled={locked || demo || dirty} onClick={() => actions.respond(UNSURE)}>
            Recommend something
          </Button>
        )}
        {question && (
          <Button
            variant="ghost"
            disabled={locked || demo || dirty}
            onClick={() =>
              actions.respond(
                'Explore a few distinct product directions with me. Explain what makes each worthwhile and its tradeoffs; do not choose for me.',
              )
            }
          >
            Explore a few options
          </Button>
        )}
        {!question && fromUser && !draft.answers.length && (
          <Button
            icon={<Sparkles size={14} aria-hidden />}
            disabled={locked || demo || dirty}
            onClick={actions.generate}
          >
            Ask me questions
          </Button>
        )}
      </div>
    </div>
  );
}

function LivingBrief({
  draft,
  stage,
  answers,
  brief,
  onBrief,
  briefEdited,
  dirty,
  approvalUnknown,
  locked,
  busy,
  demo,
  blockers,
  actions,
}: {
  draft: IntakeDraft;
  stage: Exclude<IntakeStage, 'start'>;
  answers: IntakeDraft['answers'];
  brief: string;
  onBrief: (v: string) => void;
  briefEdited: boolean;
  dirty: boolean;
  approvalUnknown: boolean;
  locked: boolean;
  busy: boolean;
  demo: boolean;
  blockers: string[];
  actions: WorkspaceActions;
}) {
  const synthesis = draft.synthesis;
  const review = stage === 'review' || stage === 'launching';
  return (
    <div className={s.brief}>
      <header className={s.briefHeader}>
        <h3 className={s.briefTitle}>Living brief</h3>
        {synthesis && <span className={s.revision}>Revision {draft.revision}</span>}
      </header>
      {!synthesis ? (
        <p className={s.empty}>
          {stage === 'generating'
            ? 'The brief appears here once the writer finishes.'
            : 'No brief yet. It appears here once written, and stays editable.'}
        </p>
      ) : (
        <>
          {!!synthesis.unknowns.length && (
            <div className={s.unknowns}>
              <h4>Still to decide</h4>
              <ul>
                {synthesis.unknowns.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          {dirty ? (
            <p className={s.stale}>Your unsaved edits will set this brief aside once saved.</p>
          ) : (
            !review && (
              <p className={s.stale}>
                Last written revision, for reference. It can’t be approved until a new one is ready.
              </p>
            )
          )}
          <TextArea
            id="reviewed-brief"
            label="Brief (editable)"
            value={brief}
            rows={8}
            disabled={locked || dirty || stage !== 'review'}
            onChange={(e) => onBrief(e.target.value)}
          />
          {briefEdited && !brief.trim() && (
            <p className={s.stale} role="status">
              A brief can’t be empty. Write one, or discard edits to keep the saved revision.
            </p>
          )}
          {briefEdited && (
            <div className={s.inlineActions}>
              <Button
                size="sm"
                disabled={locked || !brief.trim() || dirty}
                onClick={actions.saveBrief}
              >
                Save brief revision
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={actions.discardBrief}>
                Discard edits
              </Button>
            </div>
          )}
          <div className={s.facts}>
            <h4>
              Confirmed by you <span className={s.count}>{synthesis.confirmed.length}</span>
            </h4>
            {synthesis.confirmed.length ? (
              <ul>
                {synthesis.confirmed.map((x) => (
                  <li key={x.statement}>
                    {x.statement}
                    <small>
                      {`From ${x.answerIds.map((id) => citationLabel(id, answers)).join('; ')}`}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={s.empty}>Nothing cited from your answers yet.</p>
            )}
          </div>
          <div className={s.facts} data-kind="assumption">
            <h4>
              Assumed — approve or correct{' '}
              <span className={s.count}>{synthesis.assumptions.length}</span>
            </h4>
            {synthesis.assumptions.length ? (
              <ul>
                {synthesis.assumptions.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            ) : (
              <p className={s.empty}>No assumptions recorded.</p>
            )}
          </div>
        </>
      )}
      {draft.versions.length > 0 && (
        <details className={s.versions}>
          <summary>Earlier revisions ({draft.versions.length})</summary>
          {draft.versions.map((v, i) => (
            <article key={i}>
              <h5>
                Revision {v.revision} · {v.source === 'agent' ? 'written by Codex' : 'your edit'}
              </h5>
              <pre>{v.text}</pre>
            </article>
          ))}
        </details>
      )}
      {review && (
        <div className={s.approve}>
          {approvalUnknown ? (
            <p className={s.stale} role="status">
              Helix couldn’t confirm whether your approval was recorded. Editing is paused. Retrying
              resends this exact approval and can’t start a second build.
            </p>
          ) : blockers.length > 0 && stage === 'review' ? (
            <ul className={s.blockers} aria-label="Before you can approve">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : (
            <p className={s.approveHint}>
              Approving freezes this exact revision and starts a Claude plan for your approval.
              Visual work still gets its own design review.
            </p>
          )}
          <div className={s.inlineActions}>
            <Button
              variant="go"
              icon={<ShieldCheck size={14} aria-hidden />}
              disabled={blockers.length > 0 || busy || demo}
              loading={busy}
              onClick={actions.approve}
            >
              {approvalUnknown
                ? 'Retry approval'
                : stage === 'launching'
                  ? 'Retry approved launch'
                  : 'Approve brief & create plan'}
            </Button>
            {approvalUnknown && (
              <Button variant="ghost" disabled={busy} onClick={actions.checkApproval}>
                Check again
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function DiscoveryDestination({
  draft,
  projects,
  disabled,
  onBind,
}: {
  draft: IntakeDraft;
  projects: readonly Project[];
  disabled: boolean;
  onBind: (id: Project['id']) => void;
}) {
  const [selected, setSelected] = useState('');
  if (!draft.synthesis || draft.synthesis.unknowns.length) return null;
  const bound = projects.find((p) => p.id === draft.destinationProjectId);
  return (
    <section className={s.conceptCard} aria-label="Plan destination">
      <h4>When you’re ready to plan</h4>
      <p className={s.conceptIntro}>
        {bound
          ? 'Destination: ' + bound.name
          : 'Your concept is saved. Choose an existing registered repository before approving a plan. Choosing a destination does not launch work or inspect files.'}
      </p>
      {projects.length ? (
        <>
          <label>
            Plan destination
            <select
              value={selected}
              disabled={disabled}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Choose an existing repository</option>
              {projects.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={disabled || !selected || selected === draft.destinationProjectId}
            onClick={() => {
              const chosen = projects.find((p) => p.id === selected);
              if (chosen) onBind(chosen.id);
            }}
          >
            Use this destination
          </Button>
        </>
      ) : (
        <p>
          No repository is registered yet. You can keep refining this concept; approval stays
          unavailable.
        </p>
      )}
    </section>
  );
}
