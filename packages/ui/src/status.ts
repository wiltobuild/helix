import {
  Archive,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleStop,
  CircleX,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  MessageSquareWarning,
  type LucideIcon,
} from 'lucide-react';

// Mirrors DisplayStatus / BoardColumn in @helix/contracts (W0-contracts). Switch to `import type` once merged.
export type DisplayStatus =
  | 'pending'
  | 'working'
  | 'needs_you'
  | 'ci_failed'
  | 'changes_requested'
  | 'in_review'
  | 'ready_to_merge'
  | 'merged'
  | 'exited'
  | 'archived';

export type BoardColumn =
  'pending' | 'working' | 'needs_you' | 'in_review' | 'ready_to_merge' | 'archive';

export type AgentKind = 'claude-code' | 'codex';

type Tone = 'pending' | 'working' | 'needs' | 'failed' | 'review' | 'ready' | 'merged';

export interface StatusMeta {
  label: string;
  icon: LucideIcon;
  tone: Tone;
  /** Animate the icon (spinner) while the agent is doing something. */
  live?: boolean;
}

export const statusMeta: Record<DisplayStatus, StatusMeta> = {
  pending: { label: 'Pending', icon: CircleDashed, tone: 'pending' },
  working: { label: 'Working', icon: LoaderCircle, tone: 'working', live: true },
  needs_you: { label: 'Needs you', icon: CircleAlert, tone: 'needs' },
  ci_failed: { label: 'CI failed', icon: CircleX, tone: 'failed' },
  changes_requested: { label: 'Changes requested', icon: MessageSquareWarning, tone: 'failed' },
  in_review: { label: 'In review', icon: GitPullRequest, tone: 'review' },
  ready_to_merge: { label: 'Ready to merge', icon: CircleCheck, tone: 'ready' },
  merged: { label: 'Merged', icon: GitMerge, tone: 'merged' },
  exited: { label: 'Exited', icon: CircleStop, tone: 'pending' },
  archived: { label: 'Archived', icon: Archive, tone: 'pending' },
};

export const columnMeta: Record<BoardColumn, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'pending' },
  working: { label: 'Working', tone: 'working' },
  needs_you: { label: 'Needs you', tone: 'needs' },
  in_review: { label: 'In review', tone: 'review' },
  ready_to_merge: { label: 'Ready to merge', tone: 'ready' },
  archive: { label: 'Archive', tone: 'pending' },
};

export const toneVar = (tone: Tone) => `var(--status-${tone})`;
export const toneSoftVar = (tone: Tone) => `var(--status-${tone}-soft)`;

export const agentMeta: Record<AgentKind, { label: string; short: string; colorVar: string }> = {
  'claude-code': { label: 'Claude Code', short: 'claude', colorVar: 'var(--strand-claude)' },
  codex: { label: 'Codex', short: 'codex', colorVar: 'var(--strand-codex)' },
};
