import { cx } from '../cx';
import s from './HelixLogo.module.css';

export interface HelixLogoProps {
  /** Pixel width and height of the SVG mark (default 22). */
  size?: number;
  /** Gently pulses base-pair rungs and nucleotide nodes when agents are actively working. */
  active?: boolean;
  /** `mark` = standalone two-strand DNA crossover; `badge` = framed squircle tile. */
  variant?: 'mark' | 'badge';
  className?: string;
}

/**
 * The Helix two-strand DNA mark:
 *   Strand A (--strand-claude) = Claude Code
 *   Strand B (--strand-codex)  = Codex
 *   Base-pair rungs            = shared contract & append-only event log
 */
export function HelixLogo({
  size = 22,
  active = false,
  variant = 'mark',
  className,
}: HelixLogoProps) {
  return (
    <svg
      className={cx(s.logo, className)}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      data-active={active || undefined}
      aria-hidden
    >
      {variant === 'badge' && (
        <rect x="1" y="1" width="30" height="30" rx="8" className={s.tile} strokeWidth="1.5" />
      )}
      <line
        className={cx(s.rung, s.rung1)}
        x1="10"
        y1="7"
        x2="22"
        y2="7"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        className={cx(s.rung, s.rung2)}
        x1="11"
        y1="13"
        x2="21"
        y2="13"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        className={cx(s.rung, s.rung3)}
        x1="11"
        y1="19"
        x2="21"
        y2="19"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        className={cx(s.rung, s.rung4)}
        x1="10"
        y1="25"
        x2="22"
        y2="25"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        className={s.strandClaude}
        d="M8 4 C24 10, 8 22, 24 28"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path
        className={s.strandCodex}
        d="M24 4 C8 10, 24 22, 8 28"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <circle className={cx(s.nodeClaude, s.nodeA)} cx="8" cy="4" r="2.1" />
      <circle className={cx(s.nodeCodex, s.nodeB)} cx="24" cy="4" r="2.1" />
      <circle className={cx(s.nodeClaude, s.nodeB)} cx="24" cy="28" r="2.1" />
      <circle className={cx(s.nodeCodex, s.nodeA)} cx="8" cy="28" r="2.1" />
    </svg>
  );
}
