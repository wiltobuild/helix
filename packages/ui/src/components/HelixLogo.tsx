import { cx } from '../cx';
import s from './HelixLogo.module.css';

export interface HelixLogoProps {
  /** Height of the horizontal mark; its width is twice this value. */
  size?: number;
  /** Moves the intertwined strands in a seamless loop while work is in progress. */
  active?: boolean;
  variant?: 'mark' | 'badge';
  className?: string;
}

// The PRD's opposing sine strands, teal/rust depth and neutral base-pair rungs.
// Two identical 60-unit periods let CSS move exactly one period without a reset jump.
// Thin continuous rails keep the DNA silhouette legible at small UI sizes.
const wavelength = 60;
const amplitude = 10;
const points = Array.from({ length: 25 }, (_, i) => {
  const phase = (i * Math.PI) / 6;
  return { x: 2 + i * 5, y: Math.sin(phase) * amplitude, depth: Math.cos(phase) };
});
const round = (value: number) => Number(value.toFixed(3));
function strandPath(sign: number) {
  let path = 'M2 16';
  const quarter = wavelength / 4;
  const tangent = (amplitude * Math.PI) / 6;
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 2;
    const b = a + Math.PI / 2;
    const x = 2 + i * quarter;
    path += ` C${x + quarter / 3} ${round(16 + sign * (amplitude * Math.sin(a) + tangent * Math.cos(a)))},${x + (2 * quarter) / 3} ${round(16 + sign * (amplitude * Math.sin(b) - tangent * Math.cos(b)))},${x + quarter} ${round(16 + sign * amplitude * Math.sin(b))}`;
  }
  return path;
}
const tealPath = strandPath(1);
const rustPath = strandPath(-1);

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
      data-helix="dna"
      data-active={active || undefined}
      aria-hidden
    >
      {variant === 'badge' && <rect x="1" y="1" width="62" height="30" rx="8" className={s.tile} />}
      <svg x="2" y="2" width="60" height="28" viewBox="2 2 60 28" overflow="hidden">
        <g className={s.strands}>
          {points
            .filter((_, i) => i % 2 === 1)
            .map(({ x, y }) => (
              <line key={x} className={s.rung} x1={x} x2={x} y1={16 + y} y2={16 - y} />
            ))}
          <path className={s.tealRail} d={tealPath} />
          <path className={s.rustRail} d={rustPath} />
          {[false, true].map((front) =>
            points.flatMap(({ x, y, depth }, i) =>
              [1, -1]
                .filter((sign) => sign * depth >= 0 === front)
                .map((sign) => (
                  <circle
                    key={`${front}-${i}-${sign}`}
                    className={sign === 1 ? s.teal : s.rust}
                    cx={x}
                    cy={16 + sign * y}
                    r={1.3 + 0.6 * sign * depth}
                    opacity={0.625 + 0.275 * sign * depth}
                  />
                )),
            ),
          )}
        </g>
      </svg>
    </svg>
  );
}
