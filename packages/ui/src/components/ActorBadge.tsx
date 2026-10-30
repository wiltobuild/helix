import type { CSSProperties } from 'react';
import { cx } from '../cx';
import { agentMeta, type AgentKind } from '../status';
import { AgentBadge } from './AgentBadge';
import { HelixLogo } from './HelixLogo';
import s from './ActorBadge.module.css';

/** How an actor relates to a task: the orchestrator, the author doing it, or its cross-reviewer. */
export type ActorRole = 'orchestrator' | 'author' | 'reviewer';

export interface ActorBadgeProps {
  /** Primary, task-derived actor name (e.g. "Catalog Architect" or "Helix"). */
  name: string;
  role: ActorRole;
  /** Provider running this actor — shown as secondary context, never as the identity. */
  agent: AgentKind;
  /** Secondary model label. */
  model?: string;
  /** Animates the emblem while the actor is working. */
  active?: boolean;
  /** Internal IDs surfaced on hover for tracing; never shown inline. */
  title?: string;
  className?: string;
}

/**
 * The actor identity shown wherever a task has a face: board cards, the inspector, the plan graph
 * and search. The name is primary; the provider/model sit quietly beside it. The orchestrator
 * always wears the canonical {@link HelixLogo}; workers and reviewers reuse the provider emblem,
 * and a reviewer is tagged so it never reads as the author.
 */
export function ActorBadge({
  name,
  role,
  agent,
  model,
  active = false,
  title,
  className,
}: ActorBadgeProps) {
  const meta = agentMeta(agent);
  const style = { '--agent': meta.colorVar } as CSSProperties;
  return (
    <span
      className={cx(s.root, className)}
      style={style}
      data-role={role}
      data-active={active || undefined}
      {...(title ? { title } : {})}
    >
      {role === 'orchestrator' ? (
        <HelixLogo size={15} active={active} className={s.symbol} />
      ) : (
        <AgentBadge agent={agent} variant="glyph" active={active} className={s.symbol} />
      )}
      <span className={s.name}>{role === 'orchestrator' ? 'Helix' : name}</span>
      <span className={s.meta}>
        {role === 'reviewer' && <span className={s.tag}>reviews</span>}
        <span className={s.provider}>{meta.short}</span>
        {model && <span className={s.model}>· {model}</span>}
      </span>
    </span>
  );
}
