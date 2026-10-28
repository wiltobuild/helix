import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ChevronDown, FolderGit2, FolderPlus, LayoutGrid, Network, Plus } from 'lucide-react';
import type { HarnessInfo, HelixEvent, Project } from '@helix/contracts';
import {
  AgentBadge,
  Button,
  Dialog,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Segmented,
  Spinner,
  StatusDot,
  TextField,
  type BoardColumn,
} from '@helix/ui';
import { useHelixSource, type HelixSource } from '../data/useHelixSource';
import { useRun } from '../data/useRun';
import { boardCards, slotWaiting, type BoardCard } from '../data/describe';
import { StopAll, runningAgents } from './StopAll';
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addRepoOpen, setAddRepoOpen] = useState(false);

  const { state, bySeq, current } = run;
  const cards = useMemo(() => boardCards(state, bySeq, current.ts), [state, bySeq, current.ts]);
  const activeCount = cards.filter((c) => c.column !== 'archive').length;
  const needsYou = cards.filter((c) => c.column === 'needs_you');
  const selectedSession = selected
    ? state.sessions[selected as keyof typeof state.sessions]
    : undefined;
  const live = source.mode === 'live';
  const pendingPlan = Object.values(state.plans).find((p) => p.status === 'awaiting_approval');
  const waitingForSlot = slotWaiting(state);
  const repoList: readonly Project[] =
    source.projects.length > 0 ? source.projects : [state.project];

  // Keyboard: [ ] step the timeline, L back to live, ⌘/Ctrl+N new task, ⌘/Ctrl+K search, Esc closes inspector.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setNewTask(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
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
        onSearch={() => setSearchOpen(true)}
        onSettings={() => setSettingsOpen(true)}
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
            {live && source.client && (
              <StopAll
                client={source.client}
                projectId={state.project.id}
                running={runningAgents(state)}
                canAct={run.isLive}
              />
            )}
            <Menu
              align="end"
              trigger={
                <Button variant="primary" icon={<Plus size={14} />} shortcut="⌘N">
                  Tasks
                  <ChevronDown size={13} aria-hidden />
                </Button>
              }
            >
              <MenuItem icon={<Plus size={14} />} shortcut="⌘N" onSelect={() => setNewTask(true)}>
                New task
              </MenuItem>
              <MenuSeparator />
              <MenuLabel>Repositories</MenuLabel>
              {repoList.map((repo) => {
                const isCurrent = repo.id === state.project.id;
                const badge = isCurrent ? `${activeCount} active` : repo.defaultBranch;
                return (
                  <MenuItem
                    key={repo.id}
                    icon={<FolderGit2 size={14} />}
                    shortcut={badge}
                    onSelect={() => {
                      if (!isCurrent) {
                        setSelected(null);
                        source.selectProject(repo.id);
                      }
                    }}
                  >
                    {repo.name}
                  </MenuItem>
                );
              })}
              <MenuSeparator />
              <MenuItem icon={<FolderPlus size={14} />} onSelect={() => setAddRepoOpen(true)}>
                Add repository…
              </MenuItem>
            </Menu>
          </div>
        </header>

        <div className={s.content}>
          {view === 'board' && state.schedulingPaused && (
            <div className={s.slotBanner} role="status">
              Scheduling is paused after Stop all. Approve a plan or create a task to resume.
            </div>
          )}
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
          {view === 'board' && !state.schedulingPaused && waitingForSlot.length > 0 && (
            <div className={s.slotBanner} role="status">
              <span>
                <strong>
                  {waitingForSlot.length} {waitingForSlot.length === 1 ? 'task is' : 'tasks are'}{' '}
                  waiting for a worker slot.
                </strong>{' '}
                {waitingForSlot[0]!.note} The next one starts when a running task merges or stops.
              </span>
              <Button size="sm" onClick={() => setView('plan')}>
                Show in plan
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

      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        cards={cards}
        onSelectSession={(id) => {
          setSelected(id);
          setSearchOpen(false);
        }}
        onNewTask={() => {
          setSearchOpen(false);
          setNewTask(true);
        }}
        onSwitchView={(nextView) => {
          setView(nextView);
          setSearchOpen(false);
        }}
      />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        project={state.project}
        demo={!live}
        {...(live && source.client ? { client: source.client } : {})}
        onAddRepository={() => {
          setSettingsOpen(false);
          setAddRepoOpen(true);
        }}
      />

      <AddRepositoryDialog
        open={addRepoOpen}
        onOpenChange={setAddRepoOpen}
        demo={!live}
        onAdd={source.addProject}
      />
    </div>
  );
}

