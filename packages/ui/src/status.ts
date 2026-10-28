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

import type { AgentKind, BoardColumn, DisplayStatus } from '@helix/contracts';

export type { AgentKind, BoardColumn, DisplayStatus };

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

export interface AgentMeta {
  label: string;
  short: string;
  colorVar: string;
}

const knownAgents: Record<string, AgentMeta> = {
  'claude-code': { label: 'Claude Code', short: 'claude', colorVar: 'var(--strand-claude)' },
  claude: { label: 'Claude Code', short: 'claude', colorVar: 'var(--strand-claude)' },
  codex: { label: 'Codex', short: 'codex', colorVar: 'var(--strand-codex)' },
};

/** Display info for an agent. Unknown agents (the contract allows any harness name) get a neutral look. */
export function agentMeta(agent: AgentKind): AgentMeta {
  return knownAgents[agent] ?? { label: agent, short: agent, colorVar: 'var(--text-3)' };
}
