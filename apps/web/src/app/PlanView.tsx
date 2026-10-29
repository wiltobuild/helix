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
  Workflow,
  ShieldCheck,
  ScanEye,
} from 'lucide-react';
import type { HelixClient } from '@helix/api-client';
import {
  crossReviewerFor,
  deriveStatus,
  type HelixEvent,
  type ProjectState,
} from '@helix/contracts';
import { AgentEmblem, AgentBadge, Button, Tooltip, agentMeta, cx } from '@helix/ui';
import { describeEvent, provenanceLabel, statusLine } from '../data/describe';
import { crossReview, reviewerTarget, reviewSlot } from '../data/crossReview';
import {
  agentLabel,
  formatDuration,
  planTree,
  type AgentView,
  type WorkerView,
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
const ROW_GAP = 32;
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

type Group = { agent: WorkerView; x: number; width: number; cardsX: number[] };

function layout(assigned: WorkerView[]) {
  const agents: WorkerView[] = [...assigned];
  for (const agent of ['codex', 'claude-code'] as const) {
    if (!agents.some((entry) => entry.agent === agent))
      agents.push({
        id: `standby-${agent}`,
        title: 'Awaiting assignment',
        agent,
        tasks: [],
        active: false,
        statusLabel: 'Standing by',
        ciPassed: 0,
        ciTotal: 0,
        elapsedMs: 0,
        role: 'Awaiting assignment',
      });
  }
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
  const hasReviews = agents.some((agent) => agent.tasks.length > 0);
  const height = cardY + CARD_H + PAD + (hasReviews ? 290 : 0);
  return { groups, width, height, agentY, cardY };
}

/** Vertical S-curve from a node's bottom to another node's top. */
const drop = (x1: number, y1: number, x2: number, y2: number) => {
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
};

/**
 * Concept 3 plan view. The orchestrator's plan as a tree: the orchestrator on top (it waits for
 * your approval before anything runs), one node per task subagent, with its task and reviewer below. Edges carry
 * the agent's strand color and flow while work is moving along them. The graph scales to fit.
 */
export function PlanView(props: PlanViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef(new Map<string, { rect: DOMRect; element: HTMLElement }>());
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const next = new Map<string, { rect: DOMRect; element: HTMLElement }>();
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      root.current?.querySelectorAll<HTMLElement>('[data-motion-key]').forEach((element, index) => {
        const key = element.dataset.motionKey!;
        const old = previous.current.get(key);
        if (
          old?.element === element &&
          element.getAnimations().some((a) => a.playState === 'running')
        ) {
          next.set(key, old);
          return;
        }
        const rect = element.getBoundingClientRect();
        next.set(key, { rect, element });
        if (!rect.width || !rect.height || !previous.current.size) return;
        if (old && !reduced) {
          const dx = old.rect.x - rect.x;
          const dy = old.rect.y - rect.y;
          const sx = old.rect.width / rect.width;
          const sy = old.rect.height / rect.height;
          if (Math.abs(dx) + Math.abs(dy) < 1 && Math.abs(sx - 1) + Math.abs(sy - 1) < 0.01) return;
          const parentScale = rect.width / element.offsetWidth || 1;
          element.animate(
            [
              {
                transformOrigin: 'top left',
                transform:
                  'translate(' +
                  dx / parentScale +
                  'px, ' +
                  dy / parentScale +
                  'px) scale(' +
                  sx +
                  ', ' +
                  sy +
                  ')',
              },
              { transformOrigin: 'top left', transform: 'none' },
            ],
            { duration: 480, easing: 'cubic-bezier(.22, 1, .36, 1)' },
          );
        } else if (!old || old.element !== element) {
          element.animate(
            reduced
              ? [{ opacity: 0 }, { opacity: 1 }]
              : [
                  { opacity: 0, transform: 'translateY(14px)' },
                  { opacity: 1, transform: 'none' },
                ],
            {
              duration: reduced ? 120 : 360,
              delay: reduced ? 0 : Math.min(index * 35, 140),
              fill: 'backwards',
              easing: 'ease-out',
            },
          );
        }
      });
      previous.current = next;
    });
    return () => cancelAnimationFrame(frame);
  });
  return (
    <div className={s.workspace} ref={root}>
      <PlanCanvas {...props} />
    </div>
  );
}

