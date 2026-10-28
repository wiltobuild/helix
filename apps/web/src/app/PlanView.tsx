import { useMemo, useState, type CSSProperties } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import type { HelixClient } from '@helix/api-client';
import {
  deriveStatus,
  type DisplayStatus,
  type Plan,
  type PlanNode,
  type PlanNodeId,
  type PlanState,
  type ProjectState,
} from '@helix/contracts';
import {
  AgentBadge,
  Button,
  EmptyState,
  HelixLogo,
  StatusDot,
  StatusPill,
  TextField,
  Tooltip,
  agentMeta,
  cx,
  statusMeta,
  toneVar,
} from '@helix/ui';
import { provenanceLabel, slotWaitNote } from '../data/describe';
import s from './PlanView.module.css';

const NODE_W = 248;
const NODE_H = 104;
const COL_GAP = 96;
const ROW_GAP = 28;
const ROOT_W = 220;

type Placed = { node: PlanNode; x: number; y: number; depth: number };

/** Longest-path layering: a node sits one column right of its deepest dependency. */
function layout(plan: Plan): { placed: Placed[]; width: number; height: number } {
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const depth = new Map<PlanNodeId, number>();
  const visit = (id: PlanNodeId, stack = new Set<PlanNodeId>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (stack.has(id)) return 0; // cycles are rejected by the core; stay safe anyway
    stack.add(id);
    const deps = byId.get(id)?.dependsOn ?? [];
    const d = deps.length ? Math.max(...deps.map((dep) => visit(dep, stack) + 1)) : 0;
    depth.set(id, d);
    return d;
  };
  plan.nodes.forEach((n) => visit(n.id));

  const columns: PlanNode[][] = [];
  for (const n of plan.nodes) (columns[depth.get(n.id)!] ??= []).push(n);
  const tallest = Math.max(...columns.map((c) => c.length));
  const height = tallest * NODE_H + (tallest - 1) * ROW_GAP;

  const placed: Placed[] = [];
  columns.forEach((col, ci) => {
    const colHeight = col.length * NODE_H + (col.length - 1) * ROW_GAP;
    const top = (height - colHeight) / 2;
    col.forEach((node, ri) =>
      placed.push({
        node,
        depth: ci,
        x: ROOT_W + COL_GAP + ci * (NODE_W + COL_GAP),
        y: top + ri * (NODE_H + ROW_GAP),
      }),
    );
  });
  const width = ROOT_W + COL_GAP + columns.length * (NODE_W + COL_GAP) - COL_GAP;
  return { placed, width, height };
}

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
};

interface PlanViewProps {
  state: ProjectState;
  selected: string | null;
  onSelect: (sessionId: string) => void;
  /** Present in live mode. Decisions are enabled only while viewing the live moment. */
  client?: HelixClient;
  isLive?: boolean;
}

