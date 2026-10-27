import {
  boardColumn,
  deriveStatus,
  type BoardColumn,
  type DisplayStatus,
  type HelixEvent,
  type ProjectState,
  type SessionState,
} from '@helix/contracts';
import type { SessionCardProps } from '@helix/ui';

/** Event categories drive timeline tick colors and icons. */
export type EventTone =
  'plan' | 'work' | 'needs' | 'failed' | 'feedback' | 'review' | 'done' | 'quiet';

export function eventTone(e: HelixEvent): EventTone {
  switch (e.type) {
    case 'plan.submitted':
    case 'plan.approved':
    case 'plan.rejected':
    case 'plan.node_updated':
    case 'explain.note':
      return 'plan';
    case 'approval.requested':
      return 'needs';
    case 'ci.updated':
      return e.payload.checks.failed > 0
        ? 'failed'
        : e.payload.checks.pending > 0
          ? 'quiet'
          : 'done';
    case 'feedback.routed':
      return 'feedback';
    case 'review.updated':
      return e.payload.review.decision === 'changes_requested' ? 'failed' : 'review';
    case 'pr.opened':
      return 'review';
    case 'pr.merged':
      return 'done';
    case 'session.started':
    case 'worktree.created':
      return 'work';
    case 'activity.changed':
      return e.payload.activity === 'waiting_input' || e.payload.activity === 'blocked'
        ? 'needs'
        : 'quiet';
    default:
      return 'quiet';
  }
}

/**
 * Where a Why entry comes from. Never present an agent's claim as something Helix observed:
 * - plan:   the orchestrator's stated rationale (the plan and its notes)
 * - helix:  facts Helix recorded when it acted (CI, routing, PRs, commits, decisions)
 * - agent:  the agent's own description of what it did or thought (unverified)
 */
export type Provenance = 'plan' | 'helix' | 'agent';

export const provenanceLabel: Record<Provenance, string> = {
  plan: 'Stated in the plan',
  helix: 'Recorded by Helix',
  agent: "Agent's own summary",
};

export function provenance(e: HelixEvent, state: ProjectState): Provenance {
  switch (e.type) {
    case 'plan.submitted':
    case 'plan.node_updated':
      return 'plan';
    case 'reasoning.summary':
      return 'agent';
    case 'chat.item': {
      const item = e.payload.item;
      return item.kind === 'reasoning_summary' ||
        item.kind === 'question' ||
        (item.kind === 'message' && item.role === 'assistant')
        ? 'agent'
        : 'helix';
    }
    case 'explain.note':
      switch (e.payload.source) {
        case 'helix':
          return 'helix';
        case 'orchestrator':
          return 'plan';
        case 'agent':
          return 'agent';
        default:
          // Legacy notes recorded before notes carried a source (#17).
          return e.sessionId && state.sessions[e.sessionId]?.session.role === 'orchestrator'
            ? 'plan'
            : 'helix';
      }
    default:
      return 'helix';
  }
}

const sessionTitle = (state: ProjectState, id: string | undefined) =>
  (id && state.sessions[id as keyof typeof state.sessions]?.session.title) ?? 'a session';

const agentName = (agent: string) =>
  agent === 'claude-code' ? 'Claude Code' : agent === 'codex' ? 'Codex' : agent;

