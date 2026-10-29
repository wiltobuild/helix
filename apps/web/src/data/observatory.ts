import {
  deriveStatus,
  type AgentKind,
  type DisplayStatus,
  type HelixEvent,
  type PlanNode,
  type PlanState,
  type ProjectState,
  type SessionState,
} from '@helix/contracts';
import { describeEvent, eventTone, slotWaitNote, type EventTone } from './describe';

/**
 * View models for the Concept 3 "Flow Observatory" layout. Everything here is derived from the
 * projected state and the event log up to the cursor, so replay renders the same screens as live.
 */

export const agentLabel = (agent: AgentKind) =>
  agent === 'claude-code' ? 'Claude Code' : agent === 'codex' ? 'Codex' : agent;

/** The plan this screen is about: the newest one. */
export function activePlan(state: ProjectState): PlanState | undefined {
  return Object.values(state.plans).at(-1);
}

/** Short label shown on a task card, close to the render's Todo / In progress / Blocked / Done. */
export type TaskTone = 'todo' | 'progress' | 'needs' | 'blocked' | 'review' | 'ready' | 'done';

export function taskLabel(
  status: DisplayStatus,
  waiting: boolean,
): { label: string; tone: TaskTone } {
  switch (status) {
    case 'working':
      return { label: 'In progress', tone: 'progress' };
    case 'needs_you':
      return { label: 'Needs you', tone: 'needs' };
    case 'ci_failed':
      return { label: 'CI failed', tone: 'blocked' };
    case 'changes_requested':
      return { label: 'Changes asked', tone: 'blocked' };
    case 'in_review':
      return { label: 'In review', tone: 'review' };
    case 'ready_to_merge':
      return { label: 'Ready', tone: 'ready' };
    case 'merged':
      return { label: 'Done', tone: 'done' };
    case 'exited':
      return { label: 'Stopped', tone: 'blocked' };
    case 'archived':
      return { label: 'Archived', tone: 'done' };
    default:
      return waiting ? { label: 'Waiting', tone: 'todo' } : { label: 'Todo', tone: 'todo' };
  }
}

export interface Timing {
  start?: string;
  end?: string;
  merged?: string;
}

/** First and last event time per session, plus merge time, from events up to the cursor. */
export function sessionTimings(events: readonly HelixEvent[], uptoIndex: number) {
  const out = new Map<string, Timing>();
  for (let i = 0; i <= uptoIndex && i < events.length; i++) {
    const e = events[i]!;
    if (!e.sessionId) continue;
    const t = out.get(e.sessionId) ?? {};
    if (!t.start) t.start = e.ts;
    t.end = e.ts;
    if (e.type === 'pr.merged') t.merged = e.ts;
    out.set(e.sessionId, t);
  }
  return out;
}

export const durationMs = (from?: string, to?: string) =>
  from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : 0;

/** "28m", "2h 14m", "45s". */
export function formatDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

export interface TaskView {
  node: PlanNode;
  number: number;
  session?: SessionState;
  status: DisplayStatus;
  label: string;
  tone: TaskTone;
  waitingNote?: string;
  /** Titles of tasks this one waits on that haven't merged yet. */
  waitsOn: string[];
  insertions?: number;
  deletions?: number;
  pr?: number;
  checks?: { passed: number; total: number; failed: number; pending: number };
}

export interface AgentView {
  agent: AgentKind;
  tasks: TaskView[];
  active: boolean;
  statusLabel: string;
  ciPassed: number;
  ciTotal: number;
  elapsedMs: number;
  role: string;
}

export interface OrchestratorView {
  sessionId: string;
  agent: AgentKind;
  statusLabel: string;
  tone: 'needs' | 'working' | 'done' | 'rejected' | 'idle';
  merged: number;
  total: number;
  planLabel: string;
  elapsedMs: number;
  active: boolean;
}

