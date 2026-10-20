import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../cx';
import s from './Feedback.module.css';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Every empty state offers a next step. */
  action?: ReactNode;
  tone?: 'neutral' | 'calm';
  className?: string;
}

export function EmptyState({ icon, title, description, action, tone = 'neutral', className }: EmptyStateProps) {
  return (
    <div className={cx(s.empty, tone === 'calm' && s.calm, className)}>
      {icon && <div className={s.emptyIcon}>{icon}</div>}
      <h3 className={s.emptyTitle}>{title}</h3>
      {description && <p className={s.emptyText}>{description}</p>}
      {action && <div className={s.emptyAction}>{action}</div>}
    </div>
  );
}

export function Skeleton({ width, height = 12, className }: { width?: number | string; height?: number; className?: string }) {
  return <span className={cx(s.skeleton, className)} style={{ width, height } as CSSProperties} aria-hidden />;
}

/** Mono uppercase label for sections and column headers. */
export function SectionLabel({ children, count, className }: { children: ReactNode; count?: number; className?: string }) {
  return (
    <div className={cx(s.sectionLabel, className)}>
      <span>{children}</span>
      {count != null && <span className={s.sectionCount}>{count}</span>}
    </div>
  );
}

export function Spinner({ size = 14, label = 'Loading' }: { size?: number; label?: string }) {
  return (
    <span className={s.spinner} style={{ width: size, height: size }} role="status" aria-label={label} />
  );
}