function StandbyReviewer({ builder, motionKey }: { builder: string; motionKey: string }) {
  const reviewer = crossReviewerFor(builder) ?? 'reviewer';
  return (
    <div
      className={s.reviewerCard}
      data-review="standby"
      data-motion-key={motionKey}
      aria-label={agentLabel(reviewer) + ' reviewer standing by'}
    >
      <span className={s.reviewSeal}>
        <ScanEye size={28} aria-hidden />
        <span>REVIEW</span>
      </span>
      <AgentEmblem agent={reviewer} active={false} size={28} />
      <span className={s.reviewerCopy}>
        <span className={s.reviewerTag}>Code reviewer</span>
        <strong>{agentLabel(reviewer)}</strong>
        <span>Standing by</span>
        <span className={s.reviewTarget}>Reviews {agentLabel(builder)}’s work</span>
        <span className={s.reviewTarget}>Awaiting review assignment</span>
      </span>
    </div>
  );
}

function ReviewerCards({
  state,
  events = [],
  index,
  onSelect,
  selected,
  client,
  workerId,
}: PlanViewProps & { workerId: string }) {
  const reviewers = Object.values(state.sessions).filter(
    (entry) =>
      entry.session.role === 'reviewer' &&
      reviewerTarget(
        entry,
        state,
        events,
        events[index ?? events.length - 1]?.seq ?? Number.MAX_SAFE_INTEGER,
      )?.worker.session.id === workerId,
  );
  const workers = Object.values(state.sessions).filter(
    (entry) => entry.session.role === 'worker' && entry.session.id === workerId,
  );
  const unreviewed = workers.filter(
    (worker) =>
      !reviewers.some(
        (reviewer) =>
          reviewerTarget(
            reviewer,
            state,
            events,
            events[index ?? events.length - 1]?.seq ?? Number.MAX_SAFE_INTEGER,
          )?.worker.session.id === worker.session.id,
      ),
  );
  const upTo = events[index ?? events.length - 1]?.seq ?? Number.MAX_SAFE_INTEGER;
  return (
    <section className={s.reviewNodes} aria-label="Cross-agent reviewers">
      <div className={s.reviewCards}>
        {reviewers.map((entry) => {
          const target = reviewerTarget(entry, state, events, upTo);
          const review = target ? crossReview(target.worker, state) : undefined;
          const ownReview = review?.reviewerSessionId === entry.session.id ? review : undefined;
          const last = events
            .slice(0, index === undefined ? undefined : index + 1)
            .filter(
              (event) =>
                event.sessionId === entry.session.id && event.type === 'agent_review.abandoned',
            )
            .at(-1);
          const label = ownReview?.label ?? (last ? 'Review stopped' : 'Waiting for review');
          const active = ownReview?.status === 'reviewing' && entry.activity === 'active';
          return (
            <button
              type="button"
              key={entry.session.id}
              data-motion-key={entry.session.id}
              className={cx(s.reviewerCard, selected === entry.session.id && s.selected)}
              data-review={ownReview?.status ?? 'idle'}
              onClick={() => onSelect(entry.session.id)}
            >
              <span className={s.reviewSeal}>
                <ScanEye size={28} aria-hidden />
                <span>REVIEW</span>
              </span>
              <AgentEmblem agent={entry.session.agent} active={active} size={28} />
              <span className={s.reviewerCopy}>
                <span className={s.reviewerTag}>
                  <ShieldCheck size={12} aria-hidden />
                  Code reviewer
                </span>
                <strong>{agentLabel(entry.session.agent)}</strong>
                <span>{label}</span>
                <span className={s.reviewTarget}>
                  {target
                    ? 'Reviewing ' +
                      target.worker.session.title +
                      (target.prNumber ? ' · PR #' + target.prNumber : '')
                    : entry.session.title}
                </span>
              </span>
            </button>
          );
        })}
        {unreviewed.map((worker) => {
          const slot = reviewSlot(worker, state, Boolean(client));
          const recordedAgentReview = crossReview(worker, state);
          const github = worker.pr?.review;
          const recordedReview =
            github && github.decision !== 'none' && github.decision !== 'review_required';
          const agent = crossReviewerFor(worker.session.agent) ?? 'reviewer';
          return (
            <button
              type="button"
              key={'review-slot-' + worker.session.id}
              data-motion-key={'review-slot-' + worker.session.id}
              className={s.reviewerCard}
              data-review={slot.status}
              onClick={() => onSelect(worker.session.id)}
            >
              <span className={s.reviewSeal}>
                <ScanEye size={28} aria-hidden />
                <span>REVIEW</span>
              </span>
              <span className={s.reviewerCopy}>
                <span className={s.reviewerTag}>Code reviewer</span>
                <strong>
                  {recordedAgentReview
                    ? recordedAgentReview.name
                    : recordedReview
                      ? 'GitHub review'
                      : agentLabel(agent) + ' · review slot'}
                </strong>
                <span>{slot.label}</span>
                <span className={s.reviewTarget}>
                  {worker.session.title}
                  {worker.pr ? ' · PR #' + worker.pr.number : ''}
                </span>
                <span className={s.reviewTarget}>{slot.detail}</span>
              </span>
            </button>
          );
        })}
        {!reviewers.length && !workers.length && (
          <div className={s.reviewPlaceholder}>
            <ScanEye size={26} aria-hidden />
            <strong>Code reviewers standing by</strong>
            <span>Review assignments appear when work is ready.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function PlanCanvas({
  state,
  selected,
  onSelect,
  onReviewPlan,
  events,
  index,
  client,
}: PlanViewProps) {
  const nowIso = events && index !== undefined ? events[index]!.ts : new Date(0).toISOString();
  const tree = useMemo(
    () => planTree(state, events ?? [], events && index !== undefined ? index : -1, nowIso),
    [state, events, index, nowIso],
  );
  const graph = useMemo(() => (tree ? layout(tree.workers) : undefined), [tree]);
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el || !graph) return;
    const fit = () => {
      const w = el.clientWidth - 32;
      const h = el.clientHeight - 32;
      if (w <= 0 || h <= 0) return;
      setScale(Math.max(0.85, Math.min(w / graph.width, 1)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [graph]);

  if (!tree || !graph) {
    const orchestrator = Object.values(state.sessions)
      .filter((s) => s.session.role === 'orchestrator')
      .at(-1);
    const workers = Object.values(state.sessions).filter((s) => s.session.role === 'worker');
    const active = orchestrator ? deriveStatus(orchestrator) === 'working' : false;
    const label = orchestrator
      ? (statusLine(orchestrator, deriveStatus(orchestrator), state) ?? 'Waiting to start')
      : client
        ? 'Not assigned'
        : 'Not recorded';
    const recent = (events ?? [])
      .slice(0, index === undefined ? undefined : index + 1)
      .filter((e) => orchestrator && e.sessionId === orchestrator.session.id)
      .slice(-4);
    return (
      <div className={s.view}>
        <section className={s.planning} aria-label="Plan preparation">
          <button
            type="button"
            className={s.orch}
            data-motion-key="orchestrator"
            data-tone={active ? 'working' : 'idle'}
            disabled={!orchestrator}
            onClick={() => orchestrator && onSelect(orchestrator.session.id)}
          >
            <span className={s.orchHead}>
              <span className={s.orchIcon} data-active={active || undefined}>
                <Workflow size={20} aria-hidden />
              </span>
              <span className={s.orchName}>
                <strong>Orchestrator</strong>
                <span>{orchestrator?.session.title ?? 'Coordination'}</span>
              </span>
            </span>
            <span role="status">{label}</span>
            <span className={s.stats}>
              {orchestrator ? (
                <>
                  Open activity <ArrowRight size={14} aria-hidden />
                </>
              ) : (
                'No orchestrator session in this run'
              )}
            </span>
          </button>
          <div className={s.standbyAgents} aria-label="Agent team">
            {(['codex', 'claude-code'] as const)
              .flatMap((agent) => {
                const mine = workers.filter((worker) => worker.session.agent === agent);
                return (mine.length ? mine : [undefined]).map((worker) => ({ agent, worker }));
              })
              .map(({ agent, worker }) => {
                const assigned = worker ? [worker] : [];
                const working = assigned.some((worker) => deriveStatus(worker) === 'working');
                return (
                  <div key={worker?.session.id ?? agent} className={s.agentBranch}>
                    <div
                      className={s.standbyAgent}
                      data-motion-key={worker?.session.id ?? agent}
                      data-worker-session={worker?.session.id}
                      style={{ '--agent': agentMeta(agent).colorVar } as CSSProperties}
                    >
                      <AgentEmblem agent={agent} active={working} size={44} />
                      <span className={s.agentName}>
                        <strong>{agentLabel(agent)}</strong>
                        <span>
                          {assigned.length
                            ? 'Subagent · ' + assigned[0]!.session.title
                            : 'Awaiting assignment'}
                        </span>
                      </span>
                      <span className={s.pill} data-tone={working ? 'working' : 'idle'}>
                        {working ? 'Working' : assigned.length ? 'Assigned' : 'Standing by'}
                      </span>
                    </div>
                    {assigned.length === 0 && (
                      <div className={s.directTask}>
                        <StandbyReviewer builder={agent} motionKey={'standby-review-' + agent} />
                      </div>
                    )}
                    {assigned.map((worker) => (
                      <div className={s.directTask} key={worker.session.id}>
                        <button
                          type="button"
                          className={s.unplannedTask}
                          onClick={() => onSelect(worker.session.id)}
                        >
                          <strong>{worker.session.title}</strong>
                          <span>
                            {statusLine(worker, deriveStatus(worker), state) ??
                              deriveStatus(worker)}
                          </span>
                        </button>
                        <ReviewerCards
                          state={state}
                          selected={selected}
                          onSelect={onSelect}
                          workerId={worker.session.id}
                          {...(events ? { events } : {})}
                          {...(index !== undefined ? { index } : {})}
                          {...(client ? { client } : {})}
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
          </div>
          <div className={s.planningNext}>
            <strong>
              {orchestrator
                ? active
                  ? 'Preparing your plan'
                  : 'Plan not submitted yet'
                : 'Task activity'}
            </strong>
            <p>
              {orchestrator
                ? 'Tasks and agent assignments appear here when the orchestrator submits its plan. You review it before workers start.'
                : 'This run contains task activity without a submitted plan. Recorded work and reviews appear as they happen.'}
            </p>
          </div>
          {recent.length > 0 && (
            <ol className={s.planningEvents} aria-label="Recent planning activity">
              {recent.map((event) => (
                <li key={event.seq}>{describeEvent(event, state)}</li>
              ))}
            </ol>
          )}
        </section>
      </div>
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
              const approved = plan.status === 'approved' && g.agent.tasks.length > 0;
              return (
                <g key={g.agent.id} style={{ '--edge-strand': strand } as CSSProperties}>
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
              data-motion-key="orchestrator"
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
                key={a.id}
                className={s.agent}
                data-motion-key={a.id}
                data-worker-node={a.tasks.length ? a.id : undefined}
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
                aria-label={`${agentLabel(a.agent)} subagent: ${a.title} — ${a.statusLabel}`}
              >
                <span className={s.agentHead}>
                  <AgentEmblem agent={a.agent} active={a.active} size={44} />
                  <span className={s.agentName}>
                    <strong>
                      {agentLabel(a.agent)}
                      {a.tasks[0] ? ` · ${a.tasks[0].number}` : ''}
                    </strong>
                    <span title={a.title}>{a.title}</span>
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

          {/* Reviewer slots exist before workers start and become real review cards on assignment. */}
          {graph.groups.flatMap((g) =>
            g.agent.tasks.map((task, i) => (
              <div
                key={'review-' + task.node.id}
                className={s.reviewNodePosition}
                style={{ left: g.cardsX[i], top: graph.cardY + CARD_H + 44, width: CARD_W }}
              >
                {task.session ? (
                  <ReviewerCards
                    state={state}
                    selected={selected}
                    onSelect={onSelect}
                    workerId={task.session.session.id}
                    {...(events ? { events } : {})}
                    {...(index !== undefined ? { index } : {})}
                    {...(client ? { client } : {})}
                  />
                ) : (
                  <StandbyReviewer
                    builder={task.node.agent}
                    motionKey={'standby-review-' + task.node.id}
                  />
                )}
              </div>
            )),
          )}
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
        data-motion-key={t.node.id}
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