/** The plan's approval state. Nothing should run until a human approves. */
function DecisionBar({
  plan,
  client,
  isLive,
}: {
  plan: PlanState;
  client?: HelixClient | undefined;
  isLive?: boolean | undefined;
}) {
  const [busy, setBusy] = useState<'approve' | 'reject'>();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const canAct = Boolean(client && isLive);

  if (plan.status === 'approved')
    return (
      <div className={s.decision} data-state="approved" role="status">
        <Check size={14} aria-hidden /> You approved this plan.
      </div>
    );
  if (plan.status === 'rejected')
    return (
      <div className={s.decision} data-state="rejected" role="status">
        <X size={14} aria-hidden /> You rejected this plan
        {plan.rejectionReason ? `: ${plan.rejectionReason}` : '.'}
      </div>
    );

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    setError(undefined);
    try {
      await client!.decidePlan(plan.id, {
        decision,
        ...(decision === 'reject' && reason.trim() ? { reason: reason.trim() } : {}),
      });
      setRejecting(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That decision failed.');
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className={s.decision} data-state="pending">
      <div className={s.decisionText}>
        <strong>This plan is waiting for your approval.</strong>
        <span>
          {client
            ? 'Nothing runs until you approve it. Review the tasks below first.'
            : 'In a live run, you approve the plan here before any agent starts.'}
        </span>
        {client && !isLive && <span>Go back to live to decide.</span>}
        {error && (
          <span className={s.decisionError} role="alert">
            {error}
          </span>
        )}
      </div>
      {client && (
        <div className={s.decisionActions}>
          {rejecting ? (
            <form
              className={s.rejectForm}
              onSubmit={(e) => {
                e.preventDefault();
                void decide('reject');
              }}
            >
              <TextField
                id="plan-reject-reason"
                label="Why are you rejecting it? (optional)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                autoFocus
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => setRejecting(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canAct} loading={busy === 'reject'}>
                Reject plan
              </Button>
            </form>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={!canAct || Boolean(busy)}
                onClick={() => setRejecting(true)}
              >
                Reject
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<Check size={14} />}
                disabled={!canAct || Boolean(busy)}
                loading={busy === 'approve'}
                onClick={() => void decide('approve')}
              >
                Approve plan
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function PlanView({ state, selected, onSelect, client, isLive }: PlanViewProps) {
  const plan = Object.values(state.plans).at(-1);
  const graph = useMemo(() => (plan ? layout(plan) : undefined), [plan]);

  if (!plan || !graph) {
    return (
      <EmptyState
        icon={<Sparkles size={18} />}
        title="No plan yet"
        description="Start a task with “Let the orchestrator plan it” and its plan appears here as a live graph."
      />
    );
  }

  const status = (id: PlanNodeId): DisplayStatus => plan.nodeStatus[id] ?? 'pending';
  const pos = new Map(graph.placed.map((p) => [p.node.id, p]));
  const rootY = graph.height / 2;
  const orchestrator = state.sessions[plan.orchestratorSessionId];
  const claudeNodes = plan.nodes.filter((n) => n.agent === 'claude-code');
  const codexNodes = plan.nodes.filter((n) => n.agent === 'codex');
  const claudeWorking = claudeNodes.some((n) => status(n.id) === 'working');
  const codexWorking = codexNodes.some((n) => status(n.id) === 'working');
  const orchestratorWorking = orchestrator ? deriveStatus(orchestrator) === 'working' : false;
  const anyWorking = claudeWorking || codexWorking || orchestratorWorking;
  const workingCount = plan.nodes.filter((n) => status(n.id) === 'working').length;
  const needsCount = plan.nodes.filter((n) => status(n.id) === 'needs_you').length;
  const reviewCount = plan.nodes.filter(
    (n) => status(n.id) === 'in_review' || status(n.id) === 'ready_to_merge',
  ).length;
  const mergedCount = plan.nodes.filter((n) => status(n.id) === 'merged').length;

  return (
    <div className={s.view}>
      <DecisionBar plan={plan} client={client} isLive={isLive} />
      <div className={s.observatoryBar} aria-label="Plan strand summary">
        <div className={s.strandSummary}>
          <span className={s.strandChip}>
            <AgentBadge agent="claude-code" active={claudeWorking} />
            <span className={s.strandCount}>
              {claudeNodes.length} {claudeNodes.length === 1 ? 'task' : 'tasks'}
            </span>
          </span>
          <span className={s.strandChip}>
            <AgentBadge agent="codex" active={codexWorking} />
            <span className={s.strandCount}>
              {codexNodes.length} {codexNodes.length === 1 ? 'task' : 'tasks'}
            </span>
          </span>
        </div>
        <div className={s.statusSummary}>
          <span className={s.statItem}>
            <StatusDot status="working" />
            <span>{workingCount} working</span>
          </span>
          <span className={s.statItem}>
            <StatusDot status="needs_you" />
            <span>{needsCount} needs you</span>
          </span>
          <span className={s.statItem}>
            <StatusDot status="in_review" />
            <span>{reviewCount} in review</span>
          </span>
          <span className={s.statItem}>
            <StatusDot status="merged" />
            <span>
              {mergedCount}/{plan.nodes.length} merged
            </span>
          </span>
        </div>
      </div>
      <div className={s.scroller}>
        <div className={s.canvas} style={{ width: graph.width, height: graph.height }}>
          <svg className={s.edges} width={graph.width} height={graph.height} aria-hidden>
            {graph.placed.map((p) => {
              const targetY = p.y + NODE_H / 2;
              const sources = p.node.dependsOn.length
                ? p.node.dependsOn.map((d) => pos.get(d)).filter((x): x is Placed => !!x)
                : [undefined];
              const edgeStrand = agentMeta(p.node.agent).colorVar;
              return sources.map((src) => {
                const x1 = src ? src.x + NODE_W : ROOT_W;
                const y1 = src ? src.y + NODE_H / 2 : rootY;
                const done = src ? status(src.node.id) === 'merged' : true;
                const flowing = done && isActive(status(p.node.id));
                const d = curve(x1, y1, p.x, targetY);
                return (
                  <g
                    key={`${src?.node.id ?? 'root'}-${p.node.id}`}
                    style={{ '--edge-strand': edgeStrand } as CSSProperties}
                  >
                    <path d={d} className={cx(s.edge, done && s.edgeDone)} />
                    {flowing && <path d={d} className={s.flow} />}
                  </g>
                );
              });
            })}
          </svg>

          <button
            type="button"
            className={cx(s.root, plan.orchestratorSessionId === selected && s.selected)}
            style={{ top: rootY - 56, width: ROOT_W }}
            onClick={() => onSelect(plan.orchestratorSessionId)}
          >
            <span className={s.rootLabel}>
              <HelixLogo size={14} active={anyWorking} /> Plan
            </span>
            <p className={s.goal}>{plan.goal}</p>
            {orchestrator && (
              <AgentBadge agent={orchestrator.session.agent} active={orchestratorWorking} />
            )}
            <span className={s.count}>
              {mergedCount}/{plan.nodes.length} merged
            </span>
          </button>

          {graph.placed.map(({ node, x, y }) => {
            const st = status(node.id);
            const tone = toneVar(statusMeta[st].tone);
            const slotWait = slotWaitNote(state, node.id);
            return (
              <Tooltip
                key={node.id}
                side="bottom"
                content={
                  <span className={s.tip}>
                    <strong>Why this task · {provenanceLabel.plan}</strong>
                    {node.rationale}
                    {slotWait && (
                      <>
                        <strong>Waiting · {provenanceLabel.helix}</strong>
                        {slotWait}
                      </>
                    )}
                  </span>
                }
              >
                <button
                  type="button"
                  className={cx(s.node, node.sessionId === selected && s.selected)}
                  style={
                    {
                      left: x,
                      top: y,
                      width: NODE_W,
                      height: NODE_H,
                      '--tone': tone,
                    } as CSSProperties
                  }
                  onClick={() => node.sessionId && onSelect(node.sessionId)}
                  disabled={!node.sessionId}
                  data-status={st}
                >
                  <span className={s.nodeHead}>
                    <AgentBadge agent={node.agent} active={st === 'working'} />
                    {node.dependsOn.length > 0 && (
                      <span className={s.deps}>after {node.dependsOn.length}</span>
                    )}
                  </span>
                  <span className={s.nodeTitle}>{node.title}</span>
                  {slotWait ? (
                    <span className={s.slotWait}>
                      {state.schedulingPaused
                        ? 'Paused: scheduling is stopped'
                        : 'Waiting for a worker slot'}
                    </span>
                  ) : (
                    <StatusPill status={st} variant="inline" />
                  )}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const isActive = (st: DisplayStatus) =>
  st === 'working' || st === 'needs_you' || st === 'ci_failed' || st === 'in_review';