function SearchDialog({
  open,
  onOpenChange,
  cards,
  onSelectSession,
  onNewTask,
  onSwitchView,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cards: readonly BoardCard[];
  onSelectSession: (id: string) => void;
  onNewTask: () => void;
  onSwitchView: (view: 'board' | 'plan') => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      cards.filter((c) => {
        if (!q) return true;
        return (
          c.card.title.toLowerCase().includes(q) ||
          (c.card.branch?.toLowerCase().includes(q) ?? false) ||
          c.card.agent.toLowerCase().includes(q) ||
          (c.card.statusLabel?.toLowerCase().includes(q) ?? false)
        );
      }),
    [cards, q],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
      title="Search workspace"
      description="Jump to a session, filter by branch or agent, or run a workspace command."
    >
      <div className={s.dialogStack}>
        <TextField
          id="workspace-search"
          label="Filter tasks & commands"
          placeholder="Search by task title, branch, or agent…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <div className={s.searchList} role="listbox" aria-label="Matching tasks">
          {matches.map((c) => (
            <button
              key={c.id}
              type="button"
              className={s.searchItem}
              onClick={() => onSelectSession(c.id)}
            >
              <StatusDot status={c.status} />
              <span className={s.searchItemTitle}>{c.card.title}</span>
              {c.card.branch && <span className={s.searchItemMeta}>{c.card.branch}</span>}
              <AgentBadge agent={c.card.agent} active={c.status === 'working'} />
            </button>
          ))}
          {matches.length === 0 && (
            <p className={s.searchEmpty}>No tasks match “{query.trim()}”.</p>
          )}
        </div>
        <div className={s.quickActions}>
          <Button size="sm" icon={<Plus size={13} />} onClick={onNewTask}>
            New task
          </Button>
          <Button size="sm" icon={<LayoutGrid size={13} />} onClick={() => onSwitchView('board')}>
            Board view
          </Button>
          <Button size="sm" icon={<Network size={13} />} onClick={() => onSwitchView('plan')}>
            Plan view
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function SettingsDialog({
  open,
  onOpenChange,
  project,
  demo,
  client,
  onAddRepository,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  demo: boolean;
  client?: NonNullable<HelixSource['client']>;
  onAddRepository: () => void;
}) {
  const [harnesses, setHarnesses] = useState<readonly HarnessInfo[]>([]);

  useEffect(() => {
    if (!open || !client) return;
    let cancelled = false;
    client
      .harnesses()
      .then((list) => {
        if (!cancelled) setHarnesses(list);
      })
      .catch(() => {
        if (!cancelled) setHarnesses([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, client]);

  const displayedHarnesses: readonly HarnessInfo[] =
    demo || harnesses.length === 0
      ? [
          { agent: 'claude-code', installed: true, signedIn: true },
          { agent: 'codex', installed: true, signedIn: true },
        ]
      : harnesses;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Workspace settings"
      description={
        demo
          ? 'Viewing recorded demo run configuration and agent harnesses.'
          : 'Active repository configuration and detected local agent harnesses.'
      }
      footer={
        <>
          <Button variant="secondary" icon={<FolderPlus size={14} />} onClick={onAddRepository}>
            Add repository…
          </Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </>
      }
    >
      <div className={s.dialogStack}>
        <div className={s.settingsGroup}>
          <span className={s.settingsLabel}>Active repository</span>
          <div className={s.settingsCard}>
            <strong>{project.name}</strong>
            <span className={s.meta}>
              {project.repoPath} · default branch {project.defaultBranch}
            </span>
          </div>
        </div>
        <div className={s.settingsGroup}>
          <span className={s.settingsLabel}>Agent harnesses</span>
          <div className={s.harnessList}>
            {displayedHarnesses.map((h) => (
              <div key={h.agent} className={s.harnessRow}>
                <AgentBadge agent={h.agent} variant="full" />
                <span className={s.meta}>
                  {h.installed
                    ? h.signedIn === false
                      ? 'Installed · sign-in required'
                      : 'Installed · ready'
                    : 'Not installed'}
                  {h.version ? ` (${h.version})` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function AddRepositoryDialog({
  open,
  onOpenChange,
  demo,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  demo: boolean;
  onAdd: (repoPath: string) => Promise<void>;
}) {
  const [repoPath, setRepoPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (demo || !repoPath.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await onAdd(repoPath.trim());
      setRepoPath('');
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add repository.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setRepoPath('');
          setError(undefined);
        }
        onOpenChange(next);
      }}
      title="Add repository"
      description={
        demo
          ? 'Demo mode replays a recorded run. Start helixd to connect a local git repository.'
          : 'Connect a local git repository. Agents work in isolated worktree branches.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={demo || !repoPath.trim()}
            onClick={() => void submit()}
          >
            Add repository
          </Button>
        </>
      }
    >
      <form className={s.dialogStack} onSubmit={(e) => void submit(e)}>
        <TextField
          id="add-repo-path"
          label="Repository path"
          placeholder="/Users/you/code/my-app"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          {...(error ? { error } : {})}
          autoFocus
        />
      </form>
    </Dialog>
  );
}

const COLUMNS: BoardColumn[] = ['pending', 'working', 'needs_you', 'in_review', 'ready_to_merge'];
