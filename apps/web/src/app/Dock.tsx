import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import {
  ArrowRight,
  ChevronRight,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  StepBack,
  StepForward,
  Workflow,
} from 'lucide-react';
import { whyChain, type HelixEvent, type ProjectState } from '@helix/contracts';
import { HelixLogo, ActorBadge, AgentBadge, AgentEmblem, Dialog, IconButton, cx } from '@helix/ui';
import {
  describeEvent,
  eventTone,
  provenance,
  provenanceLabel,
  type EventTone,
} from '../data/describe';
import {
  activityFeed,
  ganttLanes,
  planTree,
  narratedEvent,
  type PlanTree,
} from '../data/observatory';
import { eventIndexAtTime, timelineMilestones } from '../data/timeline';
import type { RunView } from '../data/useRun';
import type { HelixSource } from '../data/useHelixSource';
import { REPLAY_SPEEDS, type ReplaySpeed } from '../data/useDemoStream';
import { historicalActorName, identityFor, traceLabel } from '../data/identity';
import s from './Dock.module.css';

export const TONE_VAR: Record<EventTone, string> = {
  plan: 'var(--strand-orchestrator)',
  work: 'var(--status-working)',
  needs: 'var(--status-needs)',
  failed: 'var(--status-failed)',
  feedback: 'var(--strand-claude)',
  review: 'var(--status-review)',
  done: 'var(--status-ready)',
  quiet: 'var(--border-strong)',
};

