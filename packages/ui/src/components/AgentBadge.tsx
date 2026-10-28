import type { CSSProperties } from 'react';
import { cx } from '../cx';
import { agentMeta, type AgentKind } from '../status';
import s from './AgentBadge.module.css';

export interface AgentBadgeProps {
  agent: AgentKind;
  /** `full` = "Claude Code", `short` = "claude" in mono, `glyph` = mark only (labelled for a11y). */
  variant?: 'full' | 'short' | 'glyph';
  model?: string;
  /** Animates the agent emblem (Codex orbital spin / Claude ray ripple wave) when actively working. */
  active?: boolean;
  className?: string;
}

const CLAUDE_ANGLES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] as const;

/** Claude Code sunburst emblem: 12 radial rays with phase-shifted ripple wave when active. */
function ClaudeGlyph() {
  return (
    <svg className={s.glyph} viewBox="0 0 32 32" fill="none" aria-hidden>
      <g className={s.claudeRays}>
        {CLAUDE_ANGLES.map((angle, idx) => (
          <line
            key={angle}
            className={cx(s.claudeRay, s[`ray${idx}`])}
            x1="16"
            y1="2.8"
            x2="16"
            y2="10.6"
            transform={`rotate(${angle} 16 16)`}
          />
        ))}
      </g>
      <circle className={s.claudeCore} cx="16" cy="16" r="3.6" />
    </svg>
  );
}

/** Codex hexagonal knot / orbital rotor emblem: spins smoothly around a breathing core when active. */
function CodexGlyph() {
  return (
    <svg className={s.glyph} viewBox="0 0 32 32" fill="none" aria-hidden>
      <g className={s.codexRotor}>
        <path
          className={s.codexHex}
          d="M16 3.5 L26.8 9.75 L26.8 22.25 L16 28.5 L5.2 22.25 L5.2 9.75 Z"
        />
        <g className={s.codexLinks}>
          <line x1="16" y1="4" x2="21.5" y2="11" />
          <line x1="26.4" y1="10" x2="21.5" y2="18.5" />
          <line x1="26.4" y1="22" x2="16" y2="21.5" />
          <line x1="16" y1="28" x2="10.5" y2="21" />
          <line x1="5.6" y1="22" x2="10.5" y2="13.5" />
          <line x1="5.6" y1="10" x2="16" y2="10.5" />
        </g>
      </g>
      <circle className={s.codexCore} cx="16" cy="16" r="3.4" />
    </svg>
  );
}

function AgentGlyph({ agent }: { agent: AgentKind }) {
  return agent === 'codex' ? <CodexGlyph /> : <ClaudeGlyph />;
}

export function AgentBadge({
  agent,
  variant = 'short',
  model,
  active = false,
  className,
}: AgentBadgeProps) {
  const meta = agentMeta(agent);
  const style = { '--agent': meta.colorVar } as CSSProperties;
  if (variant === 'glyph') {
    return (
      <span
        className={cx(s.root, className)}
        style={style}
        data-active={active || undefined}
        role="img"
        aria-label={meta.label}
      >
        <AgentGlyph agent={agent} />
      </span>
    );
  }
  return (
    <span
      className={cx(s.root, s[variant], className)}
      style={style}
      data-active={active || undefined}
    >
      <AgentGlyph agent={agent} />
      <span>{variant === 'full' ? meta.label : meta.short}</span>
      {model && <span className={s.model}>· {model}</span>}
    </span>
  );
}
