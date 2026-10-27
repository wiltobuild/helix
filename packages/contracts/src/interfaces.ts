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
  RecordingImportResponse,
  RecordingListEntry,
  RecordingListResponse,
  SendMessageRequest,
  StopAllResponse,
  SubmitPlanRequest,
  TerminalOutput,
} from './api.js';
import type {
  Approval,
  ApprovalDecision,
  Plan,
  Project,
  PullRequestFacts,
  Session,
} from './entities.js';
import type { HelixEvent, PayloadFor, UnsequencedEvent } from './events.js';
import type { ApprovalId, ProjectId, PullRequestNumber, SessionId } from './ids.js';import type { Worktree } from './projection.js';

export type Unsubscribe = () => void;
export type HarnessEmissionType =
  'chat.item' | 'activity.changed' | 'reasoning.summary' | 'approval.requested';
export type HarnessEmission = {
  [K in HarnessEmissionType]: { type: K; payload: PayloadFor<K> };
}[HarnessEmissionType];
export type HarnessStartOptions = { session: Session; cwd: string; resumeToken?: string };
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
  /** Lists all imported recordings available for replay. */
  listRecordings(): Promise<RecordingListEntry[]>;
  /** Returns the stored recording text by id, or undefined if not found. */
  getRecording(id: string): Promise<string | undefined>;
}

/** Typed key-value store for durable per-project/session metadata (Wave 2 seam).
 * Keys are arbitrary strings (e.g. 'resume-token:<sessionId>').
 * Values are JSON-serialisable; overwrite on set; missing keys return undefined.
 */
export interface MetaStore {
  getMeta(scope: string, key: string): Promise<unknown>;
  setMeta(scope: string, key: string, value: unknown): Promise<void>;
  deleteMeta(scope: string, key: string): Promise<void>;
}

export interface HelixStore extends EventStore, ProjectIndex, IdempotencyStore, RecordingStore, MetaStore {
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
  reason: 'ci_failed' | 'changes_requested' | 'merge_conflict';
  pr: PullRequestFacts;
  details?: string;
}) => string;

/** The domain API the daemon exposes. Implemented by @helix/core; every method maps 1:1 to a route. */
export interface HelixCore {
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
  /** Stop all running sessions for a project immediately (guardrail / emergency stop). */
  stopAll(projectId: ProjectId): Promise<StopAllResponse>;
  archiveSession(sessionId: SessionId): Promise<Session>;
  decideApproval(approvalId: ApprovalId, request: ApprovalDecisionRequest): Promise<Approval>;
  diff(sessionId: SessionId, scope: DiffScope): Promise<DiffResponse>;
  merge(sessionId: SessionId): Promise<MergeResponse>;
  submitPlan(request: SubmitPlanRequest): Promise<Plan>;
  /** Approve or reject a submitted plan. Workers only spawn after an 'approved' decision. */
  decidePlan(request: PlanDecisionRequest): Promise<Plan>;
  explain(request: ExplainRequest): Promise<HelixEvent<'explain.note'>>;
  exportRecording(projectId: ProjectId): Promise<string>;
  importRecording(text: string): Promise<RecordingImportResponse>;
  listRecordings(): Promise<RecordingListResponse>;
}