export interface PlanTree {
  plan: PlanState;
  orchestrator: OrchestratorView;
  agents: AgentView[];
  tasks: TaskView[];
}

const AGENT_ORDER: Record<string, number> = { codex: 0, 'claude-code': 1 };

export function planTree(
  state: ProjectState,
  events: readonly HelixEvent[],
  uptoIndex: number,
  nowIso: string,
): PlanTree | undefined {
  const plan = activePlan(state);
  if (!plan) return undefined;
  const timings = sessionTimings(events, uptoIndex);
  const titleById = new Map(plan.nodes.map((n) => [n.id, n.title]));

  const tasks: TaskView[] = plan.nodes.map((node, i) => {
    const session = node.sessionId ? state.sessions[node.sessionId] : undefined;
    const status: DisplayStatus = plan.nodeStatus[node.id] ?? 'pending';
    const waitingNote = slotWaitNote(state, node.id);
    const waitsOn = node.dependsOn
      .filter((d) => plan.nodeStatus[d] !== 'merged')
      .map((d) => titleById.get(d) ?? d);
    const { label, tone } = taskLabel(status, Boolean(waitingNote) || waitsOn.length > 0);
    const diff = session?.worktree?.diff;
    return {
      node,
      number: i + 1,
      status,
      label,
      tone,
      waitsOn,
      ...(session ? { session } : {}),
      ...(waitingNote ? { waitingNote } : {}),
      ...(diff ? { insertions: diff.insertions, deletions: diff.deletions } : {}),
      ...(session?.pr
        ? {
            pr: session.pr.number,
            checks: {
              passed: session.pr.checks.passed,
              total: session.pr.checks.total,
              failed: session.pr.checks.failed,
              pending: session.pr.checks.pending,
            },
          }
        : {}),
    };
  });

  const agentKinds = [...new Set(plan.nodes.map((n) => n.agent))].sort(
    (a, b) => (AGENT_ORDER[a] ?? 9) - (AGENT_ORDER[b] ?? 9),
  );
  const agents: AgentView[] = agentKinds.map((agent) => {
    const mine = tasks.filter((t) => t.node.agent === agent);
    const active = mine.some((t) => t.status === 'working');
    const done = mine.every((t) => t.status === 'merged' || t.status === 'archived');
    const needs = mine.some((t) => t.status === 'needs_you');
    const started = mine.filter((t) => t.session);
    const starts = started
      .map((t) => timings.get(t.session!.session.id)?.start)
      .filter((x): x is string => Boolean(x));
    const ends = started.map((t) => {
      const tm = timings.get(t.session!.session.id);
      const finished = t.status === 'merged' || t.status === 'archived' || t.status === 'exited';
      return finished ? (tm?.merged ?? tm?.end) : nowIso;
    });
    const first = starts.sort()[0];
    const last = ends
      .filter((x): x is string => Boolean(x))
      .sort()
      .at(-1);
    return {
      agent,
      tasks: mine,
      active,
      statusLabel: done
        ? 'Done'
        : active
          ? 'Running'
          : needs
            ? 'Needs you'
            : started.length
              ? 'Waiting'
              : plan.status === 'approved'
                ? 'Queued'
                : 'Idle',
      ciPassed: mine.reduce((n, t) => n + (t.checks?.passed ?? 0), 0),
      ciTotal: mine.reduce((n, t) => n + (t.checks?.total ?? 0), 0),
      elapsedMs: durationMs(first, last),
      role: roleFor(mine),
    };
  });

  const orch = state.sessions[plan.orchestratorSessionId];
  const orchTiming = timings.get(plan.orchestratorSessionId);
  const merged = tasks.filter((t) => t.status === 'merged').length;
  const orchStatus = orch ? deriveStatus(orch) : 'pending';
  const allDone = tasks.length > 0 && merged === tasks.length;
  const orchestrator: OrchestratorView = {
    sessionId: plan.orchestratorSessionId,
    agent: orch?.session.agent ?? 'claude-code',
    ...(plan.status === 'awaiting_approval'
      ? { statusLabel: 'Needs review', tone: 'needs' as const }
      : plan.status === 'rejected'
        ? { statusLabel: 'Rejected', tone: 'rejected' as const }
        : allDone
          ? { statusLabel: 'Complete', tone: 'done' as const }
          : { statusLabel: 'Running', tone: 'working' as const }),
    merged,
    total: tasks.length,
    planLabel:
      plan.status === 'awaiting_approval'
        ? 'plan ready'
        : plan.status === 'approved'
          ? 'plan approved'
          : 'plan rejected',
    elapsedMs: durationMs(orchTiming?.start ?? plan.createdAt, allDone ? orchTiming?.end : nowIso),
    active: orchStatus === 'working',
  };

  return { plan, orchestrator, agents, tasks };
}

