import type { ReactNode } from 'react';
import { ExternalLink, GitBranch } from 'lucide-react';
import {
  deriveStatus,
  type HelixEvent,
  type ProjectState,
  type SessionState,
} from '@helix/contracts';
import { ActorBadge, AgentEmblem, StatusPill, cx } from '@helix/ui';
import { describeEvent, eventTone, provenance, provenanceLabel } from '../data/describe';
import {
  activityFeed,
  agentLabel,
  durationMs,
  formatDuration,
  planSummary,
  sessionTimings,
  type PlanTree,
} from '../data/observatory';
import type { Page } from './Chrome';
import { TONE_VAR } from './Dock';
import { identityFor, resolveProjectIdentities } from '../data/identity';
import s from './Pages.module.css';

interface PageProps {
  page: Exclude<Page, 'sessions'>;
  state: ProjectState;
  events: readonly HelixEvent[];
  index: number;
  tree: PlanTree | undefined;
  onOpen: (sessionId: string, tab?: string) => void;
  onSeek: (index: number) => void;
  onPage: (p: Page) => void;
}

const workers = (state: ProjectState) =>
  Object.values(state.sessions).filter((x) => x.session.role === 'worker');

export function NavPage(props: PageProps) {
  switch (props.page) {
    case 'overview':
      return <Overview {...props} />;
    case 'tasks':
      return <Tasks {...props} />;
    case 'agents':
      return <Agents {...props} />;
    case 'prs':
      return <PullRequests {...props} />;
    case 'ci':
      return <Ci {...props} />;
    case 'knowledge':
      return <Knowledge {...props} />;
  }
}

