import type { HelixEvent, ProjectState } from '@helix/contracts';
import { AgentEmblem } from '@helix/ui';
import { agentRoster } from '../data/agentRoster';
import { agentLabel, type PlanTree } from '../data/observatory';
import s from './AgentRoster.module.css';

export function AgentRoster({
  state,
  events,
  index,
  tree,
  onOpen,
}: {
  state: ProjectState;
  events: readonly HelixEvent[];
  index: number;
  tree: PlanTree | undefined;
  onOpen: (sessionId: string) => void;
}) {
  const roster = agentRoster(state, tree, events, index);
  if (!roster.length) return <p>No workers or reviewers yet at this point in the build.</p>;
  const providers = [...new Set(roster.map((a) => a.agent))];
  return (
    <>
      <p className={s.summary}>
        {roster.filter((a) => a.role === 'Worker').length} workers ·{' '}
        {roster.filter((a) => a.role === 'Reviewer').length} reviewers
        {' · '}
        {providers
          .map(
            (provider) =>
              `${agentLabel(provider)}: ${roster.filter((a) => a.agent === provider).length}`,
          )
          .join(' · ')}
      </p>
      <div className={s.grid}>
        {roster.map((actor) => (
          <article
            key={actor.id}
            className={s.card}
            data-active={actor.active || undefined}
            aria-label={`${actor.name} — ${actor.role}`}
          >
            <header className={s.header}>
              <AgentEmblem agent={actor.agent} active={actor.active} size={36} />
              <div>
                <h2>{actor.name}</h2>
                <p className={s.secondary}>
                  {actor.role} · {agentLabel(actor.agent)}
                </p>
              </div>
            </header>
            <p className={s.status}>{actor.status}</p>
            <p className={s.task}>{actor.task}</p>
            <dl className={s.facts}>
              <dt>Activity</dt>
              <dd>{actor.activity}</dd>
              <dt>{actor.sessionId ? 'Session' : 'Planned task'}</dt>
              <dd className={s.id}>{actor.sessionId ?? actor.nodeId}</dd>
              {actor.sessionId && actor.nodeId && (
                <>
                  <dt>Task ID</dt>
                  <dd className={s.id}>{actor.nodeId}</dd>
                </>
              )}
            </dl>
            {actor.review && <p className={s.secondary}>{actor.review}</p>}
            {actor.relationships.length > 0 && (
              <ul className={s.relationships}>
                {actor.relationships.map((relation) => (
                  <li key={relation.id}>
                    {relation.label}:{' '}
                    <button type="button" onClick={() => onOpen(relation.id)}>
                      {relation.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {actor.sessionId && (
              <button
                className={s.open}
                type="button"
                onClick={() => onOpen(actor.sessionId!)}
                aria-label={`Open ${actor.name} session`}
              >
                Open session
              </button>
            )}
          </article>
        ))}
      </div>
    </>
  );
}
