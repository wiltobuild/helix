import type { DiffResponse, DiffScope, HarnessInfo, MessageMode } from './api.js';
import type { AgentKind, Project, PullRequestFacts, Session } from './entities.js';
import type { HelixEvent, PayloadFor, UnsequencedEvent } from './events.js';
import type { ProjectId, PullRequestNumber, SessionId } from './ids.js';
import type { Worktree } from './projection.js';

export type Unsubscribe = () => void;
export type HarnessEmissionType = 'chat.item' | 'activity.changed' | 'reasoning.summary' | 'approval.requested';
export type HarnessEmission = { [K in HarnessEmissionType]: { type: K; payload: PayloadFor<K> } }[HarnessEmissionType];
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
export type OpenPrOptions = { project: Project; sessionId: SessionId; head: string; base: string; title: string; body: string; draft: boolean };
export type MergePrOptions = { project: Project; prNumber: PullRequestNumber; expectedHeadSha: string; method: 'merge' | 'squash' | 'rebase' };
export type ScmEmissionType = 'pr.updated' | 'ci.updated' | 'review.updated' | 'pr.merged';
export type ScmEmission = { [K in ScmEmissionType]: { type: K; payload: PayloadFor<K> } }[ScmEmissionType];
export interface ScmObserver {
  /** Optional callback makes observed facts available without coupling to EventStore. */
  watch(project: Project, prNumber: PullRequestNumber, onEvent?: (e: ScmEmission) => void): Unsubscribe;
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