const clock = (ms: number) => {
  const secs = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const sec = secs % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

const axisLabel = (ms: number, span: number) => {
  if (span < 10 * 60000) {
    const secs = Math.round(ms / 1000);
    return secs < 60
      ? `${secs}s`
      : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
  }
  const mins = Math.round(ms / 60000);
  if (mins < 1) return `${Math.round(ms / 1000)}s`;
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`;
};

type DockTab = 'activity' | 'logs' | 'timeline' | 'artifacts';

/**
 * Concept 3 bottom dock. The Why strip narrates the moment under the cursor; the tabs hold the
 * Gantt timeline (one lane per orchestrator, agent and task), the activity feed, the raw run log and
 * the run's artifacts. Scrubbing anywhere replays the whole screen; it never touches files.
 */
export function Dock({
  run,
  source,
  tree,
  expanded,
  onExpand,
  onSelectSession,
}: {
  run: RunView;
  source: HelixSource;
  tree: PlanTree | undefined;
  expanded: boolean;
  onExpand: (v: boolean) => void;
  onSelectSession: (id: string) => void;
}) {
  const [tab, setTab] = useState<DockTab>('timeline');
  const [why, setWhy] = useState<HelixEvent>();
  const { events, index, state, isLive } = run;
  const narrated = narratedEvent(events, index);
  const cause = narrated.causedBy !== undefined ? run.bySeq.get(narrated.causedBy) : undefined;
  const live = source.mode === 'live';
  const elapsed = Date.parse(run.current.ts) - Date.parse(events[0]!.ts);

  return (
    <section className={s.dock} data-expanded={expanded || undefined} aria-label="Run timeline">
      {/* Why strip */}
      <div className={s.strip} aria-live="polite">
        <span className={s.whyTag}>Why</span>
        <span className={s.seq}>#{narrated.seq}</span>
        <span className={s.dot} style={{ background: TONE_VAR[eventTone(narrated)] }} />
        <p className={s.sentence}>
          {describeEvent(narrated, state)}
          <span className={s.stripMeta}>
            {narrated.type}
            {cause && ` · caused by #${cause.seq} ${cause.type}`}
            {' · '}
            {provenanceLabel[provenance(narrated, state)]}
          </span>
        </p>
        <button type="button" className={s.whyButton} onClick={() => setWhy(narrated)}>
          Ask why <ChevronRight size={13} aria-hidden />
        </button>
      </div>

      <div className={s.head}>
        <div className={s.tabs} role="tablist" aria-label="Dock views">
          {(
            [
              ['activity', 'Activity'],
              ['logs', 'Run logs'],
              ['timeline', 'Timeline'],
              ['artifacts', 'Artifacts'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={tab === v}
              className={cx(s.tab, tab === v && s.tabActive)}
              onClick={() => setTab(v)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={s.controls}>
          <IconButton
            label="Previous event"
            shortcut="["
            size="sm"
            icon={<StepBack size={14} />}
            disabled={index === 0}
            onClick={() => run.step(-1)}
          />
          <IconButton
            label="Next event"
            shortcut="]"
            size="sm"
            icon={<StepForward size={14} />}
            disabled={index === events.length - 1}
            onClick={() => run.step(1)}
          />
          <span className={s.clock} title={`Event ${index + 1} of ${events.length}`}>
            {clock(elapsed)} / {clock(Date.parse(events.at(-1)!.ts) - Date.parse(events[0]!.ts))}
          </span>
          {live ? (
            <button
              type="button"
              role="switch"
              aria-checked={isLive}
              className={s.liveSwitch}
              onClick={() => (isLive ? run.seek(index) : run.goLive())}
              title="Follow new live events"
            >
              <span className={s.switchTrack} data-on={isLive || undefined}>
                <span className={s.switchThumb} />
              </span>
              {isLive ? 'Live' : 'Go live'}
            </button>
          ) : (
            <button
              type="button"
              className={s.replay}
              onClick={() => run.seek(events.length - 1)}
              disabled={index === events.length - 1}
              aria-label="Jump to end"
            >
              End
            </button>
          )}
          <select
            className={s.speed}
            aria-label="Replay speed"
            value={String(source.speed)}
            onChange={(e) => source.setSpeed(Number(e.target.value) as ReplaySpeed)}
          >
            {REPLAY_SPEEDS.map((x) => (
              <option key={x} value={x}>
                {x}x
              </option>
            ))}
          </select>
          <button type="button" className={s.replay} onClick={run.togglePlay}>
            {run.playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
            {run.playing ? 'Pause' : index === events.length - 1 ? 'Replay' : 'Play'}
          </button>
          <IconButton
            label={expanded ? 'Shrink timeline' : 'Expand timeline'}
            size="sm"
            icon={expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            onClick={() => onExpand(!expanded)}
          />
        </div>
      </div>

      <div className={s.body}>
        {tab === 'timeline' && <Gantt run={run} onSelectSession={onSelectSession} />}
        {tab === 'activity' && (
          <ol className={s.feed}>
            {activityFeed(events, index, state).map((f) => {
              const sess = f.sessionId
                ? state.sessions[f.sessionId as keyof typeof state.sessions]
                : undefined;
              return (
                <li key={f.seq}>
                  <button
                    type="button"
                    onClick={() => run.seek(f.index)}
                    data-current={f.index === index || undefined}
                  >
                    <span className={s.feedTime}>
                      {clock(Date.parse(f.ts) - Date.parse(events[0]!.ts))}
                    </span>
                    <span className={s.dot} style={{ background: TONE_VAR[f.tone] }} />
                    {sess && sess.session.role !== 'orchestrator' ? (
                      <AgentBadge agent={sess.session.agent} variant="glyph" />
                    ) : (
                      <HelixLogo size={14} className={s.helixIcon} />
                    )}
                    <span className={s.feedText}>{f.text}</span>
                    <span className={s.feedSeq}>#{f.seq}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {tab === 'logs' && <RunLog run={run} />}
        {tab === 'artifacts' && <Artifacts state={state} source={source} tree={tree} />}
      </div>

      <WhyOverlay
        event={why}
        run={run}
        onClose={() => setWhy(undefined)}
        onPick={(e) => setWhy(e)}
      />
    </section>
  );
}

/* ---------------------------------------------------------------- Gantt */

function Gantt({ run, onSelectSession }: { run: RunView; onSelectSession: (id: string) => void }) {
  const { events, index, state, latestState } = run;
  // History remains visible when scrubbing; only the playhead follows the cursor.
  const { lanes, startTs, endTs } = useMemo(() => {
    const last = events.length - 1;
    const fullTree = planTree(latestState, events, last, events[last]!.ts);
    return ganttLanes(events, last, latestState, fullTree);
  }, [events, latestState]);
  const cursorAt = Math.max(
    0,
    Math.min(1, (Date.parse(run.current.ts) - startTs) / (endTs - startTs)),
  );
  const milestones = useMemo(() => timelineMilestones(events), [events]);
  const chart = useRef<HTMLDivElement>(null);
  const span = endTs - startTs;
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];

  const seekToX = (clientX: number) => {
    const el = chart.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const t = startTs + frac * span;
    run.seek(eventIndexAtTime(events, t));
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const mark = (e.target as HTMLElement).closest<HTMLElement>('[data-event-index]');
    if (mark) run.seek(Number(mark.dataset.eventIndex));
    else seekToX(e.clientX);
  };
  const onMove = (e: PointerEvent) => {
    if (e.buttons === 1 && (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId))
      seekToX(e.clientX);
  };

  return (
    <div className={s.gantt}>
      <div className={s.axisRow}>
        <div className={s.laneHead}>
          <select
            className={s.milestones}
            aria-label="Jump to milestone"
            value={milestones.includes(index) ? String(index) : ''}
            onChange={(e) => {
              if (e.target.value) run.seek(Number(e.target.value));
            }}
          >
            <option value="" disabled>
              Jump to milestone…
            </option>
            {milestones.map((i) => (
              <option key={events[i]!.seq} value={i}>
                {clock(Date.parse(events[i]!.ts) - startTs)} ·{' '}
                {describeEvent(events[i]!, latestState)}
              </option>
            ))}
          </select>
        </div>
        <div className={s.axis}>
          {ticks.map((f) => (
            <span key={f} style={{ left: `${f * 100}%` }}>
              {axisLabel(f * span, span)}
            </span>
          ))}
          <input
            type="range"
            className={s.range}
            min={startTs}
            max={endTs}
            value={Date.parse(run.current.ts)}
            onChange={(e) => run.seek(eventIndexAtTime(events, Number(e.target.value)))}
            onKeyDown={(e) => {
              if (
                ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(e.key)
              ) {
                e.preventDefault();
                if (e.key === 'Home') run.seek(0);
                else if (e.key === 'End') run.seek(events.length - 1);
                else run.step(e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1);
              }
            }}
            aria-label="Timeline position"
            aria-valuetext={`Event ${run.current.seq}: ${describeEvent(run.current, state)}`}
          />
        </div>
      </div>
      <div className={s.lanes}>
        <div className={s.labels}>
          {lanes.map((l) => (
            <button
              key={l.id}
              type="button"
              className={s.laneLabel}
              title={`${l.label} · ${l.sessionId ? l.sessionId + ' · ' : ''}${l.id}`}
              data-kind={l.kind}
              disabled={!l.sessionId}
              onClick={() => {
                if (!l.sessionId) return;
                if (!state.sessions[l.sessionId as keyof typeof state.sessions]) {
                  const created = events.findIndex(
                    (e) => e.sessionId === l.sessionId && e.type === 'session.created',
                  );
                  if (created >= 0) run.seek(created);
                }
                onSelectSession(l.sessionId);
              }}
            >
              {l.kind === 'orchestrator' ? (
                <HelixLogo size={14} className={s.orchIcon} />
              ) : l.kind === 'agent' && l.agent ? (
                <AgentEmblem agent={l.agent} size={18} />
              ) : (
                <span
                  className={s.taskDot}
                  style={{
                    background:
                      l.agent === 'codex' ? 'var(--strand-codex)' : 'var(--strand-claude)',
                  }}
                />
              )}
              <span className={s.laneName}>{l.label}</span>
              {l.sublabel && <span className={s.laneSub}>{l.sublabel}</span>}
            </button>
          ))}
        </div>
        <div
          className={s.chart}
          ref={chart}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          role="presentation"
        >
          {ticks.map((f) => (
            <span key={f} className={s.grid} style={{ left: `${f * 100}%` }} />
          ))}
          {lanes.map((l) => (
            <div key={l.id} className={s.lane} data-kind={l.kind}>
              {l.bars.map((b, i) => (
                <span
                  key={i}
                  className={s.bar}
                  data-tone={b.tone}
                  data-lane={l.kind}
                  style={
                    {
                      left: `${b.from * 100}%`,
                      width: `${Math.max(0.4, (b.to - b.from) * 100)}%`,
                      '--lane':
                        l.kind === 'orchestrator'
                          ? 'var(--strand-orchestrator)'
                          : l.agent === 'codex'
                            ? 'var(--strand-codex)'
                            : 'var(--strand-claude)',
                    } as CSSProperties
                  }
                />
              ))}
              {l.kind !== 'task' || l.marks.length < 40
                ? l.marks.map((m) => (
                    <button
                      key={m.seq}
                      type="button"
                      className={s.mark}
                      style={
                        { left: `${m.at * 100}%`, '--mark': TONE_VAR[m.tone] } as CSSProperties
                      }
                      title={`#${m.seq} · ${m.text}`}
                      aria-label={`Event ${m.seq}: ${m.text}`}
                      data-current={m.index === index || undefined}
                      data-event-index={m.index}
                      onClick={(e) => {
                        if (e.detail === 0) run.seek(m.index);
                      }}
                    />
                  ))
                : null}
            </div>
          ))}
          <span className={s.now} style={{ left: `${cursorAt * 100}%` }} aria-hidden>
            <span className={s.nowHead} />
          </span>
        </div>
      </div>
      <p className={s.legend}>
        <span>
          <i data-k="solid" /> recorded work
        </span>
        <span>
          <i data-k="dash" /> planned, not started
        </span>
        <span>
          <i data-k="mark" /> event (click to jump)
        </span>
        <span>
          <i data-k="now" /> the moment on screen
        </span>
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- run log */

function RunLog({ run }: { run: RunView }) {
  const { events, index, state } = run;
  const start = Date.parse(events[0]!.ts);
  const rows = events.slice(Math.max(0, index - 199), index + 1).reverse();
  return (
    <ol className={s.log}>
      {rows.map((e) => {
        const sess = e.sessionId ? state.sessions[e.sessionId] : undefined;
        return (
          <li key={e.seq}>
            <button type="button" onClick={() => run.seek(events.indexOf(e))}>
              <span className={s.logSeq}>#{e.seq}</span>
              <span className={s.logTime}>{clock(Date.parse(e.ts) - start)}</span>
              <span
                className={s.logType}
                style={{
                  color:
                    TONE_VAR[eventTone(e)] === 'var(--border-strong)'
                      ? undefined
                      : TONE_VAR[eventTone(e)],
                }}
              >
                {e.type}
              </span>
              <span className={s.logWho} title={e.sessionId}>
                {sess?.session.role === 'orchestrator' && <HelixLogo size={14} />}
                {historicalActorName(state, e) ??
                  (sess ? identityFor(state, sess.session.id)?.name : 'Helix')}
              </span>
              <span className={s.logText}>{describeEvent(e, state)}</span>
              {e.causedBy !== undefined && <span className={s.logCause}>← #{e.causedBy}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------------------------------------------------------------- artifacts */

function Artifacts({
  state,
  source,
  tree,
}: {
  state: ProjectState;
  source: HelixSource;
  tree: PlanTree | undefined;
}) {
  const sessions = Object.values(state.sessions).filter((x) => x.session.role === 'worker');
  const prs = sessions.filter((x) => x.pr);
  const branches = sessions.filter((x) => x.session.branch);
  return (
    <div className={s.artifacts}>
      <section>
        <h4>Pull requests</h4>
        {prs.length === 0 && <p className={s.empty}>No pull requests yet.</p>}
        {prs.map((x) => (
          <a
            key={x.session.id}
            href={x.pr!.url}
            target="_blank"
            rel="noreferrer"
            className={s.artifact}
          >
            <GitPullRequest size={14} aria-hidden />
            <span>
              #{x.pr!.number} · {x.session.title}
            </span>
            <span className={s.artifactMeta}>{x.pr!.state}</span>
            <ExternalLink size={12} aria-hidden />
          </a>
        ))}
      </section>
      <section>
        <h4>Branches</h4>
        {branches.length === 0 && <p className={s.empty}>No branches yet.</p>}
        {branches.map((x) => (
          <span key={x.session.id} className={s.artifact}>
            <GitBranch size={14} aria-hidden />
            <span className={s.mono}>{x.session.branch}</span>
            <ActorBadge
              {...identityFor(state, x.session.id)!}
              title={traceLabel(identityFor(state, x.session.id)!)}
            />
          </span>
        ))}
      </section>
      <section>
        <h4>Plan &amp; recording</h4>
        {tree ? (
          <span className={s.artifact}>
            <Workflow size={14} aria-hidden />
            <span>
              Plan · {tree.tasks.length} tasks · {tree.plan.status.replace('_', ' ')}
            </span>
          </span>
        ) : (
          <p className={s.empty}>No plan in this run.</p>
        )}
        {source.recording && (
          <span className={s.artifact}>
            <Play size={14} aria-hidden />
            <span className={s.mono}>{source.recording.name}.helixlog</span>
          </span>
        )}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- Why overlay */

/**
 * "Ask why. Get the whole chain." The event, what caused it (back to the plan), and what it led
 * to, as linked steps. Every step says where it comes from; clicking one replays to that moment.
 */
function WhyOverlay({
  event,
  run,
  onClose,
  onPick,
}: {
  event: HelixEvent | undefined;
  run: RunView;
  onClose: () => void;
  onPick: (e: HelixEvent) => void;
}) {
  const { events, state } = run;
  const chain = useMemo(() => {
    if (!event) return [];
    const causes = whyChain(events, event.seq).slice(1);
    const planAt = causes.findIndex((e) => e.type === 'plan.submitted');
    const trimmed = (planAt === -1 ? causes : causes.slice(0, planAt + 1)).reverse();
    const effects: HelixEvent[] = [];
    let frontier = [event.seq];
    while (frontier.length && effects.length < 4) {
      const next = events.filter((e) => e.causedBy !== undefined && frontier.includes(e.causedBy));
      effects.push(...next.slice(0, 4 - effects.length));
      frontier = next.map((e) => e.seq);
    }
    return [
      ...trimmed.map((e) => ({ e, role: 'cause' as const })),
      { e: event, role: 'this' as const },
      ...effects.map((e) => ({ e, role: 'effect' as const })),
    ];
  }, [event, events]);

  if (!event) return null;
  const cause = event.causedBy !== undefined ? run.bySeq.get(event.causedBy) : undefined;
  return (
    <Dialog
      open={Boolean(event)}
      onOpenChange={(o) => !o && onClose()}
      wide
      title={
        <span className={s.whyTitle}>
          <span className={s.whyLabel}>Why · event #{event.seq}</span>
          {describeEvent(event, state)}
        </span>
      }
      description={
        <span className={s.whyMeta}>
          {event.type}
          {cause
            ? ` · caused by #${cause.seq} ${describeEvent(cause, state)}`
            : ' · no recorded cause'}
          {' · '}
          {provenanceLabel[provenance(event, state)]}
        </span>
      }
    >
      <ol className={s.chain}>
        {chain.map(({ e, role }, i) => (
          <li key={e.seq} className={s.chainItem}>
            <button
              type="button"
              className={s.step}
              data-role={role}
              style={{ '--mark': TONE_VAR[eventTone(e)] } as CSSProperties}
              onClick={() => {
                run.seek(events.indexOf(e));
                if (role !== 'this') onPick(e);
              }}
            >
              <span className={s.stepSeq}>
                #{e.seq} · {e.type}
              </span>
              <span className={s.stepText}>{describeEvent(e, state)}</span>
              <span className={s.stepSource} data-source={provenance(e, state)}>
                {role === 'cause' ? 'Cause' : role === 'effect' ? 'Led to' : 'This event'} ·{' '}
                {provenanceLabel[provenance(e, state)]}
              </span>
            </button>
            {i < chain.length - 1 && <ArrowRight size={16} className={s.arrow} aria-hidden />}
          </li>
        ))}
      </ol>
      <p className={s.whyFoot}>
        Click a step to replay the whole project to that moment. Replay changes what you see, never
        files or branches.
      </p>
    </Dialog>
  );
}