function roleFor(tasks: TaskView[]): string {
  const files = tasks.flatMap((t) => t.node.files);
  if (files.length === 0)
    return `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} in the plan`;
  const shown = files.slice(0, 2).join(', ');
  return files.length > 2 ? `${shown} +${files.length - 2}` : shown;
}

export interface PlanSummary {
  tasks: number;
  files: number;
  prsOpen: number;
  prsMerged: number;
  agents: number;
  elapsedMs: number;
}

export function planSummary(tree: PlanTree): PlanSummary {
  const files = new Set(tree.tasks.flatMap((t) => t.node.files));
  return {
    tasks: tree.tasks.length,
    files: files.size,
    prsOpen: tree.tasks.filter((t) => t.pr !== undefined && t.status !== 'merged').length,
    prsMerged: tree.tasks.filter((t) => t.status === 'merged').length,
    agents: tree.agents.length,
    elapsedMs: tree.orchestrator.elapsedMs,
  };
}

/** Why the plan can't move on, in the user's terms. Undefined when nothing is blocking it. */
export function planBlockers(tree: PlanTree, state: ProjectState): string[] | undefined {
  const { plan } = tree;
  if (plan.status === 'awaiting_approval')
    return [
      'The plan needs your approval before any agent can start. No code has been changed yet.',
      `Review the ${tree.tasks.length} ${tree.tasks.length === 1 ? 'task' : 'tasks'}, which agent does each, and the files each one claims, then approve or ask for changes.`,
    ];
  if (plan.status === 'rejected')
    return [`You rejected this plan${plan.rejectionReason ? `: ${plan.rejectionReason}` : '.'}`];
  const reasons: string[] = [];
  if (state.schedulingPaused)
    reasons.push('Scheduling is paused after Stop all. Approve a plan or create a task to resume.');
  for (const t of tree.tasks) {
    if (t.status === 'needs_you') reasons.push(`“${t.node.title}” is waiting for your answer.`);
    if (t.status === 'ci_failed')
      reasons.push(
        `CI failed on “${t.node.title}”; Helix sent the failure back to ${agentLabel(t.node.agent)}.`,
      );
    if (t.waitingNote && !state.schedulingPaused)
      reasons.push(`“${t.node.title}”: ${t.waitingNote}.`);
  }
  return reasons.length ? reasons : undefined;
}

/** The newest event at or before the cursor worth narrating (skips agent chatter and status pings). */
export function narratedEvent(events: readonly HelixEvent[], index: number): HelixEvent {
  for (let i = index; i >= 0; i--) {
    const e = events[i]!;
    if (isNarrated(e)) return e;
  }
  return events[index]!;
}

function isNarrated(e: HelixEvent): boolean {
  if (eventTone(e) !== 'quiet') return true;
  switch (e.type) {
    case 'session.created':
    case 'pr.updated':
    case 'worktree.diff_updated':
    case 'reasoning.summary':
      return true;
    case 'chat.item':
      return e.payload.item.kind === 'message' && e.payload.item.role === 'system';
    default:
      return false;
  }
}

