import type {
  ApprovalDecisionRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  DiffResponse,
  DiffScope,
  EventsResponse,
  ExplainRequest,
  HarnessInfo,
  HealthResponse,
  MergeResponse,
  MessageMode,
  PlanDecisionRequest,
  PlanDecisionResponse,
  RecordingImportResponse,
  SendMessageRequest,
  SubmitPlanRequest,
  SubmitReviewRequest,
  TerminalOutput,
} from './api.js';
import type {
  AgentKind,
  Approval,
  ApprovalDecision,
  MetaValue,
  Plan,
  Project,
  PullRequestFacts,
  Session,
} from './entities.js';
import type { HelixEvent, PayloadFor, UnsequencedEvent } from './events.js';
import type { ApprovalId, PlanId, ProjectId, PullRequestNumber, SessionId } from './ids.js';
import type { Worktree } from './projection.js';

export type Unsubscribe = () => void;
export type HarnessEmissionType =
  'chat.item' | 'activity.changed' | 'reasoning.summary' | 'approval.requested';
export type HarnessEmission = {
  [K in HarnessEmissionType]: { type: K; payload: PayloadFor<K> };
}[HarnessEmissionType];
/** Scratch discovery metadata is deliberately not a build Session and has no project. */
export type DiscoveryHarnessContext = Pick<Session, 'id' | 'title' | 'createdAt' | 'model'> & {
  agent: 'codex';
  interface: 'chat';
  prompt?: never;
  projectId?: never;
  role?: never;
};
export type HarnessStartOptions = (
  | { purpose?: 'build'; session: Session }
  | {
      purpose: 'discovery';
      session: DiscoveryHarnessContext;
      env?: never;
      review?: never;
      resumeToken?: never;
    }
) & {
  cwd: string;
  resumeToken?: string;
  /** Per-session additions merged over the adapter's base environment. */
  env?: Record<string, string>;
  /**
   * Reviewer sessions only. `cwd` is then a scratch directory the reviewer may write (its verdict
   * file); `worktreePath` is the worker's checkout under review, readable but never writable.
   * Adapters decline file writes outside `cwd` and treat `worktreePath` as an extra read root.
   */
  review?: { worktreePath: string };
};
export interface AgentHarness {
  readonly kind: AgentKind;
  detect(): Promise<HarnessInfo>;
  start(opts: HarnessStartOptions): Promise<HarnessSession>;
}
export interface HarnessSession {
  send(text: string, mode: MessageMode): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  onEvent(cb: (e: HarnessEmission) => void): Unsubscribe;
  readonly resumeToken?: string;
}
export interface WorktreeManager {
  create(projectId: ProjectId, sessionId: SessionId, base: string): Promise<Worktree>;
  diff(path: string, scope: DiffScope): Promise<DiffResponse>;
  status(path: string): Promise<{ dirty: boolean }>;
  /** Must reject dirty worktrees (tracked, untracked or staged). Never force deletion. */
  remove(path: string, options: { force: false }): Promise<void>;
}
export type OpenPrOptions = {
  project: Project;
  sessionId: SessionId;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
};
export type MergePrOptions = {
  project: Project;
  prNumber: PullRequestNumber;
  expectedHeadSha: string;
  method: 'merge' | 'squash' | 'rebase';
};
export type ScmEmissionType = 'pr.updated' | 'ci.updated' | 'review.updated' | 'pr.merged';
export type ScmEmission = {
  [K in ScmEmissionType]: { type: K; payload: PayloadFor<K> };
}[ScmEmissionType];
export interface ScmObserver {
  /** Refresh an already watched PR now and publish its snapshot through watch, even if unchanged.
   * Resolves after publication; concurrent calls may coalesce. Unwatched PRs are a no-op.
   */
  refresh?(project: Project, prNumber: PullRequestNumber): Promise<void>;
  /** Optional callback makes observed facts available without coupling to EventStore. */
  watch(
    project: Project,
    prNumber: PullRequestNumber,
    onEvent?: (e: ScmEmission) => void,
  ): Unsubscribe;
  openPr(options: OpenPrOptions): Promise<PullRequestFacts>;
  merge(options: MergePrOptions): Promise<{ mergeSha: string }>;
}
export interface EventStore {
  /** Atomic append; assigns strictly increasing daemon-global seqs starting at 1. */
  append(events: UnsequencedEvent[]): Promise<HelixEvent[]>;
  /** Ascending, exclusive cursor; gaps are normal because seq is daemon-global. */
  read(projectId: ProjectId, sinceSeq: number, limit: number): Promise<HelixEvent[]>;
  /** Catch up after sinceSeq, then deliver live events without gaps or duplicates. */
  subscribe(sinceSeq: number, cb: (e: HelixEvent) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Wave 1 seams (added by Claude). These let storage, git, pty-host, harness, scm,
// core and daemon be built in parallel against shared shapes.
// ---------------------------------------------------------------------------

export interface WorktreeCreateOptions {
  /** Human-readable slug for the branch name (helix/<slug>); the manager ensures uniqueness. */
  slug?: string;
}
/** Extra git operations the core needs beyond WorktreeManager. Implemented by @helix/git. */
export interface GitHelpers {
  isGitRepo(path: string): Promise<boolean>;
  defaultBranch(repoPath: string): Promise<string>;
  /** `origin` remote URL, or undefined when there is none. */
  remoteUrl(repoPath: string, remote?: string): Promise<string | undefined>;
  headSha(path: string): Promise<string>;
  /** Number of commits on HEAD that are not on the given base ref. */
  commitsAhead(path: string, base: string): Promise<number>;
  /** Records refs/helix/<sessionId>/last-turn at HEAD + working tree for `last_turn` diffs. */
  markTurn(path: string, sessionId: SessionId): Promise<void>;
  commitAll(path: string, message: string): Promise<string | undefined>;
  push(path: string, branch: string): Promise<void>;
  /** Fetches origin/<branch> (no prompts) and returns its SHA without touching the user's local
   * branch or working tree. Without an origin remote, returns the local branch SHA. */
  fetchBase(repoPath: string, branch: string): Promise<string>;
}
export interface GitService extends WorktreeManager, GitHelpers {
  create(
    projectId: ProjectId,
    sessionId: SessionId,
    base: string,
    options?: WorktreeCreateOptions,
  ): Promise<Worktree>;
}

/** Project lookup index kept alongside the event log. Implemented by @helix/storage. */
export interface ProjectIndex {
  saveProject(project: Project): Promise<void>;
  getProject(id: ProjectId): Promise<Project | undefined>;
  listProjects(): Promise<Project[]>;
  findProjectByRepoPath(repoPath: string): Promise<Project | undefined>;
}
/** Idempotent command results. Same key + different request hash → IDEMPOTENCY_CONFLICT. */
export interface IdempotencyStore {
  /** Resolves undefined when the key is unknown. */
  recall(scope: string, key: string, requestHash: string): Promise<unknown>;
  remember(scope: string, key: string, requestHash: string, response: unknown): Promise<void>;
}
export interface RecordingStore {
  exportProject(projectId: ProjectId): Promise<string>;
  importRecording(text: string): Promise<RecordingImportResponse>;
}
/** Mutable durable metadata, separate from immutable command responses and replay logs.
 * Keys are scoped; writes atomically replace a JSON value. Missing keys resolve undefined;
 * null is a stored value. Reads/writes must not alias caller-owned objects. No event is emitted.
 * Resume tokens are private metadata and must never appear in recording exports.
 */
export interface MetaStore {
  getMeta(scope: string, key: string): Promise<MetaValue | undefined>;
  setMeta(scope: string, key: string, value: MetaValue): Promise<void>;
}
export interface HelixStore
  extends EventStore, ProjectIndex, IdempotencyStore, RecordingStore, MetaStore {
  close(): Promise<void>;
}

/** Terminal sessions (agent TUIs and worktree shells). Implemented by @helix/pty-host. */
export interface TerminalSpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}
export interface TerminalAttachment {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}
export interface TerminalHost {
  spawn(sessionId: SessionId, options: TerminalSpawnOptions): Promise<void>;
  /** Replays scrollback first, then streams live output. */
  attach(sessionId: SessionId, onOutput: (m: TerminalOutput) => void): Promise<TerminalAttachment>;
  kill(sessionId: SessionId): Promise<void>;
  onExit(cb: (sessionId: SessionId, code: number | null) => void): Unsubscribe;
  list(): SessionId[];
}

/** Optional approval resolution for harnesses that surface permission prompts. */
export interface ApprovingHarnessSession extends HarnessSession {
  decide(approvalId: ApprovalId, decision: ApprovalDecision): Promise<void>;
}

/** Builds the concise message routed back to a worker after CI/review/conflict feedback. */
export type FeedbackMessageBuilder = (input: {
  reason: 'ci_failed' | 'changes_requested' | 'merge_conflict' | 'review_findings';
  pr: PullRequestFacts;
  details?: string;
}) => string;

/** The domain API the daemon exposes. Implemented by @helix/core; every method maps 1:1 to a route. */
export interface HelixCore {
  discoveryIntake?(): Promise<{ draft: import('./intake.js').IntakeDraft | null }>;
  changeDiscovery?(
    request: import('./intake.js').IntakeRequest,
  ): Promise<{ draft: import('./intake.js').IntakeDraft | null }>;
  changeOutput?(
    id: SessionId,
    request: import('./output.js').OutputRequest,
  ): Promise<{ output: import('./output.js').Output | null }>;
  outputLease?(id: SessionId): Promise<{ lease: import('./output.js').OutputLease | null }>;
  projectIntake?(id: ProjectId): Promise<{ draft: import('./intake.js').IntakeDraft | null }>;
  changeIntake?(
    id: ProjectId,
    request: import('./intake.js').IntakeRequest,
  ): Promise<{ draft: import('./intake.js').IntakeDraft | null }>;
  sessionDesign?(
    id: SessionId,
  ): Promise<{ design: import('./visual-design.js').VisualDesign | null }>;
  changeDesign?(
    id: SessionId,
    request: import('./visual-design.js').VisualDesignRequest,
  ): Promise<{ design: import('./visual-design.js').VisualDesign | null }>;
  readonly events: EventStore;
  readonly terminals: TerminalHost;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  health(): Promise<HealthResponse>;
  harnesses(): Promise<HarnessInfo[]>;
  listProjects(): Promise<Project[]>;
  addProject(request: CreateProjectRequest): Promise<Project>;
  projectEvents(projectId: ProjectId, since: number, limit: number): Promise<EventsResponse>;
  createSession(
    projectId: ProjectId,
    request: CreateSessionRequest,
    idempotencyKey: string,
  ): Promise<Session>;
  sendMessage(sessionId: SessionId, request: SendMessageRequest): Promise<void>;
  stopSession(sessionId: SessionId): Promise<void>;
  stopAll(projectId: ProjectId): Promise<{ stopped: SessionId[] }>;
  archiveSession(sessionId: SessionId): Promise<Session>;
  decideApproval(approvalId: ApprovalId, request: ApprovalDecisionRequest): Promise<Approval>;
  diff(sessionId: SessionId, scope: DiffScope): Promise<DiffResponse>;
  merge(sessionId: SessionId): Promise<MergeResponse>;
  submitPlan(request: SubmitPlanRequest): Promise<Plan>;
  /** Records a human decision. Repeated matching decisions are idempotent; reversal conflicts.
   * A rejection without a reason records "Rejected by human". Scheduling enforcement is core's job.
   */
  decidePlan(planId: PlanId, request: PlanDecisionRequest): Promise<PlanDecisionResponse>;
  /** An agent's or orchestrator's note; the source comes from the calling session's role. */
  explain(request: ExplainRequest): Promise<HelixEvent<'explain.note'>>;
  /** A reviewer session's verdict for the PR head it was asked to review (`helix review submit`). */
  submitReview(request: SubmitReviewRequest): Promise<HelixEvent<'agent_review.submitted'>>;
  /** Helix's own note about a session (source "helix"), e.g. from a harness adapter.
   * Composition-only: deliberately not an HTTP route, so agents cannot claim Helix's voice. */
  recordNote(sessionId: SessionId, text: string): Promise<HelixEvent<'explain.note'>>;
  exportRecording(projectId: ProjectId): Promise<string>;
  importRecording(text: string): Promise<RecordingImportResponse>;
}
