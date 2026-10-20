import { useMemo, useState, type CSSProperties } from 'react';
import { ChevronRight, Pause, Play, Radio, StepBack, StepForward } from 'lucide-react';
import { whyChain } from '@helix/contracts';
import { Button, IconButton, cx } from '@helix/ui';
import { describeEvent, eventTone, type EventTone } from '../data/describe';
import type { RunView } from '../data/useRun';
import s from './TimelineBar.module.css';

const TONE_VAR: Record<EventTone, string> = {
  plan: 'var(--accent)',
  work: 'var(--status-working)',
  needs: 'var(--status-needs)',
  failed: 'var(--status-failed)',
  feedback: 'var(--strand-claude)',
  review: 'var(--status-review)',
  done: 'var(--status-ready)',
  quiet: 'var(--border-strong)',
};

const clock = (fromIso: string, toIso: string) => {
  const secs = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  const m = Math.floor(secs / 60);
  return `${String(m).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
};

/**
 * The timeline: always visible under the board. Live by default; drag to rewind the whole
 * project (board, plan, chat). The caption explains the event under the cursor, and "Why"
 * walks its causedBy chain back to the plan.
 */
export function TimelineBar({ run }: { run: RunView }) {
  const [whyOpen, setWhyOpen] = useState(false);
  const { events, index, current, state, isLive } = run;
  const first = events[0]!;
  const max = Math.max(events.length - 1, 1);

  // Causes of the current event, stopping at the plan: the plan is the root intent, and what
  // came before it (project setup, orchestrator startup) doesn't explain anything.
  const chain = useMemo(() => {
    const causes = whyChain(events, current.seq).slice(1);
    const planAt = causes.findIndex((e) => e.type === 'plan.submitted');
    return planAt === -1 ? causes : causes.slice(0, planAt + 1);
  }, [events, current.seq]);

  return (
    <footer className={s.bar}>
      <div className={s.caption} aria-live="polite">
        <span className={s.seq}>#{current.seq}</span>
        <span className={s.toneDot} style={{ background: TONE_VAR[eventTone(current)] }} />
        <p className={s.sentence}>{describeEvent(current, state)}</p>
        {chain.length > 0 && (
          <button
            type="button"
            className={cx(s.whyToggle, whyOpen && s.whyOpen)}
            onClick={() => setWhyOpen((o) => !o)}
            aria-expanded={whyOpen}
          >
            Why
            <ChevronRight size={13} aria-hidden />
          </button>
        )}
      </div>

      {whyOpen && chain.length > 0 && (
        <ol className={s.chain}>
          {chain.map((e) => (
            <li key={e.seq}>
              <button
                type="button"
                className={cx(eventTone(e) === 'quiet' && s.quietCause)}
                onClick={() => run.seek(events.indexOf(e))}
              >
                <span className={s.chainSeq}>#{e.seq}</span>
                <span className={s.chainDot} style={{ background: TONE_VAR[eventTone(e)] }} />
                <span>{describeEvent(e, state)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}

      <div className={s.controls}>
        <IconButton
          label="Previous event"
          shortcut="["
          icon={<StepBack size={15} />}
          onClick={() => run.step(-1)}
        />
        <IconButton
          label={run.playing ? 'Pause replay' : 'Replay from here'}
          icon={run.playing ? <Pause size={15} /> : <Play size={15} />}
          onClick={run.togglePlay}
        />
        <IconButton
          label="Next event"
          shortcut="]"
          icon={<StepForward size={15} />}
          onClick={() => run.step(1)}
        />

        <div className={s.track}>
          <div className={s.ticks} aria-hidden>
            {events.map((e, i) => {
              const tone = eventTone(e);
              return (
                <span
                  key={e.seq}
                  className={cx(s.tick, tone !== 'quiet' && s.tickLoud, i > index && s.future)}
                  style={{ left: `${(i / max) * 100}%`, '--tick': TONE_VAR[tone] } as CSSProperties}
                />
              );
            })}
          </div>
          <input
            type="range"
            className={s.range}
            min={0}
            max={events.length - 1}
            value={index}
            onChange={(e) => run.seek(Number(e.target.value))}
            aria-label="Timeline position"
            aria-valuetext={`Event ${current.seq}: ${describeEvent(current, state)}`}
          />
        </div>

        <span className={s.clock}>{clock(first.ts, current.ts)}</span>

        {isLive ? (
          <span className={s.live}>
            <Radio size={13} aria-hidden /> Live
          </span>
        ) : (
          <Button size="sm" variant="secondary" onClick={run.goLive} shortcut="L">
            Back to live
          </Button>
        )}
      </div>
    </footer>
  );
}
