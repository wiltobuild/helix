import type { CSSProperties } from 'react';
import { cx } from '../cx';
import { agentMeta, type AgentKind } from '../status';
import s from './AgentBadge.module.css';

export interface AgentBadgeProps {
  agent: AgentKind;
  /** `full` = "Claude Code", `short` = "claude" in mono, `glyph` = mark only (labelled for a11y). */
  variant?: 'full' | 'short' | 'glyph';
  model?: string;
  /** Animates the agent emblem (Codex rotational hex-knot / Claude outward ripple + ray wave) when actively working. */
  active?: boolean;
  /** Glyph size in px (default 14). */
  size?: number;
  className?: string;
}

/**
 * Authentic Claude sunburst ray geometry (12 organic spokes radiating from center (12, 12)
 * with Claude's signature asymmetric spoke lengths and angles).
 */
const CLAUDE_RAYS: readonly { angle: number; y1: number; y2: number }[] = [
  { angle: 0, y1: 9.8, y2: 2.0 },
  { angle: 28, y1: 10.0, y2: 3.1 },
  { angle: 58, y1: 9.8, y2: 2.3 },
  { angle: 90, y1: 9.8, y2: 2.0 },
  { angle: 122, y1: 10.0, y2: 3.0 },
  { angle: 150, y1: 9.8, y2: 2.2 },
  { angle: 180, y1: 9.8, y2: 2.0 },
  { angle: 208, y1: 10.0, y2: 3.1 },
  { angle: 238, y1: 9.8, y2: 2.3 },
  { angle: 270, y1: 9.8, y2: 2.0 },
  { angle: 302, y1: 10.0, y2: 3.0 },
  { angle: 330, y1: 9.8, y2: 2.2 },
];

/**
 * Official OpenAI / Codex 6-fold interwoven hexagonal blossom knot path (24x24 viewBox).
 */
const CODEX_HEX_KNOT_PATH =
  'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';

/**
 * Claude Code sunburst logo (Concept 3B):
 * Authentic Claude 12-spoke spark mark with phase-shifted clockwise ray wave + 2 outward concentric ripple rings when active.
 */
function ClaudeGlyph() {
  return (
    <svg className={s.glyph} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className={cx(s.claudeWaveRing, s.ring1)} cx="12" cy="12" r="10.8" />
      <circle className={cx(s.claudeWaveRing, s.ring2)} cx="12" cy="12" r="10.8" />
      <g className={s.claudeRays}>
        {CLAUDE_RAYS.map(({ angle, y1, y2 }, idx) => (
          <g key={angle} transform={`rotate(${angle} 12 12)`}>
            <line className={cx(s.claudeRay, s[`ray${idx}`])} x1="12" y1={y1} x2="12" y2={y2} />
          </g>
        ))}
      </g>
      <circle className={s.claudeCore} cx="12" cy="12" r="2.8" />
    </svg>
  );
}

/**
 * Codex logo (Concept 2A):
 * Authentic OpenAI / Codex 6-fold interwoven hexagonal knot that rotates smoothly when active.
 */
function CodexGlyph() {
  return (
    <svg className={s.glyph} viewBox="0 0 24 24" fill="none" aria-hidden>
      <g className={s.codexRotor}>
        <path className={s.codexKnot} d={CODEX_HEX_KNOT_PATH} />
      </g>
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
  size,
  className,
}: AgentBadgeProps) {
  const meta = agentMeta(agent);
  const style = {
    '--agent': meta.colorVar,
    ...(size ? { '--glyph-size': `${size}px` } : {}),
  } as CSSProperties;
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

export interface AgentEmblemProps {
  agent: AgentKind;
  /** Animates the logo: Codex knot spins, Claude rays ripple with outward rings. */
  active?: boolean;
  /** Tile size in px (default 44). The logo fills about 60% of it. */
  size?: number;
  className?: string;
}

/** The agent's logo, large, in a tinted tile: the Concept 3 agent node mark. */
export function AgentEmblem({ agent, active = false, size = 44, className }: AgentEmblemProps) {
  const meta = agentMeta(agent);
  return (
    <span
      className={cx(s.root, s.emblem, className)}
      style={
        {
          '--agent': meta.colorVar,
          '--glyph-size': `${Math.round(size * 0.62)}px`,
          width: size,
          height: size,
        } as CSSProperties
      }
      data-active={active || undefined}
      role="img"
      aria-label={`${meta.label}${active ? ' (working)' : ''}`}
    >
      <AgentGlyph agent={agent} />
    </span>
  );
}
