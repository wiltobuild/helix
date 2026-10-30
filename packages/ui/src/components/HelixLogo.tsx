import type { CSSProperties } from 'react';
import { cx } from '../cx';
import s from './HelixLogo.module.css';

export interface HelixLogoProps {
  /** Height of the mark; the horizontal mark is twice as wide. */
  size?: number;
  /** Advances the opposing dotted strands while work is in progress. */
  active?: boolean;
  variant?: 'mark' | 'badge';
  className?: string;
}

// PRD.html: samples spaced by 14 at k=.045, opposing sine waves, depth-shaded dots,
// neutral rungs on alternate samples, phase advancing .012 per 60 Hz frame.
const samples = Array.from({ length: 19 }, (_, i) => ({ x: 4 + i * 3.1, phase: i * 0.63 }));
const period = (2 * Math.PI) / 0.72;

export function HelixLogo({
  size = 22,
  active = false,
  variant = 'mark',
  className,
}: HelixLogoProps) {
  return (
    <svg
      className={cx(s.logo, className)}
      width={size * 2}
      height={size}
      viewBox="0 0 64 32"
      fill="none"
      data-helix="dotted"
      data-active={active || undefined}
      aria-hidden
    >
      {variant === 'badge' && <rect x="1" y="1" width="62" height="30" rx="8" className={s.tile} />}
      {samples
        .filter((_, i) => i % 2 === 0)
        .map(({ x, phase }) => (
          <line
            key={x}
            className={s.rung}
            x1={x}
            x2={x}
            y1="6"
            y2="26"
            style={
              {
                '--height': Math.abs(Math.sin(phase)),
                '--delay': `${-phase / 0.72}s`,
              } as CSSProperties
            }
          />
        ))}
      {[false, true].map((front) =>
        [0, Math.PI].map((offset, strand) =>
          samples.map(({ x, phase }, i) => {
            const angle = phase + offset;
            return (
              <circle
                key={`${front}-${strand}-${i}`}
                className={cx(strand ? s.rust : s.teal, front ? s.front : s.back)}
                cx={x}
                cy="16"
                r="1.5"
                style={
                  {
                    '--y': `${Math.sin(angle) * 10}px`,
                    '--depth': 0.625 + 0.275 * Math.cos(angle),
                    '--radius': `${1.3 + 0.6 * Math.cos(angle)}px`,
                    '--visibility': Math.cos(angle) >= 0 === front ? 'visible' : 'hidden',
                    '--delay': `${-angle / 0.72}s`,
                    '--period': `${period}s`,
                  } as CSSProperties
                }
              />
            );
          }),
        ),
      )}
    </svg>
  );
}
