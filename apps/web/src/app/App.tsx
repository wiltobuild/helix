import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  FolderPlus,
  LayoutGrid,
  Network,
  Plus,
  Focus,
  Maximize,
  PanelBottom,
  PanelRight,
} from 'lucide-react';
import {
  deriveStatus,
  type BuildView,
  type HarnessInfo,
  type HelixEvent,
  type Project,
} from '@helix/contracts';
import {
  AgentBadge,
  ActorBadge,
  Button,
  Dialog,
  Kbd,
  Spinner,
  StatusDot,
  TextField,
  type BoardColumn,
} from '@helix/ui';
import { useHelixSource, type HelixSource } from '../data/useHelixSource';
import { useRun, type RunView } from '../data/useRun';
import { buildWorkspace } from '../data/buildWorkspace';
import { HistoryUnavailable } from './HistoryUnavailable';
import { replayStart } from '../data/recordings';
import { boardCards, relativeTo, type BoardCard } from '../data/describe';
import { formatDuration, planTree } from '../data/observatory';
import { StopAll, runningAgents } from './StopAll';
import {
  DemoStopAll,
  NavRail,
  SessionHeader,
  SessionTabs,
  TopBar,
  type Page,
  type SessionSummary,
  type SessionTab,
} from './Chrome';
import { Board } from './Board';
import { Dock } from './Dock';
import { Inspector } from './Inspector';
import { PlanView } from './PlanView';
import { VisualDesignPanel } from './VisualDesignPanel';
import { NavPage } from './Pages';
import { CommitsView, FilesView } from './SessionViews';
import { NewTaskDialog } from './NewTaskDialog';
import { readyIntakeSession, type PendingIntakeLaunch } from './intakeModel';
import { identityFor, traceLabel } from '../data/identity';
import s from './App.module.css';

export function App() {
  const source = useHelixSource();
  const [newTask, setNewTask] = useState<boolean>();
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [pendingLaunch, setPendingLaunch] = useState<PendingIntakeLaunch | null>(null);
  const pendingSessionId = readyIntakeSession(pendingLaunch, source.project?.id, source.events);
  const connected = source.mode === 'empty' || source.mode === 'live';
  return (
    <>
      {source.mode === 'empty' ? (
        <FirstConversation
          onStart={() => setNewTask(true)}
          onRegister={() => setAddRepoOpen(true)}
        />
      ) : source.events.length === 0 ? (
        <div className={s.loading}>
          <Spinner size={18} label="Connecting to Helix" />
        </div>
      ) : (
        <Workspace
          key={source.sourceId}
          events={source.events}
          source={source}
          setNewTask={setNewTask}
          setAddRepoOpen={setAddRepoOpen}
          pendingSessionId={pendingSessionId}
          onIntakeOpened={() => setPendingLaunch(null)}
        />
      )}
      <NewTaskDialog
        open={newTask ?? source.mode === 'empty'}
        onOpenChange={setNewTask}
        {...(connected && source.client
          ? {
              client: source.client,
              projects: source.projects,
              ...(source.project ? { project: source.project } : {}),
            }
          : {})}
        onSelectProject={source.selectProject}
        onAddProject={() => setAddRepoOpen(true)}
        onCreated={(id, projectId) => {
          if (!projectId) return;
          setPendingLaunch({ id, projectId });
          if (source.project?.id !== projectId) source.selectProject(projectId);
        }}
      />
      <AddRepositoryDialog
        open={addRepoOpen}
        onOpenChange={setAddRepoOpen}
        demo={!connected}
        onAdd={source.addProject}
      />
    </>
  );
}

export function FirstConversation({
  onStart,
  onRegister,
}: {
  onStart: () => void;
  onRegister: () => void;
}) {
  return (
    <main className={s.loading}>
      <div>
        <h1>Start with an idea.</h1>
        <p>No repository needed. Let’s work out what to build together.</p>
        <Button onClick={onStart}>Continue the conversation</Button>
        <Button variant="ghost" onClick={onRegister}>
          Connect an existing repository
        </Button>
      </div>
    </main>
  );
}

