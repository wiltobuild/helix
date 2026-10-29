import { SectionLabel, SessionCard, columnMeta, toneVar, type BoardColumn } from '@helix/ui';
import type { BoardCard } from '../data/describe';
import { ReviewChip } from './ReviewChip';
import s from './Board.module.css';

interface BoardProps {
  cards: BoardCard[];
  columns: BoardColumn[];
  selected: string | null;
  onSelect: (id: string) => void;
  onReview: (id: string) => void;
}

const EMPTY: Partial<Record<BoardColumn, string>> = {
  pending: 'No queued tasks',
  working: 'No agents working',
  needs_you: 'Nothing needs you',
  in_review: 'No open PRs',
  ready_to_merge: 'Nothing ready yet',
};

export function Board({ cards, columns, selected, onSelect, onReview }: BoardProps) {
  const archived = cards.filter((c) => c.column === 'archive');
  return (
    <div className={s.wrap}>
      <div
        className={s.board}
        style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
      >
        {columns.map((col) => {
          const inCol = cards.filter((c) => c.column === col);
          return (
            <section key={col} className={s.column} aria-label={columnMeta[col].label}>
              <header className={s.head}>
                <span className={s.dot} style={{ background: toneVar(columnMeta[col].tone) }} />
                <SectionLabel count={inCol.length}>{columnMeta[col].label}</SectionLabel>
              </header>
              {inCol.map((c) => (
                <SessionCard
                  key={c.id}
                  {...c.card}
                  action={
                    c.review && <ReviewChip review={c.review} onOpen={() => onReview(c.id)} />
                  }
                  selected={selected === c.id}
                  onOpen={() => onSelect(c.id)}
                />
              ))}
              {inCol.length === 0 && <p className={s.empty}>{EMPTY[col]}</p>}
            </section>
          );
        })}
      </div>

      {archived.length > 0 && (
        <section className={s.archive} aria-label="Merged and archived">
          <SectionLabel count={archived.length}>Merged &amp; archived</SectionLabel>
          <div className={s.archiveRow}>
            {archived.map((c) => (
              <SessionCard
                key={c.id}
                {...c.card}
                action={c.review && <ReviewChip review={c.review} onOpen={() => onReview(c.id)} />}
                selected={selected === c.id}
                onOpen={() => onSelect(c.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
