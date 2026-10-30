import type {
  HelixEvent,
  ProjectId,
  HarnessInfo,
  IntakeDraft,
  IntakeSynthesis,
} from '@helix/contracts';

/** Where the guided intake is, derived from the durable draft (never stored separately). */
export type IntakeStage = 'start' | 'compose' | 'generating' | 'failed' | 'review' | 'launching';

export function intakeStage(draft: IntakeDraft | null): IntakeStage {
  if (!draft || draft.status === 'launched') return 'start';
  if (draft.status === 'editing')
    // A draft created by `new` whose idea never saved is still an empty start, not a build.
    return !draft.originalGoal.trim() && !draft.answers.length && !draft.synthesis
      ? 'start'
      : 'compose';
  return draft.status;
}

const GREETING = /^(?:(?:hi|hello|hey|so|ok|okay|please)\b[\s,!.]*)+/i;
const FILLER =
  /^(?:(?:i|we)\s+(?:would\s+like|want|need|'d\s+like)\s+(?:to\s+|you\s+to\s+)?|(?:can|could|would)\s+you\s+(?:please\s+)?|help\s+me\s+|let'?s\s+|(?:i'm|we're|i\s+am|we\s+are)\s+(?:building|making|trying\s+to\s+build)\s+)?(?:(?:build|create|make|add|implement|design|write|set\s+up|shape|plan|draft)\s+(?:me\s+|us\s+)?)?/i;

/**
 * Honest local fallback name: the first line or sentence of the user's own words, trimmed of
 * conversational filler. No agent is involved; the user can rename it at review.
 */
export function provisionalTitle(idea: string, max = 60): string {
  const line =
    idea
      .split(/\r?\n/)
      .map((l) =>
        l
          .replace(/^\s*(?:[#>*\-–•]+|\d+[.)])\s*/, '')
          .replace(GREETING, '')
          .trim(),
      )
      .find(Boolean) ?? '';
  const sentence = (line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line).replace(/[.!?:;,\s]+$/, '');
  let text = sentence.replace(FILLER, '').replace(/\s+/g, ' ').trim() || sentence.trim();
  text = text.replace(/^(?:a|an|the)\s+(?=\S{3})/i, '');
  if (text.length > max) {
    const cut = text.slice(0, max + 1);
    const space = cut.lastIndexOf(' ');
    const head = space > max * 0.5 ? cut.slice(0, space) : cut.slice(0, max);
    text = `${head.replace(/[\s,;:–-]+$/, '')}…`;
  }
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Untitled build';
}

export interface ApprovalInputs {
  draft: IntakeDraft | null;
  /** Local answer/idea/name edits that are not yet saved. */
  dirty: boolean;
  /** Local brief prose that differs from the saved revision. */
  briefEdited: boolean;
  title: string;
  goal: string;
}

/** Plain-language reasons the reviewed brief cannot be approved yet. Empty means ready. */
export function approvalBlockers({ draft, dirty, briefEdited, title, goal }: ApprovalInputs) {
  const reasons: string[] = [];
  if (!draft?.synthesis || !['review', 'launching'].includes(draft.status)) {
    reasons.push('A reviewed brief is not ready yet.');
    return reasons;
  }
  const open = draft.synthesis.unknowns.length;
  if (open === 1) reasons.push('1 decision still needs your answer.');
  if (open > 1) reasons.push(`${open} decisions still need your answer.`);
  if (dirty) reasons.push('Save or discard your edits first; they change the brief’s basis.');
  if (briefEdited) reasons.push('Save your brief edits as a new revision first.');
  if (!title.trim()) reasons.push('Give the build a name.');
  if (!goal.trim()) reasons.push('Describe what you want to build.');
  return reasons;
}

export type WriterReadiness = 'ready' | 'signin' | 'missing' | 'unknown';

/** Guided shaping runs on the local Codex CLI; report only what detection actually says. */
export function writerReadiness(harnesses: readonly HarnessInfo[] | undefined): WriterReadiness {
  const codex = harnesses?.find((h) => h.agent === 'codex');
  if (!codex) return 'unknown';
  if (!codex.installed) return 'missing';
  if (codex.signedIn === false) return 'signin';
  return codex.signedIn === true ? 'ready' : 'unknown';
}

/**
 * Renaming is an input edit, which the daemon treats as invalidating the brief. A brief the user
 * wrote themselves, with nothing inferred, can be re-saved verbatim without losing any decision.
 */
export function briefSurvivesRename(synthesis: IntakeSynthesis | null | undefined): boolean {
  return (
    !!synthesis &&
    !synthesis.unknowns.length &&
    !synthesis.assumptions.length &&
    !synthesis.confirmed.length
  );
}

/** Clear a composer after its text was accepted, unless the user has since typed something else. */
export function clearIfUnchanged(current: string, submitted: string): string {
  return current.trim() === submitted.trim() ? '' : current;
}

/** Typed but unsent answer, kept per draft so a close or repository switch can't drop it. */
export interface PendingAnswer {
  /** The question showing when it was last edited. */
  question: string;
  text: string;
}

/** Explain an unsent answer typed for a question that has since changed; never re-target it. */
export function pendingAnswerNote(
  pending: PendingAnswer | undefined,
  currentQuestion: string,
): string | undefined {
  if (!pending?.text.trim() || pending.question.trim() === currentQuestion.trim()) return undefined;
  return pending.question.trim()
    ? `You started this for an earlier question: “${pending.question.trim()}”`
    : 'You started this before the current question was asked.';
}

/**
 * Input edits (idea, name, answers) set the brief aside; brief prose is a separate revision. Only
 * one kind of unsaved change may exist at a time so neither silently discards the other.
 */
export function editLocks({ dirty, briefEdited }: { dirty: boolean; briefEdited: boolean }) {
  return { inputs: briefEdited, brief: dirty };
}

/**
 * Why unsaved brief prose can't be persisted on close or a repository switch, if it can't.
 * Closing must never skip it silently: reopening would restore the old brief without warning.
 */
export function unsavedBriefProblem({
  briefEdited,
  brief,
  status,
}: {
  briefEdited: boolean;
  brief: string;
  status: IntakeDraft['status'];
}): string | undefined {
  if (!briefEdited) return undefined;
  if (!brief.trim())
    return 'The brief can’t be empty. Write the brief, or choose Discard edits to keep the saved revision.';
  if (status !== 'review')
    return 'Your brief edits can’t be saved until the brief is back in review. Copy them or choose Discard edits.';
  return undefined;
}

export type ReconcileAction = 'same' | 'adopt' | 'keepLocal';

/**
 * After a failed or uncertain request, decide how to apply the saved draft. Launch states always
 * win: their inputs are frozen, so local edits can't apply and must be reported, not kept.
 */
export function reconcileDraft(
  local: IntakeDraft | null,
  server: IntakeDraft | null,
  hasLocalEdits: boolean,
): { action: ReconcileAction; discardsLocal: boolean } {
  if (JSON.stringify(local) === JSON.stringify(server))
    return { action: 'same', discardsLocal: false };
  const frozen = server?.status === 'launching' || server?.status === 'launched';
  const otherDraft = !server || server.id !== local?.id;
  if (!hasLocalEdits) return { action: 'adopt', discardsLocal: false };
  if (frozen || otherDraft) return { action: 'adopt', discardsLocal: true };
  return { action: 'keepLocal', discardsLocal: false };
}

export function citationLabel(id: string, answers: IntakeDraft['answers']): string {
  if (id === 'original-goal') return 'Your original idea';
  const index = answers.findIndex((a) => a.id === id);
  return index < 0 ? 'An earlier answer' : `Answer ${index + 1}: ${answers[index]!.question}`;
}

export const EXAMPLE_IDEAS: readonly { label: string; text: string }[] = [
  {
    label: 'Password reset',
    text: 'Let people reset a forgotten password from sign-in with an emailed link that expires.',
  },
  {
    label: 'Usage dashboard',
    text: 'A dashboard showing weekly active users and signups by channel, with a date filter.',
  },
  {
    label: 'Dark mode',
    text: 'Add a dark theme with a toggle in settings that remembers each person’s choice.',
  },
];

/** A created build is opened only after the selected destination has delivered its own session. */
export interface PendingIntakeLaunch {
  id: string;
  projectId: ProjectId;
}
export function readyIntakeSession(
  pending: PendingIntakeLaunch | null,
  selectedProject: string | undefined,
  events: readonly HelixEvent[],
): string | undefined {
  if (!pending || pending.projectId !== selectedProject) return undefined;
  return events.some(
    (event) =>
      event.type === 'session.created' &&
      event.payload.session.id === pending.id &&
      event.payload.session.projectId === pending.projectId,
  )
    ? pending.id
    : undefined;
}

export function intakeScopeSwitchHeld(input: {
  busy: boolean;
  loaded: boolean;
  approvalUnknown: boolean;
  status: IntakeDraft['status'] | undefined;
}): boolean {
  return (
    input.busy ||
    !input.loaded ||
    input.approvalUnknown ||
    input.status === 'generating' ||
    input.status === 'launching'
  );
}