/** One plain-language sentence for an event, written from the user's side of the screen. */
export function describeEvent(e: HelixEvent, state: ProjectState): string {
  const s = e.sessionId ? state.sessions[e.sessionId] : undefined;
  const who = !s
    ? 'Helix'
    : s.session.role === 'orchestrator'
      ? 'Orchestrator'
      : agentName(s.session.agent);
  switch (e.type) {
    case 'project.added':
      return `Added project ${e.payload.project.name}.`;
    case 'session.created':
      return e.payload.session.role === 'orchestrator'
        ? `Started the orchestrator for “${e.payload.session.title}”.`
        : `Created a task for ${agentName(e.payload.session.agent)}: ${e.payload.session.title}.`;
    case 'session.started':
      return `${who} started working.`;
    case 'session.exited':
      return `${who} stopped${e.payload.code ? ` (exit code ${e.payload.code})` : ''}.`;
    case 'session.archived':
      return `Archived “${sessionTitle(state, e.sessionId)}”.`;
    case 'activity.changed': {
      const map: Record<string, string> = {
        starting: 'is starting up',
        active: 'is working',
        idle: 'finished its turn',
        waiting_input: 'is waiting for you',
        blocked: 'is blocked on an approval',
        exited: 'exited',
        unknown: 'stopped reporting status',
      };
      return `${who} ${map[e.payload.activity] ?? e.payload.activity}.`;
    }
    case 'chat.item': {
      const item = e.payload.item;
      if (item.kind === 'tool_call') return `${who} ran ${item.inputSummary}.`;
      if (item.kind === 'message') return `${who}: ${truncate(item.text, 110)}`;
      if (item.kind === 'question') return `${who} asked: ${truncate(item.prompt, 100)}`;
      return `${who} updated the conversation.`;
    }
    case 'reasoning.summary':
      return `${e.payload.source === 'orchestrator' ? 'Orchestrator' : who} reasoned: ${truncate(e.payload.text, 110)}`;
    case 'approval.requested':
      return `${who} asked to ${lowerFirst(e.payload.approval.summary)}.`;
    case 'approval.decided':
      return `You ${e.payload.decision === 'approved' ? 'approved' : e.payload.decision === 'rejected' ? 'rejected' : 'requested changes to'} the request.`;
    case 'plan.submitted':
      return `Orchestrator split “${e.payload.plan.goal}” into ${e.payload.plan.nodes.length} tasks.`;
    case 'plan.approved':
      return 'You approved the plan.';
    case 'plan.rejected':
      return `You rejected the plan: ${e.payload.reason}`;
    case 'plan.node_updated':
      return e.payload.note ?? 'Orchestrator updated the plan.';
    case 'explain.note':
      return e.payload.text;
    case 'worktree.created':
      return `${who} got its own branch, ${e.payload.branch}.`;
    case 'worktree.diff_updated':
      return `${who} changed ${e.payload.filesChanged} ${e.payload.filesChanged === 1 ? 'file' : 'files'} (+${e.payload.insertions} −${e.payload.deletions}).`;
    case 'pr.opened':
      return `${who} opened PR #${e.payload.pr.number}.`;
    case 'pr.updated':
      return `PR #${e.payload.pr.number} was updated.`;
    case 'ci.updated': {
      const c = e.payload.checks;
      if (c.failed > 0)
        return `CI failed on PR #${e.payload.prNumber}: ${c.failingNames.join(', ')}.`;
      if (c.pending > 0)
        return `CI is running on PR #${e.payload.prNumber} (${c.passed}/${c.total}).`;
      return `CI passed on PR #${e.payload.prNumber} (${c.passed}/${c.total}).`;
    }
    case 'review.updated':
      return e.payload.review.decision === 'approved'
        ? `PR #${e.payload.prNumber} was approved.`
        : e.payload.review.decision === 'changes_requested'
          ? `A reviewer requested changes on PR #${e.payload.prNumber}.`
          : `Review updated on PR #${e.payload.prNumber}.`;
    case 'feedback.routed':
      return `Helix sent the ${reasonLabel(e.payload.reason)} back to ${agentName(state.sessions[e.payload.toSessionId]?.session.agent ?? 'the agent')}, which owns the branch.`;
    case 'pr.merged':
      return `PR #${e.payload.prNumber} merged.`;
    case 'terminal.output_marker':
      return `${who} printed terminal output.`;
  }
}

const reasonLabel = (r: 'ci_failed' | 'changes_requested' | 'merge_conflict') =>
  r === 'ci_failed'
    ? 'CI failure'
    : r === 'changes_requested'
      ? 'review comments'
      : 'merge conflict';

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** "4m", "1h", "now": relative to the cursor's moment, not the wall clock, so replay reads right. */
export function relativeTo(fromIso: string, nowIso: string): string {
  const mins = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(fromIso)) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Guardrail notes from #9 are matched by their (core-owned) wording; there's no structured
// field for them yet. Keep these prefixes in sync with packages/core/src/core.ts.
const TURN_LIMIT_PREFIX = 'Turn limit reached (';
const TURN_EXTENDED_PREFIX = 'Turn allowance extended to ';
const SLOT_WAIT_PREFIX = 'Waiting: ';

/**
 * The turn-limit note if this task is currently paused by the turn cap: the newest relevant
 * chat entry is Helix's limit note (not a later extension or user message) and it's waiting.
 */
export function turnLimitNote(s: SessionState): string | undefined {
  if (s.activity !== 'waiting_input') return undefined;
  for (let i = s.chat.length - 1; i >= 0; i--) {
    const item = s.chat[i]!;
    if (item.kind !== 'message') continue;
    if (item.role === 'user') return undefined;
    if (item.role === 'system' && item.text.startsWith(TURN_EXTENDED_PREFIX)) return undefined;
    if (item.role === 'system' && item.text.startsWith(TURN_LIMIT_PREFIX)) return item.text;
  }
  return undefined;
}