/** One line of the Activity feed. */
export interface FeedItem {
  seq: number;
  index: number;
  ts: string;
  tone: EventTone;
  text: string;
  sessionId?: string;
}

export function activityFeed(
  events: readonly HelixEvent[],
  uptoIndex: number,
  state: ProjectState,
  limit = 80,
): FeedItem[] {
  const out: FeedItem[] = [];
  for (let i = Math.min(uptoIndex, events.length - 1); i >= 0 && out.length < limit; i--) {
    const e = events[i]!;
    if (!isNarrated(e)) continue;
    out.push({
      seq: e.seq,
      index: i,
      ts: e.ts,
      tone: eventTone(e),
      text: describeEvent(e, state),
      ...(e.sessionId ? { sessionId: e.sessionId } : {}),
    });
  }
  return out;
}

export interface CommitView {
  sha: string;
  title: string;
  sessionId: string;
  agent: AgentKind;
  task: string;
  branch?: string;
}

/** Commits Helix made at the end of each agent turn (recorded as Helix system messages). */
export function commits(state: ProjectState): CommitView[] {
  const out: CommitView[] = [];
  for (const s of Object.values(state.sessions)) {
    for (const item of s.chat) {
      if (item.kind !== 'message' || item.role !== 'system') continue;
      const m = /^Committed ([0-9a-f]{7,40}): (.+)$/.exec(item.text);
      if (!m) continue;
      out.push({
        sha: m[1]!,
        title: m[2]!,
        sessionId: s.session.id,
        agent: s.session.agent,
        task: s.session.title,
        ...(s.session.branch ? { branch: s.session.branch } : {}),
      });
    }
  }
  return out.reverse();
}

export interface Lane {
  id: string;
  kind: 'orchestrator' | 'agent' | 'task';
  label: string;
  sublabel?: string;
  agent?: AgentKind;
  sessionId?: string;
  /** Solid bar: recorded work. Fractions of the time axis [0, 1]. */
  bars: { from: number; to: number; tone: 'done' | 'working' | 'review' | 'failed' | 'planned' }[];
  marks: { at: number; tone: EventTone; seq: number; index: number; text: string }[];
}

/**
 * Gantt lanes: one for the orchestrator, one per agent, one per task. The axis spans the whole
 * recording (so the cursor line moves as you scrub); bars stop at the cursor, and tasks that haven't
 * started show a dashed "planned" placeholder after it.
 */
