import type { CSSProperties } from 'react';
import { cx } from '../cx';
import { statusMeta, toneSoftVar, toneVar, type DisplayStatus } from '../status';
import s from './StatusPill.module.css';

export interface StatusPillProps {
  status: DisplayStatus;
  /** `pill` = filled chip (headers, inspector); `inline` = icon + label only (cards, lists). */
  variant?: 'pill' | 'inline';
  /** Override the label, e.g. "CI failed · token.test.ts". */
  label?: string;
  className?: string;
}

export function StatusPill({ status, variant = 'pill', label, className }: StatusPillProps) {
  const meta = statusMeta[status];
  const Icon = meta.icon;
  const style = { '--tone': toneVar(meta.tone), '--tone-soft': toneSoftVar(meta.tone) } as CSSProperties;
  return (
    <span className={cx(s.root, variant === 'pill' && s.filled, className)} style={style} data-status={status}>
      <Icon className={cx(s.icon, meta.live && s.live)} size={13} strokeWidth={2.2} aria-hidden />
      <span className={s.text}>{label ?? meta.label}</span>
    </span>
  );
}

/** Small colored dot for dense lists (sidebar). Carries its own accessible label. */
export function StatusDot({ status, className }: { status: DisplayStatus; className?: string }) {
  const meta = statusMeta[status];
  return (
    <span
      className={cx(s.dot, meta.live && s.dotLive, className)}
      style={{ '--tone': toneVar(meta.tone) } as CSSProperties}
      role="img"
      aria-label={meta.label}
    />
  );
}