/** The slot note if this plan task is waiting for a free worker slot (no worker yet). */
export function slotWaitNote(state: ProjectState, nodeId: string): string | undefined {
  for (const plan of Object.values(state.plans)) {
    const node = plan.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    if (node.sessionId) return undefined;
    const chat = state.sessions[plan.orchestratorSessionId]?.chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
      const item = chat[i]!;
      if (item.kind === 'plan_update' && item.nodeId === nodeId)
        return item.text.startsWith(SLOT_WAIT_PREFIX) ? item.text : undefined;
    }
    return undefined;
  }
  return undefined;
}

/** Plan tasks currently waiting for a worker slot, across approved plans. */
export function slotWaiting(state: ProjectState): { nodeId: string; note: string }[] {
  return Object.values(state.plans)
    .filter((p) => p.status === 'approved')
    .flatMap((p) =>
      p.nodes.flatMap((n) => {
        const note = slotWaitNote(state, n.id);
        return note ? [{ nodeId: n.id, note }] : [];
      }),
    );
}

/** The single line under a card title: what the agent is doing, or why it's waiting. */
export function statusLine(
  s: SessionState,
  status: DisplayStatus,
  state: ProjectState,
): string | undefined {
  if (status === 'needs_you') {
    const approval = s.pendingApprovalIds.map((id) => state.approvals[id]).find(Boolean);
    if (approval) return `Approve: ${lowerFirst(truncate(approval.summary, 48))}`;
    if (turnLimitNote(s)) return 'Turn limit reached · send a message to continue';
    return 'Waiting for your reply';
  }
  if (status === 'ci_failed' && s.pr)
    return `CI failed · ${s.pr.checks.failingNames[0] ?? 'checks'}`;
  if (status === 'changes_requested')
    return `Changes requested · ${s.pr?.review.unresolvedThreads ?? 0} threads`;
  if (status === 'in_review' && s.pr) {
    if (s.pr.checks.pending > 0) return 'CI running';
    return s.pr.draft ? 'Draft PR' : 'Awaiting review';
  }
  if (status === 'working') {
    const last = [...s.chat].reverse().find((c) => c.kind === 'tool_call' || c.kind === 'message');
    if (last?.kind === 'tool_call') return truncate(last.inputSummary, 40);
    if (s.pr && s.pr.checks.failed > 0) return 'Fixing the CI failure';
    return 'Working';
  }
  if (status === 'pending' && s.session.planNodeId) {
    const plan = Object.values(state.plans).find((p) =>
      p.nodes.some((n) => n.id === s.session.planNodeId),
    );
    const node = plan?.nodes.find((n) => n.id === s.session.planNodeId);
    const waiting = node?.dependsOn.filter((d) => plan?.nodeStatus[d] !== 'merged').length ?? 0;
    if (waiting) return `Waiting on ${waiting} task${waiting > 1 ? 's' : ''}`;
  }
  return undefined;
}

export interface BoardCard {
  id: string;
  column: BoardColumn;
  status: DisplayStatus;
  card: SessionCardProps;
}

/** Worker sessions as board cards. The orchestrator lives in the plan view, not on the board. */
export function boardCards(
  state: ProjectState,
  bySeq: ReadonlyMap<number, HelixEvent>,
  nowIso: string,
): BoardCard[] {
  return Object.values(state.sessions)
    .filter((s) => s.session.role !== 'orchestrator')
    .map((s) => {
      const status = deriveStatus(s);
      const lastTs = bySeq.get(s.lastEventSeq)?.ts ?? s.session.createdAt;
      const label = statusLine(s, status, state);
      return {
        id: s.session.id,
        column: boardColumn(status),
        status,
        card: {
          title: s.session.title,
          agent: s.session.agent,
          status,
          ...(label ? { statusLabel: label } : {}),
          ...(s.session.branch ? { branch: s.session.branch } : {}),
          ...(s.pr ? { pr: { number: s.pr.number, comments: s.pr.review.unresolvedThreads } } : {}),
          ...(s.pr && s.pr.checks.total > 0
            ? { checks: { passed: s.pr.checks.passed, total: s.pr.checks.total } }
            : {}),
          updated: relativeTo(lastTs, nowIso),
        },
      };
    });
}
