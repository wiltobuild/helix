import { useMemo, type CSSProperties } from 'react';
import { Sparkles } from 'lucide-react';
import type { DisplayStatus, Plan, PlanNode, PlanNodeId, ProjectState } from '@helix/contracts';
import { AgentBadge, EmptyState, StatusPill, Tooltip, cx, statusMeta, toneVar } from '@helix/ui';
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
}

export function PlanView({ state, selected, onSelect }: PlanViewProps) {
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

  return (
    <div className={s.scroller}>
      <div className={s.canvas} style={{ width: graph.width, height: graph.height }}>
        <svg className={s.edges} width={graph.width} height={graph.height} aria-hidden>
          {graph.placed.map((p) => {
            const targetY = p.y + NODE_H / 2;
            const sources = p.node.dependsOn.length
              ? p.node.dependsOn.map((d) => pos.get(d)).filter((x): x is Placed => !!x)
              : [undefined];
            return sources.map((src) => {
              const x1 = src ? src.x + NODE_W : ROOT_W;
              const y1 = src ? src.y + NODE_H / 2 : rootY;
              const done = src ? status(src.node.id) === 'merged' : true;
              const flowing = done && isActive(status(p.node.id));
              const d = curve(x1, y1, p.x, targetY);
              return (
                <g key={`${src?.node.id ?? 'root'}-${p.node.id}`}>
                  <path d={d} className={cx(s.edge, done && s.edgeDone)} />
                  {flowing && <path d={d} className={s.flow} />}
                </g>
              );
            });
          })}
        </svg>

        <div className={s.root} style={{ top: rootY - 56, width: ROOT_W }}>
          <span className={s.rootLabel}>
            <Sparkles size={12} aria-hidden /> Plan
          </span>
          <p className={s.goal}>{plan.goal}</p>
          {orchestrator && <AgentBadge agent={orchestrator.session.agent} />}
          <span className={s.count}>
            {plan.nodes.filter((n) => status(n.id) === 'merged').length}/{plan.nodes.length} merged
          </span>
        </div>

        {graph.placed.map(({ node, x, y }) => {
          const st = status(node.id);
          const tone = toneVar(statusMeta[st].tone);
          return (
            <Tooltip
              key={node.id}
              side="bottom"
              content={
                <span className={s.tip}>
                  <strong>Why this task</strong>
                  {node.rationale}
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
                  <AgentBadge agent={node.agent} />
                  {node.dependsOn.length > 0 && (
                    <span className={s.deps}>after {node.dependsOn.length}</span>
                  )}
                </span>
                <span className={s.nodeTitle}>{node.title}</span>
                <StatusPill status={st} variant="inline" />
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

const isActive = (st: DisplayStatus) =>
  st === 'working' || st === 'needs_you' || st === 'ci_failed' || st === 'in_review';
