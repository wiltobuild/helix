import type { CSSProperties } from 'react';
import { cx } from '../cx';
import { agentMeta, type AgentKind } from '../status';
import s from './AgentBadge.module.css';

export interface AgentBadgeProps {
  agent: AgentKind;
  /** `full` = "Claude Code", `short` = "claude" in mono, `glyph` = mark only (labelled for a11y). */
  variant?: 'full' | 'short' | 'glyph';
  model?: string;
  className?: string;
}

/** The strand mark: two offset dots, echoing the Helix double strand, in the agent's color. */
function StrandGlyph() {
  return (
    <svg className={s.glyph} viewBox="0 0 12 12" aria-hidden>
      <circle cx="3.5" cy="4" r="2.5" />
      <circle cx="8.5" cy="8" r="2.5" opacity="0.55" />
    </svg>
  );
}

export function AgentBadge({ agent, variant = 'short', model, className }: AgentBadgeProps) {
  const meta = agentMeta(agent);
  const style = { '--agent': meta.colorVar } as CSSProperties;
  if (variant === 'glyph') {
    return (
      <span className={cx(s.root, className)} style={style} role="img" aria-label={meta.label}>
        <StrandGlyph />
      </span>
    );
  }
  return (
    <span className={cx(s.root, s[variant], className)} style={style}>
      <StrandGlyph />
      <span>{variant === 'full' ? meta.label : meta.short}</span>
      {model && <span className={s.model}>· {model}</span>}
    </span>
  );
}