function Workspace({
  events,
  source,
  setNewTask,
  setAddRepoOpen,
  pendingSessionId,
  onIntakeOpened,
}: {
  events: readonly HelixEvent[];
  source: HelixSource;
  setNewTask: (open: boolean) => void;
  setAddRepoOpen: (open: boolean) => void;
  pendingSessionId: string | undefined;
  onIntakeOpened: () => void;
}) {
  const run = useRun(events, {
    recorded: source.mode !== 'live',
    speed: source.speed,
    startAt:
      source.demoPreset === 'laptop' ? events.length - 1 : Math.max(0, replayStart(events) - 1),
    sourceId: source.sourceId,
    connected: source.mode === 'live' && source.stream === 'live',
  });
  if ('error' in run)
    return <HistoryUnavailable error={run.error} events={events} source={source} />;
  return (
    <ProjectedWorkspace
      run={run}
      source={source}
      setNewTask={setNewTask}
      setAddRepoOpen={setAddRepoOpen}
      pendingSessionId={pendingSessionId}
      onIntakeOpened={onIntakeOpened}
    />
  );
}

function ProjectedWorkspace({
  run,
  source,
  setNewTask,
  setAddRepoOpen,
  pendingSessionId,
  onIntakeOpened,
}: {
  run: RunView;
  source: HelixSource;
  setNewTask: (open: boolean) => void;
  setAddRepoOpen: (open: boolean) => void;
  pendingSessionId: string | undefined;
  onIntakeOpened: () => void;
}) {
  const { bySeq, current } = run;
  const [selectedBuild, setSelectedBuild] = useState<string>();
  const { builds, build, state } = useMemo(
    () => buildWorkspace(run.state, selectedBuild),
    [run.state, selectedBuild],
  );
  const [selected, setSelected] = useState<string | null | undefined>(() =>
    window.matchMedia('(max-width: 1440px), (max-height: 900px)').matches ? null : undefined,
  );
  const [inspectorTab, setInspectorTab] = useState('summary');
  const [tabOverride, setTab] = useState<SessionTab | null>(null);
  const [page, setPage] = useState<Page>('sessions');
  const [dockExpanded, setDockExpanded] = useState(false);
  const [graphFocus, setGraphFocus] = useState(false);
  const [graphControls, setGraphControls] = useState<HTMLDivElement | null>(null);
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [activityHidden, setActivityHidden] = useState(
    () => window.matchMedia('(max-width: 1440px), (max-height: 900px)').matches,
  );
  const [activityHeight, setActivityHeight] = useState(220);
  const [fullscreenNotice, setFullscreenNotice] = useState('');
  const fullscreenOwned = useRef(false);
  const focusButton = useRef<HTMLButtonElement>(null);
  const beforeFocus = useRef({ inspectorHidden: false, activityHidden: false });
  const enterFocus = () => {
    if (!graphFocus) beforeFocus.current = { inspectorHidden, activityHidden };
    setGraphFocus(true);
    setInspectorHidden(true);
    setActivityHidden(true);
  };
  const exitFocus = () => {
    setGraphFocus(false);
    setInspectorHidden(beforeFocus.current.inspectorHidden);
    setActivityHidden(beforeFocus.current.activityHidden);
    setFullscreenNotice('');
    if (fullscreenOwned.current && document.fullscreenElement)
      void document.exitFullscreen().catch(() => {});
    fullscreenOwned.current = false;
    focusButton.current?.focus();
  };
  const enterFullscreen = async () => {
    enterFocus();
    try {
      // Include body portals so approval dialogs remain visible above the graph.
      if (!document.documentElement.requestFullscreen) throw new Error('Unsupported');
      await document.documentElement.requestFullscreen();
      fullscreenOwned.current = true;
      setFullscreenNotice('');
    } catch {
      setFullscreenNotice('Fullscreen unavailable. Workspace focus is active.');
    }
  };
  useEffect(() => {
    const changed = () => {
      if (document.fullscreenElement || !fullscreenOwned.current) return;
      fullscreenOwned.current = false;
      setGraphFocus(false);
      setInspectorHidden(beforeFocus.current.inspectorHidden);
      setActivityHidden(beforeFocus.current.activityHidden);
      focusButton.current?.focus();
    };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    if (!pendingSessionId) return;
    let cancelled = false;
    // The source has delivered the destination's session. Apply navigation after this commit;
    // a source change/unmount cancels the pending handoff instead of opening a stale session.
    queueMicrotask(() => {
      if (cancelled) return;
      run.goLive();
      setPage('sessions');
      setSelectedBuild(pendingSessionId);
      setInspectorHidden(false);
      setSelected(pendingSessionId);
      setInspectorTab('summary');
      setTab('plan');
      onIntakeOpened();
    });
    return () => {
      cancelled = true;
    };
  }, [pendingSessionId, onIntakeOpened, run]);

  const selectSession = (id: string, tab = 'summary') => {
    const owner = builds.find((b) => b.sessionIds.some((sessionId) => sessionId === id));
    setSelectedBuild(owner?.rootSessionId ?? id);
    setInspectorHidden(false);
    setSelected(id);
    setInspectorTab(tab);
    setTab((currentTab) =>
      currentTab === 'visual' || (currentTab === null && needsVisualDecision) ? 'plan' : currentTab,
    );
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
  const hasVisualDesign = Object.values(state.sessions).some((session) => session.design);
  const needsVisualDecision = Object.values(state.sessions).some(
    (session) => session.design && session.design.status !== 'approved',
  );
  const tab: SessionTab = tabOverride ?? (needsVisualDecision ? 'visual' : 'plan');
  const cards = useMemo(() => boardCards(state, bySeq, current.ts), [state, bySeq, current.ts]);
  const searchCards = useMemo(
    () => boardCards(run.state, bySeq, current.ts),
    [run.state, bySeq, current.ts],
  );
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
  const showInspector = !!selectedSession && !(page === 'sessions' && tab === 'visual');
  const live = source.mode === 'live';
  const repoList: readonly Project[] =
    source.projects.length > 0 ? source.projects : [state.project];
  const mode = live && run.isLive ? 'live' : run.playing ? 'replaying' : 'paused';

  const orch = tree
    ? state.sessions[tree.orchestrator.sessionId as keyof typeof state.sessions]
    : undefined;
  const sessionTitle =
    build?.title ?? orch?.session.title ?? cards[0]?.card.title ?? state.project.name;
  const elapsedMs = run.position;

  const active: SessionSummary | undefined = tree
    ? {
        id: tree.orchestrator.sessionId,
        title: sessionTitle,
        identity: identityFor(state, tree.orchestrator.sessionId),
        status:
          tree.orchestrator.tone === 'needs'
            ? 'needs_you'
            : tree.orchestrator.tone === 'done'
              ? 'merged'
              : 'working',
        meta: `${tree.tasks.length} tasks · ${tree.agents.length} agents · ${formatDuration(elapsedMs)} ${run.timeMode} history`,
        live: mode === 'live',
      }
    : build
      ? {
          id: build.rootSessionId,
          title: build.title,
          identity: identityFor(state, build.rootSessionId),
          status: deriveStatus(state.sessions[build.rootSessionId]!),
          meta: '',
          live: mode === 'live',
        }
      : undefined;
  const recent: SessionSummary[] = builds
    .filter((b) => b.rootSessionId !== active?.id)
    .slice(-6)
    .reverse()
    .map((b) => {
      const x = run.state.sessions[b.rootSessionId]!;
      return {
        id: b.rootSessionId,
        title: b.title,
        identity: identityFor(run.state, b.rootSessionId),
        status: deriveStatus(x),
        meta: relativeTo(bySeq.get(x.lastEventSeq)?.ts ?? x.session.createdAt, current.ts),
        live: false,
      };
    });
  const prCount = Object.values(state.sessions).filter((x) => x.pr).length;

  // Keyboard: [ ] step, L live, ⌘N new task, ⌘K search, ? shortcuts, Esc closes the inspector.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]'))
        return;
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
      else if (e.key === 'Escape') {
        if (graphFocus) {
          if (!inspectorHidden && selectedSession) setInspectorHidden(true);
          else exitFocus();
        } else setInspectorHidden(true);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const stopAll =
    live && source.client ? (
      <StopAll
        client={source.client}
        projectId={state.project.id}
        running={runningAgents(run.state)}
        canAct={run.isLive}
      />
    ) : (
      <DemoStopAll />
    );

  return (
    <div
      className={s.shell}
      data-inspector={showInspector && !inspectorHidden ? 'open' : 'closed'}
      data-graph-focus={graphFocus || undefined}
      data-inspector-hidden={inspectorHidden || undefined}
    >
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
        onOpenSession={openFromPage}
        onSettings={() => setSettingsOpen(true)}
      />

      <main className={s.main}>
        {page === 'sessions' && (
          <div className={s.sessionChrome}>
            <SessionHeader
              hideTabs
              state={state}
              source={source}
              title={sessionTitle}
              {...(build ? { goal: build.goal, build } : tree ? { goal: tree.plan.goal } : {})}
              mode={mode}
              elapsedMs={elapsedMs}
              timeMode={run.timeMode}
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
          </div>
        )}
        <div className={s.workspaceBar}>
          {page === 'sessions' && !graphFocus && (
            <SessionTabs tab={tab} onTab={setTab} counts={{ board: activeCount }} />
          )}
          {/* Shared by every view: hidden activity and focus must always have a visible exit. */}
          <div className={s.graphTools} role="group" aria-label="Workspace display controls">
            {(graphFocus || (page === 'sessions' && (tab === 'plan' || tab === 'visual'))) && (
              <>
                <Button
                  size="sm"
                  ref={focusButton}
                  onClick={graphFocus ? exitFocus : enterFocus}
                  aria-label={
                    graphFocus
                      ? 'Exit focus (Esc)'
                      : tab === 'visual'
                        ? 'Focus design'
                        : 'Focus graph'
                  }
                  icon={<Focus size={14} aria-hidden />}
                >
                  <span className={s.controlLabel}>
                    {graphFocus
                      ? 'Exit focus (Esc)'
                      : tab === 'visual'
                        ? 'Focus design'
                        : 'Focus graph'}
                  </span>
                </Button>
                <Button
                  size="sm"
                  aria-label="Fullscreen workspace"
                  icon={<Maximize size={14} aria-hidden />}
                  onClick={() => void enterFullscreen()}
                >
                  <span className={s.controlLabel}>Fullscreen workspace</span>
                </Button>
              </>
            )}
            {selectedSession && !(page === 'sessions' && tab === 'visual') && (
              <Button
                size="sm"
                aria-label={inspectorHidden ? 'Show selected agent' : 'Hide inspector'}
                icon={<PanelRight size={14} aria-hidden />}
                aria-pressed={!inspectorHidden}
                onClick={() => setInspectorHidden((hidden) => !hidden)}
              >
                <span className={s.controlLabel}>
                  {inspectorHidden ? 'Show selected agent' : 'Hide inspector'}
                </span>
              </Button>
            )}
            <Button
              size="sm"
              aria-label={activityHidden ? 'Show activity' : 'Hide activity'}
              icon={<PanelBottom size={14} aria-hidden />}
              aria-pressed={!activityHidden}
              onClick={() => setActivityHidden((hidden) => !hidden)}
            >
              <span className={s.controlLabel}>
                {activityHidden ? 'Show activity' : 'Hide activity'}
              </span>
            </Button>
            {!activityHidden && (
              <label className={s.panelSize}>
                <span className={s.controlLabel}>Activity height</span>
                <input
                  aria-label="Activity height"
                  type="range"
                  min="120"
                  max="400"
                  step="20"
                  value={activityHeight}
                  onChange={(event) => {
                    setActivityHeight(Number(event.target.value));
                    setDockExpanded(false);
                  }}
                />
              </label>
            )}
            <div ref={setGraphControls} />
            {graphFocus && stopAll}
            {fullscreenNotice && <span role="status">{fullscreenNotice}</span>}
          </div>
        </div>
        {page === 'sessions' ? (
          <>
            <div className={s.content}>
              {tab !== 'visual' && hasVisualDesign && (
                <div className={s.planBanner} role="status">
                  <span>
                    {needsVisualDecision
                      ? 'A visual direction needs your input.'
                      : 'The approved visual direction is available.'}
                  </span>
                  <Button size="sm" onClick={() => setTab('visual')}>
                    Open design workspace
                  </Button>
                </div>
              )}
              {tab === 'visual' && (
                <VisualDesignPanel
                  state={state}
                  events={run.events}
                  selected={effectiveSelected}
                  isLive={live && run.isLive}
                  connected={source.stream === 'live'}
                  {...(live && source.client ? { client: source.client } : {})}
                />
              )}
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
                  controlsContainer={graphControls}
                  state={state}
                  onFollowLive={() => {
                    setSelected(null);
                    setInspectorHidden(true);
                    if (live) run.goLive();
                  }}
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
              state={page === 'tasks' || page === 'agents' || page === 'prs' ? state : run.state}
              events={run.events}
              index={run.index}
              tree={tree}
              onOpen={openFromPage}
              onSeek={run.seek}
              onPage={setPage}
            />
          </div>
        )}
        <div
          className={s.activityPanel}
          hidden={activityHidden}
          style={{ height: dockExpanded ? '45vh' : activityHeight }}
        >
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
        </div>
      </main>

      {selectedSession && showInspector && (
        <Inspector
          key={selectedSession.session.id}
          tab={inspectorTab}
          onTabChange={setInspectorTab}
          onSelect={selectSession}
          session={selectedSession}
          state={state}
          events={run.events}
          upTo={current.seq}
          onClose={() => setInspectorHidden(true)}
          onJump={(seq) => run.seek(run.events.findIndex((e) => e.seq === seq))}
          {...(tree ? { tree } : {})}
          {...(live && source.client ? { client: source.client, isLive: run.isLive } : {})}
        />
      )}

      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        cards={searchCards}
        builds={builds}
        onSelectSession={(id) => {
          openFromPage(id);
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
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['⌘K', 'Search tasks and commands'],
  ['⌘N', 'New build'],
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
  builds,
  onSelectSession,
  onNewTask,
  onSwitchView,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cards: readonly BoardCard[];
  builds: readonly BuildView[];
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
          c.identity.name.toLowerCase().includes(q) ||
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
      description="Find any build in this project, filter agent tasks, or run a workspace command."
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
        <div className={s.searchList} aria-label="Matching builds">
          {builds
            .filter((b) => `${b.title} ${b.goal}`.toLowerCase().includes(q))
            .map((b) => (
              <button
                key={b.rootSessionId}
                type="button"
                className={s.searchItem}
                onClick={() => onSelectSession(b.rootSessionId)}
              >
                <span className={s.searchItemTitle}>{b.title}</span>
                <span className={s.searchItemMeta}>Build</span>
              </button>
            ))}
        </div>
        <div className={s.searchList} role="listbox" aria-label="Matching tasks">
          {matches.map((c) => (
            <button
              key={c.id}
              type="button"
              className={s.searchItem}
              onClick={() => onSelectSession(c.id)}
            >
              <StatusDot status={c.status} />
              <span className={s.searchItemTitle}>
                <ActorBadge
                  {...c.identity}
                  title={traceLabel(c.identity)}
                  active={c.status === 'working'}
                />
                <span>{c.card.title}</span>
              </span>
              {c.card.branch && <span className={s.searchItemMeta}>{c.card.branch}</span>}
            </button>
          ))}
          {matches.length === 0 && (
            <p className={s.searchEmpty}>No tasks match “{query.trim()}”.</p>
          )}
        </div>
        <div className={s.quickActions}>
          <Button size="sm" icon={<Plus size={13} />} onClick={onNewTask}>
            New build
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
