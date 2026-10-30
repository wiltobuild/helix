import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowRight,
  Check,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  FileText,
  GitPullRequest,
  ListChecks,
  LoaderCircle,
  Sparkles,
  Workflow,
} from 'lucide-react';
import type { HelixClient } from '@helix/api-client';
import type { HelixEvent, ProjectState } from '@helix/contracts';
import { AgentEmblem, AgentBadge, Button, EmptyState, Tooltip, agentMeta, cx } from '@helix/ui';
import { provenanceLabel } from '../data/describe';
import { crossReview } from '../data/crossReview';
import {
  agentLabel,
  formatDuration,
  planTree,
  type AgentView,
  type TaskView,
} from '../data/observatory';
import { ReviewChip } from './ReviewChip';
import s from './PlanView.module.css';

const CARD_W = 200;
const CARD_GAP = 14;
const GROUP_GAP = 40;
const AGENT_W = 330;
const ORCH_W = 380;
const ORCH_H = 104;
const AGENT_H = 104;
const CARD_H = 188;
const ROW_GAP = 64;
const PAD = 8;

interface PlanViewProps {
  state: ProjectState;
  selected: string | null;
  onSelect: (sessionId: string) => void;
  /** Opens the orchestrator in the inspector, on its plan. */
  onReviewPlan?: () => void;
  /** Event log and cursor, for elapsed times. Optional so the view renders from state alone. */
  events?: readonly HelixEvent[];
  index?: number;
  /** Present in live mode. */
  client?: HelixClient;
  isLive?: boolean;
}

type Group = { agent: AgentView; x: number; width: number; cardsX: number[] };

function layout(agents: AgentView[]) {
  let x = PAD;
  const groups: Group[] = agents.map((agent) => {
    const n = Math.max(agent.tasks.length, 1);
    const cardsWidth = n * CARD_W + (n - 1) * CARD_GAP;
    const width = Math.max(AGENT_W, cardsWidth);
    const start = x + (width - cardsWidth) / 2;
    const g = {
      agent,
      x,
      width,
      cardsX: agent.tasks.map((_, i) => start + i * (CARD_W + CARD_GAP)),
    };
    x += width + GROUP_GAP;
    return g;
  });
  // Room on the right of the orchestrator for the "Review plan" button.
  const width = Math.max(x - GROUP_GAP + PAD, ORCH_W + 2 * 190);
  const agentY = ORCH_H + ROW_GAP;
  const cardY = agentY + AGENT_H + ROW_GAP;
  const height = cardY + CARD_H + PAD;
  return { groups, width, height, agentY, cardY };
}

/** Vertical S-curve from a node's bottom to another node's top. */
const drop = (x1: number, y1: number, x2: number, y2: number) => {
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
};

/**
 * Concept 3 plan view. The orchestrator's plan as a tree: the orchestrator on top (it waits for
 * your approval before anything runs), one node per agent, and that agent's tasks below. Edges carry
 * the agent's strand color and flow while work is moving along them. The graph scales to fit.
 */
