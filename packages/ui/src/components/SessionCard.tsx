import type { ReactNode } from 'react';
import { GitBranch, MessageSquare } from 'lucide-react';
import { cx } from '../cx';
import type { AgentKind, DisplayStatus } from '../status';
import { AgentBadge } from './AgentBadge';
import { ActorBadge, type ActorBadgeProps } from './ActorBadge';
import { StatusPill } from './StatusPill';
import s from './SessionCard.module.css';

export interface SessionCardProps {
  title: string;
  agent: AgentKind;
  /** The task-derived actor shown as the primary label; falls back to the provider badge. */
  actor?: ActorBadgeProps;
  status: DisplayStatus;
  /** Override for the status line, e.g. "CI failed · token.test.ts" or "Editing form component". */
  statusLabel?: string;
  branch?: string;
  pr?: { number: number; comments?: number };
  checks?: { passed: number; total: number };
  /** Relative time of the last event, already formatted ("8m"). */
  updated?: string;
  /** One primary action (Merge, Answer). Keep to at most one per card. */
  action?: ReactNode;
  selected?: boolean;
  onOpen?: () => void;
}

export function SessionCard({
  title,
  agent,
  actor,
  status,
  statusLabel,
  branch,
  pr,
  checks,
  updated,
  action,
  selected,
  onOpen,
}: SessionCardProps) {
  return (
    <article className={cx(s.card, selected && s.selected)} data-status={status}>
      {/* The whole card is the hit target; the button stretches over it, actions sit above it. */}
      <button
        type="button"
        className={s.hit}
        onClick={onOpen}
        aria-label={`Open ${title}`}
        aria-description={actor?.model ? `Model: ${actor.model}` : undefined}
        title={[actor?.name, actor?.model, actor?.title].filter(Boolean).join(' · ') || undefined}
      />
      <header className={s.head}>
        {actor ? (
          <ActorBadge {...actor} />
        ) : (
          <AgentBadge agent={agent} active={status === 'working'} />
        )}
        {updated && <time className={s.time}>{updated}</time>}
      </header>
      <h3 className={s.title}>{title}</h3>
      {(branch || checks || pr) && (
        <div className={s.branchRow}>
          {branch && (
            <span className={s.branch}>
              <GitBranch size={12} aria-hidden />
              <span className={s.branchName}>{branch}</span>
              {pr && <span className={s.pr}>#{pr.number}</span>}
            </span>
          )}
          <span className={s.meta}>
            {checks && (
              <span
                className={s.checks}
                title={`${checks.passed} of ${checks.total} checks passed`}
              >
                <span className={s.bar}>
                  <span
                    style={{ width: `${(checks.passed / Math.max(checks.total, 1)) * 100}%` }}
                  />
                </span>
                {checks.passed}/{checks.total}
              </span>
            )}
            {pr?.comments ? (
              <span className={s.comments} title={`${pr.comments} unresolved comments`}>
                <MessageSquare size={12} aria-hidden />
                {pr.comments}
              </span>
            ) : null}
          </span>
        </div>
      )}
      <footer className={s.foot}>
        <StatusPill status={status} variant="inline" label={statusLabel} />
      </footer>
      {action && <div className={s.action}>{action}</div>}
    </article>
  );
}
