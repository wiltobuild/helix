import { useEffect, useMemo, useState } from 'react';
import { LayoutGrid, Network, Plus } from 'lucide-react';
import type { HelixEvent } from '@helix/contracts';
import { Button, Segmented, Spinner, type BoardColumn } from '@helix/ui';
import { useHelixSource, type HelixSource } from '../data/useHelixSource';
import { useRun } from '../data/useRun';
import { boardCards } from '../data/describe';
import { Sidebar } from './Sidebar';
import { Board } from './Board';
import { TimelineBar } from './TimelineBar';
import { Inspector } from './Inspector';
import { PlanView } from './PlanView';
import { NewTaskDialog } from './NewTaskDialog';
import { Onboarding } from './Onboarding';
import s from './App.module.css';

export function App() {
  const source = useHelixSource();

  if (source.mode === 'empty') return <Onboarding onAdd={source.addProject} error={source.error} />;
  if (source.events.length === 0)
    return (
      <div className={s.loading}>
        <Spinner size={18} label="Connecting to Helix" />
      </div>
    );
  return <Workspace events={source.events} source={source} />;
}

function Workspace({ events, source }: { events: readonly HelixEvent[]; source: HelixSource }) {
  const run = useRun(events);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState('board');
  const [newTask, setNewTask] = useState(false);

  const { state, bySeq, current } = run;
  const cards = useMemo(() => boardCards(state, bySeq, current.ts), [state, bySeq, current.ts]);
  const needsYou = cards.filter((c) => c.column === 'needs_you');
  const selectedSession = selected
    ? state.sessions[selected as keyof typeof state.sessions]
    : undefined;
  const live = source.mode === 'live';
  const pendingPlan = Object.values(state.plans).find((p) => p.status === 'awaiting_approval');

  // Keyboard: [ ] step the timeline, L back to live, ⌘/Ctrl+N new task, Esc closes the inspector.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setNewTask(true);
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
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
        project={state.project}
        cards={cards}
        needsYou={needsYou.length}
        selected={selected}
        onSelect={setSelected}
        demo={!live}
        {...(live && source.stream !== 'demo' ? { stream: source.stream } : {})}
      />

      <main className={s.main}>
        <header className={s.header}>
          <div className={s.titleBlock}>
            <h1>{state.project.name}</h1>
            <span className={s.meta}>
              {state.project.github
                ? `${state.project.github.owner}/${state.project.github.repo}`
                : state.project.repoPath}{' '}
              · {state.project.defaultBranch}
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
            <Button
              variant="primary"
              icon={<Plus size={14} />}
              shortcut="⌘N"
              onClick={() => setNewTask(true)}
            >
              New task
            </Button>
          </div>
        </header>

        <div className={s.content}>
          {view === 'board' && pendingPlan && (
            <div className={s.planBanner} role="status">
              <span>
                <strong>A plan is waiting for your approval.</strong> “{pendingPlan.goal}” ·{' '}
                {pendingPlan.nodes.length} {pendingPlan.nodes.length === 1 ? 'task' : 'tasks'}
              </span>
              <Button size="sm" variant="primary" onClick={() => setView('plan')}>
                Review plan
              </Button>
            </div>
          )}
          {view === 'board' ? (
            <Board cards={cards} selected={selected} onSelect={setSelected} columns={COLUMNS} />
          ) : (
            <PlanView
              state={state}
              selected={selected}
              onSelect={setSelected}
              {...(live && source.client ? { client: source.client, isLive: run.isLive } : {})}
            />
          )}
        </div>

        <TimelineBar run={run} />
      </main>

      {selectedSession && (
        <Inspector
          session={selectedSession}
          state={state}
          events={run.events}
          upTo={current.seq}
          onClose={() => setSelected(null)}
          onJump={(seq) => run.seek(run.events.findIndex((e) => e.seq === seq))}
          {...(live && source.client ? { client: source.client, isLive: run.isLive } : {})}
        />
      )}

      <NewTaskDialog
        open={newTask}
        onOpenChange={setNewTask}
        {...(live && source.client && source.project
          ? { client: source.client, project: source.project }
          : {})}
        onCreated={(id) => {
          run.goLive();
          setSelected(id);
        }}
      />
    </div>
  );
}

const COLUMNS: BoardColumn[] = ['pending', 'working', 'needs_you', 'in_review', 'ready_to_merge'];
