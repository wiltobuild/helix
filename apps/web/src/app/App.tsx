import { useEffect, useMemo, useState } from 'react';
import { LayoutGrid, Network, Plus } from 'lucide-react';
import { Button, Segmented, type BoardColumn } from '@helix/ui';
import { useDemoStream } from '../data/useDemoStream';
import { useRun } from '../data/useRun';
import { boardCards } from '../data/describe';
import { Sidebar } from './Sidebar';
import { Board } from './Board';
import { TimelineBar } from './TimelineBar';
import { Inspector } from './Inspector';
import { PlanView } from './PlanView';
import s from './App.module.css';

export function App() {
  const events = useDemoStream();
  const run = useRun(events);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState('board');

  const { state, bySeq, current } = run;
  const cards = useMemo(() => boardCards(state, bySeq, current.ts), [state, bySeq, current.ts]);
  const needsYou = cards.filter((c) => c.column === 'needs_you');
  const selectedSession = selected
    ? run.state.sessions[selected as keyof typeof run.state.sessions]
    : undefined;

  // Keyboard: [ ] step the timeline, L back to live, Esc closes the inspector.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (e.key === '[') run.step(-1);
      else if (e.key === ']') run.step(1);
      else if (e.key === 'l' || e.key === 'L') run.goLive();
      else if (e.key === 'Escape') setSelected(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run]);

  return (
    <div className={s.shell} data-inspector={selectedSession ? 'open' : 'closed'}>
      <Sidebar
        project={run.state.project}
        cards={cards}
        needsYou={needsYou.length}
        selected={selected}
        onSelect={setSelected}
        demo
      />

      <main className={s.main}>
        <header className={s.header}>
          <div className={s.titleBlock}>
            <h1>{run.state.project.name}</h1>
            <span className={s.meta}>
              {run.state.project.github
                ? `${run.state.project.github.owner}/${run.state.project.github.repo}`
                : run.state.project.repoPath}{' '}
              · {run.state.project.defaultBranch}
            </span>
          </div>
          <div className={s.actions}>
            <Segmented
              label="View"
              value={view}
              onValueChange={setView}
              items={[
                { value: 'board', label: 'Board', icon: <LayoutGrid size={13} /> },
                { value: 'plan', label: 'Plan', icon: <Network size={13} /> },
              ]}
            />
            <Button variant="primary" icon={<Plus size={14} />} shortcut="⌘N">
              New task
            </Button>
          </div>
        </header>

        <div className={s.content}>
          {view === 'board' ? (
            <Board cards={cards} selected={selected} onSelect={setSelected} columns={COLUMNS} />
          ) : (
            <PlanView state={run.state} selected={selected} onSelect={setSelected} />
          )}
        </div>

        <TimelineBar run={run} />
      </main>

      {selectedSession && (
        <Inspector
          session={selectedSession}
          state={run.state}
          events={run.events}
          upTo={run.current.seq}
          onClose={() => setSelected(null)}
          onJump={(seq) => run.seek(run.events.findIndex((e) => e.seq === seq))}
        />
      )}
    </div>
  );
}

const COLUMNS: BoardColumn[] = ['pending', 'working', 'needs_you', 'in_review', 'ready_to_merge'];
