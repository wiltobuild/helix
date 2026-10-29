import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { FolderPlus, LayoutGrid, Network, Plus } from 'lucide-react';
import { deriveStatus, type HarnessInfo, type HelixEvent, type Project } from '@helix/contracts';
import {
  AgentBadge,
  Button,
  Dialog,
  Kbd,
  Spinner,
  StatusDot,
  TextField,
  type BoardColumn,
} from '@helix/ui';
import { useHelixSource, type HelixSource } from '../data/useHelixSource';
import { useRun } from '../data/useRun';
import { replayStart } from '../data/recordings';
import { boardCards, relativeTo, type BoardCard } from '../data/describe';
import { formatDuration, planTree } from '../data/observatory';
import { StopAll, runningAgents } from './StopAll';
import {
  DemoStopAll,
  NavRail,
  SessionHeader,
  TopBar,
  type Page,
  type SessionSummary,
  type SessionTab,
} from './Chrome';
import { Board } from './Board';
import { Dock } from './Dock';
import { Inspector } from './Inspector';
import { PlanView } from './PlanView';
import { NavPage } from './Pages';
import { CommitsView, FilesView } from './SessionViews';
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
  const run = useRun(events, {
    recorded: source.mode !== 'live',
    speed: source.speed,
    startAt: Math.max(0, replayStart(events) - 1),
  });
  const { state, bySeq, current } = run;
  const [selected, setSelected] = useState<string | null | undefined>(() =>
    window.matchMedia('(max-width: 1440px), (max-height: 900px)').matches ? null : undefined,
  );
  const [inspectorTab, setInspectorTab] = useState('summary');
  const [tabOverride, setTab] = useState<SessionTab | null>(null);
  const [page, setPage] = useState<Page>('sessions');
  const [dockExpanded, setDockExpanded] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [addRepoOpen, setAddRepoOpen] = useState(false);

  const selectSession = (id: string, tab = 'summary') => {
    setSelected(id);
    setInspectorTab(tab);
  };
  const openFromPage = (id: string, tab = 'summary') => {
    setPage('sessions');
    selectSession(id, tab);
  };

  const tree = useMemo(
    () => planTree(state, run.events, run.index, current.ts),
    [state, run.events, run.index, current.ts],
  );
  // Plan is the primary workspace, including while the orchestrator is preparing it.
  const tab: SessionTab = tabOverride ?? 'plan';
  const cards = useMemo(() => boardCards(state, bySeq, current.ts), [state, bySeq, current.ts]);
  const activeCount = cards.filter((c) => c.column !== 'archive').length;
  const working = Object.values(state.sessions).filter(
    (x) => x.session.role !== 'orchestrator' && deriveStatus(x) === 'working',
  ).length;

  const defaultSessionId =
    tree?.plan.status === 'awaiting_approval'
      ? tree.orchestrator.sessionId
      : (cards.find((c) => c.status === 'needs_you' || c.status === 'working')?.id ??
        tree?.orchestrator.sessionId ??
        cards[0]?.id ??
        Object.keys(state.sessions)[0] ??
        null);
  const effectiveSelected =
    selected === undefined
      ? defaultSessionId
      : selected && state.sessions[selected as keyof typeof state.sessions]
        ? selected
        : selected === null
          ? null
          : defaultSessionId;
  const selectedSession = effectiveSelected
    ? state.sessions[effectiveSelected as keyof typeof state.sessions]
    : undefined;
  const live = source.mode === 'live';
  const repoList: readonly Project[] =
    source.projects.length > 0 ? source.projects : [state.project];
  const mode = live && run.isLive ? 'live' : run.playing ? 'replaying' : 'paused';

  const orch = tree
    ? state.sessions[tree.orchestrator.sessionId as keyof typeof state.sessions]
    : undefined;
  const sessionTitle = orch?.session.title ?? cards[0]?.card.title ?? state.project.name;
  const elapsedMs = Date.parse(current.ts) - Date.parse(run.events[0]!.ts);

  const active: SessionSummary | undefined = tree
    ? {
        id: tree.orchestrator.sessionId,
        title: sessionTitle,
        status:
          tree.orchestrator.tone === 'needs'
            ? 'needs_you'
            : tree.orchestrator.tone === 'done'
              ? 'merged'
              : 'working',
        meta: `${tree.tasks.length} tasks · ${tree.agents.length} agents · ${formatDuration(elapsedMs)}`,
        live: mode === 'live',
      }
    : cards[0]
      ? {
          id: cards[0].id,
          title: cards[0].card.title,
          status: cards[0].status,
          meta: cards[0].card.updated ?? '',
          live: mode === 'live',
        }
      : undefined;
  const recent: SessionSummary[] = Object.values(state.sessions)
    .filter(
      (x) =>
        x.session.role !== 'reviewer' &&
        x.session.id !== active?.id &&
        (x.session.role === 'orchestrator' || !x.session.planNodeId),
    )
    .slice(-6)
    .reverse()
    .map((x) => ({
      id: x.session.id,
      title: x.session.title,
      status: deriveStatus(x),
      meta: relativeTo(bySeq.get(x.lastEventSeq)?.ts ?? x.session.createdAt, current.ts),
      live: false,
    }));

  const prCount = Object.values(state.sessions).filter((x) => x.pr).length;

  // Keyboard: [ ] step, L live, ⌘N new task, ⌘K search, ? shortcuts, Esc closes the inspector.
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
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'))
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '[') run.step(-1);
      else if (e.key === ']') run.step(1);
      else if (e.key === 'l' || e.key === 'L') run.goLive();
      else if (e.key === '?') setShortcutsOpen(true);
      else if (e.key === 'Escape') setSelected(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run]);

  const stopAll =
    live && source.client ? (
      <StopAll
        client={source.client}
        projectId={state.project.id}
        running={runningAgents(state)}
        canAct={run.isLive}
      />
    ) : (
      <DemoStopAll />
    );

  return (
    <div className={s.shell} data-inspector={selectedSession ? 'open' : 'closed'}>
      <TopBar
        source={source}
        working={working}
        onSearch={() => setSearchOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onShortcuts={() => setShortcutsOpen(true)}
      />
      <NavRail
        project={state.project}
        page={page}
        onPage={setPage}
        counts={{
          tasks: tree?.tasks.length ?? cards.length,
          agents: tree?.agents.length,
          prs: prCount,
        }}
        {...(active ? { active } : {})}
        recent={recent}
        onOpenSession={(id) => selectSession(id)}
        onSettings={() => setSettingsOpen(true)}
      />

      <main className={s.main}>
        {page === 'sessions' ? (
          <>
            <SessionHeader
              state={state}
              source={source}
              title={sessionTitle}
              {...(tree ? { goal: tree.plan.goal } : {})}
              mode={mode}
              elapsedMs={elapsedMs}
              tab={tab}
              onTab={setTab}
              counts={{ board: activeCount, files: undefined, commits: undefined }}
              onNewTask={() => setNewTask(true)}
              onAddRepo={() => setAddRepoOpen(true)}
              onSelectRepo={(id) => {
                setSelected(null);
                source.selectProject(id);
              }}
              stopAll={stopAll}
              repos={repoList}
              activeCount={activeCount}
            />
            <div className={s.content}>
              {tab === 'board' && (
                <>
                  {tree?.plan.status === 'awaiting_approval' && (
                    <div className={s.planBanner} role="status">
                      <span>
                        <strong>The orchestrator’s plan is waiting for your approval.</strong>{' '}
                        Nothing runs until you approve it.
                      </span>
                      <Button size="sm" variant="outline" onClick={() => setTab('plan')}>
                        Review plan
                      </Button>
                    </div>
                  )}
                  <div className={s.boardPad}>
                    <Board
                      cards={cards}
                      selected={effectiveSelected}
                      onSelect={selectSession}
                      onReview={(id) => selectSession(id, 'review')}
                      columns={COLUMNS}
                    />
                  </div>
                </>
              )}
              {tab === 'plan' && (
                <PlanView
                  state={state}
                  selected={effectiveSelected}
                  onSelect={selectSession}
                  {...(tree
                    ? { onReviewPlan: () => selectSession(tree.orchestrator.sessionId) }
                    : {})}
                  events={run.events}
                  index={run.index}
                  {...(live && source.client ? { client: source.client, isLive: run.isLive } : {})}
                />
              )}
              {tab === 'files' && (
                <FilesView state={state} tree={tree} onOpen={(id) => selectSession(id, 'files')} />
              )}
              {tab === 'commits' && (
                <CommitsView
                  state={state}
                  events={run.events}
                  index={run.index}
                  onOpen={(id) => selectSession(id)}
                  onSeek={run.seek}
                />
              )}
            </div>
          </>
        ) : (
          <div className={s.content}>
            <NavPage
              page={page}
              state={state}
              events={run.events}
              index={run.index}
              tree={tree}
              onOpen={openFromPage}
              onSeek={run.seek}
              onPage={setPage}
            />
          </div>
        )}
        <Dock
          run={run}
          source={source}
          tree={tree}
          expanded={dockExpanded}
          onExpand={setDockExpanded}
          onSelectSession={(id) => {
            setPage('sessions');
            selectSession(id);
          }}
        />
      </main>

      {selectedSession && (
        <Inspector
          key={selectedSession.session.id}
          tab={inspectorTab}
          onTabChange={setInspectorTab}
          onSelect={selectSession}
          session={selectedSession}
          state={state}
          events={run.events}
          upTo={current.seq}
          onClose={() => setSelected(null)}
          onJump={(seq) => run.seek(run.events.findIndex((e) => e.seq === seq))}
          {...(tree ? { tree } : {})}
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
          setPage('sessions');
          setSelected(id);
        }}
      />

      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        cards={cards}
        onSelectSession={(id) => {
          setPage('sessions');
          setSelected(id);
          setSearchOpen(false);
        }}
        onNewTask={() => {
          setSearchOpen(false);
          setNewTask(true);
        }}
        onSwitchView={(nextView) => {
          setPage('sessions');
          setTab(nextView);
          setSearchOpen(false);
        }}
      />

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

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

const SHORTCUTS: [string, string][] = [
  ['⌘K', 'Search tasks and commands'],
  ['⌘N', 'New task'],
  ['⌘↵', 'Approve the plan (when it is waiting)'],
  ['⌘R', 'Request changes to the plan (when it is waiting)'],
  ['[  ]', 'Step back / forward one event'],
  ['L', 'Back to live'],
  ['Esc', 'Close the inspector'],
  ['?', 'This list'],
];

function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts">
      <dl className={s.shortcuts}>
        {SHORTCUTS.map(([k, label]) => (
          <div key={k} className={s.shortcutRow}>
            <dt>
              {k.split('  ').map((part) => (
                <Kbd key={part}>{part}</Kbd>
              ))}
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
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
