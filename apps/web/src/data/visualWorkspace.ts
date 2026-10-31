import type { VisualPalette } from '@helix/contracts';
/** Presentation boundary. The daemon adapter maps the shared design contract into this view. */
export interface VisualConceptView {
  id: string;
  title: string;
  imageUrl: string;
  alt: string;
  rationale: string;
  tradeoffs: readonly string[];
  motionNote?: string;
}

export interface VisualRoundView {
  palette?: VisualPalette;
  id: string;
  revision: number;
  status:
    | 'pending'
    | 'generating'
    | 'ready'
    | 'failed'
    | 'unavailable'
    | 'cancelled'
    | 'approved'
    | 'superseded';
  brief: string;
  concepts: readonly VisualConceptView[];
  recommendation?: { conceptId: string; rationale: string };
  error?: string;
  setupHint?: string;
}

export interface VisualWorkspaceView {
  id: string;
  revision: number;
  title: string;
  rounds: readonly VisualRoundView[];
  activeRoundId: string;
  affectedTasks: readonly string[];
  conversation: readonly {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    revision: number;
    references?: readonly { url: string; label?: string }[];
  }[];
  decisions: readonly {
    id: string;
    revision: number;
    text: string;
    rationale: string;
    palette?: VisualPalette;
  }[];
  checkpoint?: {
    id: string;
    revision: number;
    title: string;
    summary: string;
    recommendation: string;
    status: 'pending' | 'ready' | 'failed';
    previewUrl?: string;
    commit?: string;
    error?: string;
    reducedMotion?: boolean;
  };
}

export type VisualAction =
  'feedback' | 'regenerate' | 'approve' | 'cancel' | 'retry' | 'approve_checkpoint';
export interface VisualCommand {
  palette?: VisualPalette | null;
  workspaceId: string;
  revision: number;
  roundId: string;
  action: VisualAction;
  conceptIds: readonly string[];
  feedback: string;
  references: readonly string[];
  checkpointId?: string;
  requestId: string;
}

export interface VisualWorkspaceAdapter {
  /** Server validates revision and requestId atomically; a resolved promise means persisted. */
  send(command: VisualCommand): Promise<void>;
}

/** Do not let an unsafe user-supplied URL become an executable link or embedded document. */
export function visualUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value, 'http://helix.local');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.username || parsed.password) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function rasterUrl(value: string): string | undefined {
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
    ? value
    : visualUrl(value);
}

export function parseVisualReferences(text: string): string[] {
  const references = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (references.length > 8) throw new Error('Use up to eight reference links per message.');
  if (references.some((url) => !/^https?:\/\//i.test(url) || !visualUrl(url))) {
    throw new Error('Reference links must be complete http or https URLs.');
  }
  return [...new Set(references)];
}

/** One unresolved submission at a time. Retrying an uncertain response reuses its identity. */
export class VisualSubmissionRejected extends Error {}

export class VisualSubmission {
  private pending?: VisualCommand;
  private busy = false;

  constructor(private readonly makeId: () => string = () => crypto.randomUUID()) {}

  async send(
    draft: Omit<VisualCommand, 'requestId'>,
    adapter: VisualWorkspaceAdapter,
  ): Promise<boolean> {
    if (this.busy) return false;
    const previous = this.pending;
    if (previous) {
      if (
        JSON.stringify({ ...draft, requestId: previous.requestId }) !== JSON.stringify(previous)
      ) {
        throw new Error(
          'The previous request has an uncertain outcome. Retry it or refresh before sending a different decision.',
        );
      }
    }
    this.pending = previous ?? { ...draft, requestId: this.makeId() };
    this.busy = true;
    try {
      await adapter.send(this.pending);
      return true;
    } catch (failure) {
      if (failure instanceof VisualSubmissionRejected) this.pending = undefined;
      throw failure;
    } finally {
      this.busy = false;
      // Retain identity until a fresh server revision is observed, including after success.
    }
  }
}

export function canChooseRound(round: VisualRoundView): boolean {
  return (
    round.status === 'ready' &&
    round.concepts.length === 3 &&
    new Set(round.concepts.map((concept) => concept.id)).size === 3 &&
    round.concepts.every((concept) => !!rasterUrl(concept.imageUrl))
  );
}