export function ganttLanes(
  events: readonly HelixEvent[],
  uptoIndex: number,
  state: ProjectState,
  tree: PlanTree | undefined,
): { lanes: Lane[]; startTs: number; endTs: number; cursorAt: number } {
  const startTs = Date.parse(events[0]!.ts);
  const endTs = Math.max(Date.parse(events.at(-1)!.ts), startTs + 1000);
  const span = endTs - startTs;
  const at = (ts: string) => Math.min(1, Math.max(0, (Date.parse(ts) - startTs) / span));
  const cursorTs = events[Math.min(uptoIndex, events.length - 1)]!.ts;
  const cursorAt = at(cursorTs);

  const marksFor = (pred: (e: HelixEvent) => boolean) => {
    const marks: Lane['marks'] = [];
    for (let i = 0; i <= uptoIndex && i < events.length; i++) {
      const e = events[i]!;
      const tone = eventTone(e);
      if (tone === 'quiet' || !pred(e)) continue;
      marks.push({ at: at(e.ts), tone, seq: e.seq, index: i, text: describeEvent(e, state) });
    }
    return marks;
  };

  const timings = sessionTimings(events, uptoIndex);
  const barFor = (sessionId: string, status: DisplayStatus): Lane['bars'] => {
    const t = timings.get(sessionId);
    if (!t?.start) return [];
    const finished = status === 'merged' || status === 'archived' || status === 'exited';
    const to = finished ? at(t.merged ?? t.end!) : cursorAt;
    const tone: Lane['bars'][number]['tone'] =
      status === 'merged' || status === 'archived'
        ? 'done'
        : status === 'ci_failed' || status === 'changes_requested'
          ? 'failed'
          : status === 'in_review' || status === 'ready_to_merge'
            ? 'review'
            : 'working';
    return [{ from: at(t.start), to: Math.max(to, at(t.start) + 0.004), tone }];
  };

  const lanes: Lane[] = [];
  if (tree) {
    const orchId = tree.orchestrator.sessionId;
    const orchSession = state.sessions[orchId as keyof typeof state.sessions];
    const orchStatus = orchSession ? deriveStatus(orchSession) : 'pending';
    const orchBars = barFor(orchId, tree.orchestrator.tone === 'done' ? 'merged' : orchStatus);
    lanes.push({
      id: 'orchestrator',
      kind: 'orchestrator',
      label: 'Orchestrator',
      agent: tree.orchestrator.agent,
      sessionId: orchId,
      bars: orchBars.length
        ? [
            {
              ...orchBars[0]!,
              to: tree.orchestrator.tone === 'done' ? orchBars[0]!.to : cursorAt,
              tone: 'review',
            },
          ]
        : [],
      marks: marksFor(
        (e) =>
          e.sessionId === orchId ||
          e.type === 'plan.submitted' ||
          e.type === 'plan.approved' ||
          e.type === 'plan.rejected',
      ),
    });
    const avgTask =
      tree.tasks
        .map((t) =>
          t.session
            ? durationMs(
                timings.get(t.session.session.id)?.start,
                timings.get(t.session.session.id)?.merged,
              )
            : 0,
        )
        .filter((d) => d > 0)
        .reduce((a, b, _i, arr) => a + b / arr.length, 0) || span * 0.25;
    for (const a of tree.agents) {
      const ids = new Set(a.tasks.flatMap((t) => (t.session ? [t.session.session.id] : [])));
      const bars = a.tasks.flatMap((t) =>
        t.session ? barFor(t.session.session.id, t.status) : [],
      );
      const from = Math.min(...bars.map((b) => b.from));
      const to = Math.max(...bars.map((b) => b.to));
      lanes.push({
        id: `agent-${a.agent}`,
        kind: 'agent',
        label: agentLabel(a.agent),
        agent: a.agent,
        bars: bars.length
          ? [
              {
                from,
                to,
                tone: a.active ? 'working' : a.statusLabel === 'Done' ? 'done' : 'working',
              },
            ]
          : [],
        marks: marksFor((e) => Boolean(e.sessionId && ids.has(e.sessionId))),
      });
    }
    for (const t of tree.tasks) {
      const id = t.session?.session.id;
      const bars = id ? barFor(id, t.status) : [];
      if (!id) {
        const width = Math.min(0.3, avgTask / span);
        bars.push({ from: cursorAt, to: Math.min(1, cursorAt + width), tone: 'planned' });
      }
      lanes.push({
        id: `task-${t.node.id}`,
        kind: 'task',
        label: `Task ${t.number}`,
        sublabel: t.node.title,
        agent: t.node.agent,
        ...(id ? { sessionId: id } : {}),
        bars,
        marks: id ? marksFor((e) => e.sessionId === id) : [],
      });
    }
  } else {
    for (const s of Object.values(state.sessions)) {
      lanes.push({
        id: s.session.id,
        kind: 'task',
        label:
          s.session.role === 'orchestrator'
            ? 'Orchestrator'
            : s.session.role === 'reviewer'
              ? `${agentLabel(s.session.agent)} · review`
              : agentLabel(s.session.agent),
        sublabel: s.session.title,
        agent: s.session.agent,
        sessionId: s.session.id,
        bars: barFor(s.session.id, deriveStatus(s)),
        marks: marksFor((e) => e.sessionId === s.session.id),
      });
    }
  }
  return { lanes, startTs, endTs, cursorAt };
}