export function PlanView({
  state,
  selected,
  onSelect,
  onReviewPlan,
  events,
  index,
}: PlanViewProps) {
  const nowIso = events && index !== undefined ? events[index]!.ts : new Date(0).toISOString();
  const tree = useMemo(
    () => planTree(state, events ?? [], events && index !== undefined ? index : -1, nowIso),
    [state, events, index, nowIso],
  );
  const graph = useMemo(() => (tree ? layout(tree.agents) : undefined), [tree]);
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el || !graph) return;
    const fit = () => {
      const w = el.clientWidth - 32;
      const h = el.clientHeight - 32;
      if (w <= 0 || h <= 0) return;
      setScale(Math.max(0.45, Math.min(w / graph.width, h / graph.height, 1.3)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [graph]);

  if (!tree || !graph) {
    return (
      <EmptyState
        icon={<Sparkles size={18} />}
        title="No plan yet"
        description="Start a task with “Let the orchestrator plan it”. Its plan appears here: the orchestrator on top, one branch per agent, and every task it assigned."
      />
    );
  }

  const { orchestrator: orch, plan } = tree;
  const orchX = (graph.width - ORCH_W) / 2;
  const orchCx = graph.width / 2;
  const awaiting = plan.status === 'awaiting_approval';

  return (
    <div className={s.view} ref={wrap}>
      <div className={s.stage} style={{ width: graph.width * scale, height: graph.height * scale }}>
        <div
          className={s.canvas}
          style={{ width: graph.width, height: graph.height, transform: `scale(${scale})` }}
        >
          <svg className={s.edges} width={graph.width} height={graph.height} aria-hidden>
            {graph.groups.map((g) => {
              const strand = agentMeta(g.agent.agent).colorVar;
              const ax = g.x + g.width / 2;
              const approved = plan.status === 'approved';
              return (
                <g key={g.agent.agent} style={{ '--edge-strand': strand } as CSSProperties}>
                  <path
                    d={drop(orchCx, ORCH_H, ax, graph.agentY)}
                    className={cx(s.edge, approved && s.edgeOn)}
                  />
                  {approved && g.agent.active && (
                    <path d={drop(orchCx, ORCH_H, ax, graph.agentY)} className={s.flow} />
                  )}
                  <circle cx={ax} cy={graph.agentY} r={3.5} className={s.joint} />
                  {g.agent.tasks.map((t, i) => {
                    const cx2 = g.cardsX[i]! + CARD_W / 2;
                    const d = drop(ax, graph.agentY + AGENT_H, cx2, graph.cardY);
                    const on = t.status !== 'pending' || approved;
                    const flowing = t.status === 'working' || t.status === 'ci_failed';
                    return (
                      <g key={t.node.id}>
                        <path d={d} className={cx(s.edge, on && s.edgeOn)} />
                        {flowing && <path d={d} className={s.flow} />}
                        <circle cx={cx2} cy={graph.cardY} r={3.5} className={s.joint} />
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>

          {/* Orchestrator */}
          <div className={s.orchRow} style={{ left: orchX, top: 0, width: ORCH_W }}>
            <button
              type="button"
              className={cx(s.orch, orch.sessionId === selected && s.selected)}
              data-tone={orch.tone}
              style={{ width: ORCH_W, height: ORCH_H }}
              onClick={() => onSelect(orch.sessionId)}
            >
              <span className={s.orchHead}>
                <span className={s.orchIcon} data-active={orch.active || undefined}>
                  <Workflow size={20} aria-hidden />
                </span>
                <span className={s.orchName}>
                  <strong>Orchestrator</strong>
                  <span>Plan and coordinate all tasks</span>
                </span>
                <span className={s.pill} data-tone={orch.tone}>
                  <span className={s.pillDot} aria-hidden />
                  {orch.statusLabel}
                </span>
              </span>
              <span className={s.stats}>
                <span>
                  <ListChecks size={13} aria-hidden />
                  {awaiting ? `${orch.total} tasks` : `${orch.merged}/${orch.total} merged`}
                </span>
                <span>
                  <Check size={13} aria-hidden />
                  {orch.planLabel}
                </span>
                <span>
                  <Clock size={13} aria-hidden />
                  {formatDuration(orch.elapsedMs)}
                </span>
              </span>
            </button>
            {awaiting && onReviewPlan && (
              <Button variant="outline" className={s.reviewBtn} onClick={onReviewPlan}>
                Review plan <ArrowRight size={14} aria-hidden />
              </Button>
            )}
          </div>

          {/* Agents */}
          {graph.groups.map((g) => {
            const a = g.agent;
            const ax = g.x + (g.width - AGENT_W) / 2;
            return (
              <div
                key={a.agent}
                className={s.agent}
                data-active={a.active || undefined}
                style={
                  {
                    left: ax,
                    top: graph.agentY,
                    width: AGENT_W,
                    height: AGENT_H,
                    '--agent': agentMeta(a.agent).colorVar,
                  } as CSSProperties
                }
                aria-label={`${agentLabel(a.agent)}: ${a.statusLabel}`}
              >
                <span className={s.agentHead}>
                  <AgentEmblem agent={a.agent} active={a.active} size={44} />
                  <span className={s.agentName}>
                    <strong>{agentLabel(a.agent)}</strong>
                    <span title={a.role}>{a.role}</span>
                  </span>
                  <span className={s.pill} data-tone={agentTone(a)}>
                    <span className={s.pillDot} aria-hidden />
                    {a.statusLabel}
                  </span>
                </span>
                <span className={s.stats}>
                  <span>
                    <ListChecks size={13} aria-hidden />
                    {a.tasks.length} {a.tasks.length === 1 ? 'task' : 'tasks'}
                  </span>
                  <span data-ok={a.ciTotal > 0 && a.ciPassed === a.ciTotal ? '' : undefined}>
                    <CircleCheck size={13} aria-hidden />
                    {a.ciTotal > 0 ? `${a.ciPassed}/${a.ciTotal} CI passed` : 'No CI yet'}
                  </span>
                  <span>
                    <Clock size={13} aria-hidden />
                    {a.elapsedMs ? formatDuration(a.elapsedMs) : '—'}
                  </span>
                </span>
              </div>
            );
          })}

          {/* Tasks */}
          {graph.groups.flatMap((g) =>
            g.agent.tasks.map((t, i) => (
              <TaskCard
                key={t.node.id}
                task={t}
                state={state}
                x={g.cardsX[i]!}
                y={graph.cardY}
                selected={Boolean(t.session && t.session.session.id === selected)}
                onSelect={onSelect}
              />
            )),
          )}
        </div>
      </div>
    </div>
  );
}

function agentTone(a: AgentView) {
  if (a.active) return 'working';
  if (a.statusLabel === 'Done') return 'done';
  if (a.statusLabel === 'Needs you') return 'needs';
  return 'idle';
}

function TaskCard({
  task: t,
  state,
  x,
  y,
  selected,
  onSelect,
}: {
  task: TaskView;
  state: ProjectState;
  x: number;
  y: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const review = t.session ? crossReview(t.session, state) : undefined;
  const sid = t.session?.session.id;
  return (
    <Tooltip
      side="bottom"
      content={
        <span className={s.tip}>
          <strong>Why this task · {provenanceLabel.plan}</strong>
          {t.node.rationale}
          {t.node.files.length > 0 && (
            <>
              <strong>Claims</strong>
              {t.node.files.join(', ')}
            </>
          )}
          {t.waitingNote && (
            <>
              <strong>Waiting · {provenanceLabel.helix}</strong>
              {t.waitingNote}
            </>
          )}
        </span>
      }
    >
      <button
        type="button"
        className={cx(s.card, selected && s.selected)}
        style={
          {
            left: x,
            top: y,
            width: CARD_W,
            height: CARD_H,
            '--agent': agentMeta(t.node.agent).colorVar,
          } as CSSProperties
        }
        data-tone={t.tone}
        data-status={t.status}
        onClick={() => sid && onSelect(sid)}
        disabled={!sid}
      >
        <span className={s.cardHead}>
          <AgentBadge
            agent={t.node.agent}
            variant="glyph"
            active={t.status === 'working'}
            size={16}
          />
          <span className={s.cardNum}>Task {t.number}</span>
          <span className={s.chip} data-tone={t.tone}>
            {t.label}
          </span>
        </span>
        <span className={s.cardTitle}>{t.node.title}</span>
        <span className={s.cardDesc}>
          {t.waitsOn.length > 0 && t.status === 'pending'
            ? `Waits on ${t.waitsOn.join(', ')}`
            : t.waitingNote
              ? t.waitingNote
              : t.node.description || t.node.rationale}
        </span>
        {review && <ReviewChip review={review} />}
        <span className={s.cardFoot}>
          <span className={s.diff}>
            {t.insertions !== undefined ? (
              <>
                <span className={s.add}>+{t.insertions}</span>
                <span className={s.del}>−{t.deletions}</span>
              </>
            ) : (
              <span className={s.muted}>
                <FileText size={12} aria-hidden /> {t.node.files.length || '—'}
              </span>
            )}
          </span>
          <span className={s.pr}>
            <GitPullRequest size={12} aria-hidden />
            {t.pr ? `#${t.pr}` : '—'}
          </span>
          <StatusIcon tone={t.tone} />
        </span>
      </button>
    </Tooltip>
  );
}

function StatusIcon({ tone }: { tone: TaskView['tone'] }) {
  if (tone === 'done' || tone === 'ready')
    return <CircleCheck size={16} className={s.iconDone} aria-label="Done" />;
  if (tone === 'blocked') return <CircleX size={16} className={s.iconFail} aria-label="Blocked" />;
  if (tone === 'progress')
    return <LoaderCircle size={16} className={s.iconWork} aria-label="In progress" />;
  return <CircleDashed size={16} className={s.iconTodo} aria-label="Not started" />;
}