function Frame({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <div className={s.page}>
      <header className={s.head}>
        <h1>{title}</h1>
        <p>{lead}</p>
      </header>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------- overview */
function Overview({ state, events, index, tree, onOpen, onSeek, onPage }: PageProps) {
  const ws = workers(state);
  const count = (pred: (x: SessionState) => boolean) => ws.filter(pred).length;
  const sum = tree ? planSummary(tree) : undefined;
  const tiles = [
    { label: 'Working', value: count((x) => deriveStatus(x) === 'working'), tone: 'working' },
    {
      label: 'Needs you',
      value:
        count((x) => deriveStatus(x) === 'needs_you') +
        (tree?.plan.status === 'awaiting_approval' ? 1 : 0),
      tone: 'needs',
    },
    {
      label: 'In review',
      value: count((x) =>
        ['in_review', 'ready_to_merge', 'ci_failed', 'changes_requested'].includes(deriveStatus(x)),
      ),
      tone: 'review',
    },
    { label: 'Merged', value: count((x) => deriveStatus(x) === 'merged'), tone: 'ready' },
  ];
  return (
    <Frame
      title="Overview"
      lead={`${state.project.name}: what is running, what needs you, and what just happened.`}
    >
      <div className={s.tiles}>
        {tiles.map((t) => (
          <div key={t.label} className={s.tile} data-tone={t.tone}>
            <span className={s.tileValue}>{t.value}</span>
            <span className={s.tileLabel}>{t.label}</span>
          </div>
        ))}
      </div>
      {tree && sum && (
        <section className={s.card}>
          <div className={s.cardHead}>
            <h2>Current plan</h2>
            <button type="button" className={s.link} onClick={() => onPage('sessions')}>
              Open session →
            </button>
          </div>
          <p className={s.lead}>{tree.plan.goal}</p>
          <p className={s.meta}>
            {sum.tasks} tasks · {tree.agents.map((a) => agentLabel(a.agent)).join(' + ')} ·{' '}
            {sum.prsMerged}/{sum.tasks} merged · {formatDuration(sum.elapsedMs)} ·{' '}
            {tree.orchestrator.statusLabel.toLowerCase()}
          </p>
        </section>
      )}
      <section className={s.card}>
        <h2>Latest activity</h2>
        <ol className={s.feed}>
          {activityFeed(events, index, state, 10).map((f) => (
            <li key={f.seq}>
              <button type="button" onClick={() => onSeek(f.index)}>
                <span className={s.dot} style={{ background: TONE_VAR[f.tone] }} />
                <span className={s.grow}>{f.text}</span>
                <span className={s.seq}>#{f.seq}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>
      <section className={s.card}>
        <h2>Agents</h2>
        <div className={s.agentRow}>
          {(tree?.agents ?? []).map((a) => (
            <button
              key={a.agent}
              type="button"
              className={s.agentMini}
              onClick={() => onPage('agents')}
            >
              <AgentEmblem agent={a.agent} active={a.active} size={36} />
              <span>
                <strong>{agentLabel(a.agent)} provider</strong>
                <span className={s.meta}>
                  {a.statusLabel} · {a.tasks.length} tasks
                </span>
              </span>
            </button>
          ))}
          {!tree &&
            ws.map((w) => (
              <button
                key={w.session.id}
                type="button"
                className={s.agentMini}
                onClick={() => onOpen(w.session.id)}
              >
                <AgentEmblem
                  agent={w.session.agent}
                  active={deriveStatus(w) === 'working'}
                  size={36}
                />
                <span>
                  <strong title={w.session.id}>{identityFor(state, w.session.id)?.name}</strong>
                  <span className={s.meta}>{w.session.title}</span>
                </span>
              </button>
            ))}
        </div>
      </section>
    </Frame>
  );
}

/* -------------------------------------------------------------- tasks */
function Tasks({ state, tree, onOpen }: PageProps) {
  const planned = tree?.tasks ?? [];
  const extra = workers(state).filter(
    (w) => !planned.some((t) => t.session?.session.id === w.session.id),
  );
  return (
    <Frame title="Tasks" lead="Every task in this project, with who owns it and where it stands.">
      <table className={s.table}>
        <thead>
          <tr>
            <th>#</th>
            <th>Task</th>
            <th>Agent</th>
            <th>Status</th>
            <th>Branch</th>
            <th>Changes</th>
            <th>PR</th>
            <th>CI</th>
          </tr>
        </thead>
        <tbody>
          {planned.map((t) => (
            <tr
              key={t.node.id}
              className={cx(t.session && s.clickable)}
              onClick={() => t.session && onOpen(t.session.session.id)}
            >
              <td className={s.mono}>{t.number}</td>
              <td>
                <strong>{t.node.title}</strong>
                <span className={s.sub}>{t.node.description || t.node.rationale}</span>
              </td>
              <td>
                <ActorBadge
                  name={resolveProjectIdentities(state).nodes.get(t.node.id)!.name}
                  role="author"
                  agent={t.session?.session.agent ?? t.node.agent}
                  title={t.node.id}
                  active={t.status === 'working'}
                />
              </td>
              <td>
                <StatusPill status={t.status} />
              </td>
              <td className={s.mono}>{t.session?.session.branch ?? '—'}</td>
              <td className={s.mono}>
                {t.insertions !== undefined ? (
                  <>
                    <span className={s.add}>+{t.insertions}</span>{' '}
                    <span className={s.del}>−{t.deletions}</span>
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td className={s.mono}>{t.pr ? `#${t.pr}` : '—'}</td>
              <td className={s.mono}>{t.checks ? `${t.checks.passed}/${t.checks.total}` : '—'}</td>
            </tr>
          ))}
          {extra.map((w, i) => (
            <tr key={w.session.id} className={s.clickable} onClick={() => onOpen(w.session.id)}>
              <td className={s.mono}>{planned.length + i + 1}</td>
              <td>
                <strong>{w.session.title}</strong>
                <span className={s.sub}>Standalone task</span>
              </td>
              <td>
                <ActorBadge
                  {...identityFor(state, w.session.id)!}
                  title={w.session.id}
                  active={deriveStatus(w) === 'working'}
                />
              </td>
              <td>
                <StatusPill status={deriveStatus(w)} />
              </td>
              <td className={s.mono}>{w.session.branch ?? '—'}</td>
              <td className={s.mono}>
                {w.worktree?.diff ? (
                  <>
                    <span className={s.add}>+{w.worktree.diff.insertions}</span>{' '}
                    <span className={s.del}>−{w.worktree.diff.deletions}</span>
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td className={s.mono}>{w.pr ? `#${w.pr.number}` : '—'}</td>
              <td className={s.mono}>
                {w.pr ? `${w.pr.checks.passed}/${w.pr.checks.total}` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {planned.length + extra.length === 0 && (
        <p className={s.empty}>No tasks yet. Start one from Tasks ▾ → New task.</p>
      )}
    </Frame>
  );
}

/* -------------------------------------------------------------- agents */
function Agents({ state, events, index, tree, onOpen }: PageProps) {
  const timings = sessionTimings(events, index);
  const kinds = [
    ...new Set(
      workers(state)
        .map((w) => w.session.agent)
        .concat(tree?.agents.map((a) => a.agent) ?? []),
    ),
  ];
  return (
    <Frame
      title="Agents"
      lead="The agents working in this project. Each works on its own branch; Helix commits for them and routes CI back."
    >
      <div className={s.agentGrid}>
        {kinds.map((agent) => {
          const mine = workers(state).filter((w) => w.session.agent === agent);
          const view = tree?.agents.find((a) => a.agent === agent);
          const active = mine.some((w) => deriveStatus(w) === 'working');
          const merged = mine.filter((w) => deriveStatus(w) === 'merged').length;
          const ciPassed = mine.reduce((n, w) => n + (w.pr?.checks.passed ?? 0), 0);
          const ciTotal = mine.reduce((n, w) => n + (w.pr?.checks.total ?? 0), 0);
          const timeMs = mine.reduce((n, w) => {
            const t = timings.get(w.session.id);
            return n + durationMs(t?.start, t?.merged ?? t?.end);
          }, 0);
          const reviews = Object.values(state.sessions).filter(
            (x) => x.session.role === 'reviewer' && x.session.agent === agent,
          ).length;
          return (
            <section key={agent} className={s.agentCard} data-active={active || undefined}>
              <AgentEmblem agent={agent} active={active} size={64} />
              <h2>{agentLabel(agent)} provider</h2>
              <p className={s.meta}>
                {active
                  ? 'Working now'
                  : (view?.statusLabel ?? (mine.length ? 'Idle' : 'Not used yet'))}
              </p>
              <dl className={s.stats}>
                <dt>Tasks</dt>
                <dd>{mine.length}</dd>
                <dt>Merged</dt>
                <dd>{merged}</dd>
                <dt>CI</dt>
                <dd>{ciTotal ? `${ciPassed}/${ciTotal} passed` : '—'}</dd>
                <dt>Reviews given</dt>
                <dd>{reviews}</dd>
                <dt>Time</dt>
                <dd>{timeMs ? formatDuration(timeMs) : '—'}</dd>
              </dl>
              <ul className={s.agentTasks}>
                {mine.map((w) => (
                  <li key={w.session.id}>
                    <button type="button" onClick={() => onOpen(w.session.id)}>
                      <StatusPill status={deriveStatus(w)} variant="inline" />
                      <span>
                        <ActorBadge {...identityFor(state, w.session.id)!} title={w.session.id} /> ·{' '}
                        {w.session.title}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Frame>
  );
}

/* -------------------------------------------------------------- pull requests */
function PullRequests({ state, onOpen }: PageProps) {
  const prs = workers(state).filter((w) => w.pr);
  return (
    <Frame
      title="Pull requests"
      lead="Every PR an agent opened. Helix watches CI and reviews, and nothing merges without your click."
    >
      {prs.length === 0 ? (
        <p className={s.empty}>No pull requests yet. Agents open one when they finish a task.</p>
      ) : (
        <table className={s.table}>
          <thead>
            <tr>
              <th>PR</th>
              <th>Task</th>
              <th>Agent</th>
              <th>Status</th>
              <th>Checks</th>
              <th>Review</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {prs.map((w) => (
              <tr
                key={w.session.id}
                className={s.clickable}
                onClick={() => onOpen(w.session.id, 'pr')}
              >
                <td className={s.mono}>#{w.pr!.number}</td>
                <td>
                  <strong>{w.session.title}</strong>
                  <span className={s.sub}>
                    <GitBranch size={11} aria-hidden /> {w.session.branch}
                  </span>
                </td>
                <td>
                  <ActorBadge {...identityFor(state, w.session.id)!} title={w.session.id} />
                </td>
                <td>
                  <StatusPill status={deriveStatus(w)} />
                </td>
                <td className={s.mono}>
                  {w.pr!.checks.passed}/{w.pr!.checks.total}
                  {w.pr!.checks.failed > 0 && (
                    <span className={s.del}> · {w.pr!.checks.failed} failed</span>
                  )}
                </td>
                <td>
                  {w.agentReview
                    ? `Agent review: ${w.agentReview.status.replace('_', ' ')}`
                    : w.pr!.review.decision.replace(/_/g, ' ')}
                </td>
                <td>
                  <a
                    href={w.pr!.url}
                    target="_blank"
                    rel="noreferrer"
                    className={s.link}
                    onClick={(e) => e.stopPropagation()}
                  >
                    GitHub <ExternalLink size={11} aria-hidden />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Frame>
  );
}

/* -------------------------------------------------------------- CI */
function Ci({ state, events, index, onSeek }: PageProps) {
  const runs = events
    .slice(0, index + 1)
    .map((e, i) => ({ e, i }))
    .filter(
      ({ e }) => e.type === 'ci.updated' || e.type === 'feedback.routed' || e.type === 'pr.merged',
    )
    .reverse();
  return (
    <Frame
      title="CI / Deployments"
      lead="Every check run Helix saw, every failure it sent back to the agent that owns the branch, and every merge."
    >
      {runs.length === 0 ? (
        <p className={s.empty}>No CI activity yet.</p>
      ) : (
        <ol className={s.feed} data-big>
          {runs.map(({ e, i }) => (
            <li key={e.seq}>
              <button type="button" onClick={() => onSeek(i)}>
                <span className={s.dot} style={{ background: TONE_VAR[eventTone(e)] }} />
                <span className={s.grow}>{describeEvent(e, state)}</span>
                <span className={s.seq}>{new Date(e.ts).toLocaleTimeString()}</span>
                <span className={s.seq}>#{e.seq}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className={s.note}>
        Deployments aren’t tracked for this repository. Helix records CI from GitHub checks on each
        agent’s pull request.
      </p>
    </Frame>
  );
}

/* -------------------------------------------------------------- knowledge */
function Knowledge({ state, events, index, tree, onSeek }: PageProps) {
  const notes = events
    .slice(0, index + 1)
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === 'explain.note' || e.type === 'reasoning.summary');
  return (
    <Frame
      title="Knowledge"
      lead="What this run decided and why: the plan’s reasoning, acceptance criteria, and the notes recorded along the way. Every entry says where it came from."
    >
      {tree && (
        <section className={s.card}>
          <h2>The plan’s reasoning</h2>
          <span className={s.source} data-source="plan">
            {provenanceLabel.plan}
          </span>
          {tree.tasks.map((t) => (
            <div key={t.node.id} className={s.knowledgeItem}>
              <strong>
                Task {t.number} · {t.node.title}{' '}
                <ActorBadge
                  name={resolveProjectIdentities(state).nodes.get(t.node.id)!.name}
                  role="author"
                  agent={t.session?.session.agent ?? t.node.agent}
                  title={t.node.id}
                />
              </strong>
              <p>{t.node.rationale}</p>
              {t.node.acceptance.length > 0 && (
                <ul>
                  {t.node.acceptance.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      )}
      <section className={s.card}>
        <h2>Decisions and notes</h2>
        {notes.length === 0 && <p className={s.empty}>No notes recorded yet.</p>}
        <ol className={s.feed} data-big>
          {notes.map(({ e, i }) => (
            <li key={e.seq}>
              <button type="button" onClick={() => onSeek(i)}>
                <span className={s.source} data-source={provenance(e, state)}>
                  {provenanceLabel[provenance(e, state)]}
                </span>
                <span className={s.grow}>{describeEvent(e, state)}</span>
                <span className={s.seq}>#{e.seq}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </Frame>
  );
}
