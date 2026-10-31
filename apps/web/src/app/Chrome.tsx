import type { BuildView } from '@helix/contracts';
import { BuildStages } from './BuildStages';
import { useRef, type ReactNode } from 'react';
import {
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FileUp,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  Keyboard,
  LayoutDashboard,
  ListChecks,
  Plus,
  Rocket,
  Search,
  Settings,
  SquareStack,
} from 'lucide-react';
import type { Project, ProjectState } from '@helix/contracts';
import {
  ActorBadge,
  Button,
  HelixLogo,
  IconButton,
  Kbd,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Segmented,
  StatusDot,
  Tooltip,
  cx,
  type DisplayStatus,
} from '@helix/ui';
import type { HelixSource } from '../data/useHelixSource';
import { DEMO_SCENARIOS } from '../data/demoScenarios';
import { formatDuration } from '../data/observatory';
import { traceLabel, type ActorIdentity } from '../data/identity';
import s from './Chrome.module.css';

export type Page = 'overview' | 'sessions' | 'tasks' | 'agents' | 'prs' | 'ci' | 'knowledge';

/* ------------------------------------------------------------------ top bar */

export function TopBar({
  source,
  working,
  onSearch,
  onSettings,
  onShortcuts,
}: {
  source: HelixSource;
  working: number;
  onSearch: () => void;
  onSettings: () => void;
  onShortcuts: () => void;
}) {
  const live = source.mode === 'live';
  return (
    <header className={s.topbar}>
      <div className={s.brand}>
        <span className={s.wordmark}>Helix</span>
        <HelixLogo size={24} active={working > 0} />
        <span className={s.tagline}>Coding Agent Orchestrator</span>
        {!live && <span className={s.demoTag}>Demo</span>}
      </div>

      {!live && source.selectDemoPreset && (
        <div className={s.scenario}>
          <span className={s.scenarioLabel}>Scenario</span>
          <Segmented
            label="Demo scenario"
            size="sm"
            value={source.demoPreset ?? 'multi-agent'}
            onValueChange={(v) => {
              const scenario = DEMO_SCENARIOS.find((item) => item.value === v);
              if (scenario) source.selectDemoPreset?.(scenario.value);
            }}
            items={[...DEMO_SCENARIOS]}
          />
        </div>
      )}

      <button type="button" className={s.search} onClick={onSearch}>
        <Search size={14} aria-hidden />
        <span>Search tasks, files, logs…</span>
        <Kbd>⌘K</Kbd>
      </button>

      <div className={s.topRight}>
        <span className={s.running} data-on={working > 0 || undefined} role="status">
          <span className={s.runningDot} aria-hidden />
          {working > 0
            ? `${working} ${working === 1 ? 'agent' : 'agents'} running`
            : 'No agents running'}
        </span>
        <IconButton
          label="Keyboard shortcuts"
          shortcut="?"
          icon={<Keyboard size={16} />}
          onClick={onShortcuts}
        />
        <IconButton label="Settings" icon={<Settings size={16} />} onClick={onSettings} />
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ left nav */

export interface SessionSummary {
  identity?: ActorIdentity | undefined;
  id: string;
  title: string;
  status: DisplayStatus;
  meta: string;
  live: boolean;
}

const NAV: { page: Page; label: string; icon: ReactNode }[] = [
  { page: 'overview', label: 'Overview', icon: <LayoutDashboard size={16} /> },
  { page: 'sessions', label: 'Builds', icon: <SquareStack size={16} /> },
  { page: 'tasks', label: 'Tasks', icon: <ListChecks size={16} /> },
  { page: 'agents', label: 'Agents', icon: <Bot size={16} /> },
  { page: 'prs', label: 'Pull requests', icon: <GitPullRequest size={16} /> },
  { page: 'ci', label: 'CI / Deployments', icon: <Rocket size={16} /> },
  { page: 'knowledge', label: 'Knowledge', icon: <BookOpen size={16} /> },
];

export function NavRail({
  project,
  page,
  onPage,
  counts,
  active,
  recent,
  onOpenSession,
  onSettings,
}: {
  project: Project;
  page: Page;
  onPage: (p: Page) => void;
  counts: Partial<Record<Page, number>>;
  active?: SessionSummary;
  recent: SessionSummary[];
  onOpenSession: (id: string) => void;
  onSettings: () => void;
}) {
  return (
    <nav className={s.nav} aria-label="Workspace">
      <div className={s.repo}>
        <span className={s.repoRow}>
          <FolderGit2 size={15} aria-hidden />
          <strong>{project.name}</strong>
        </span>
        <span className={s.repoRow} data-muted>
          {project.github ? (
            <GitBranch size={14} aria-hidden />
          ) : (
            <FolderGit2 size={14} aria-hidden />
          )}
          {project.github ? `${project.github.owner}/${project.github.repo}` : project.repoPath}
        </span>
      </div>

      <ul className={s.navList}>
        {NAV.map((item) => (
          <li key={item.page}>
            <button
              type="button"
              className={cx(s.navItem, page === item.page && s.navActive)}
              aria-current={page === item.page ? 'page' : undefined}
              onClick={() => onPage(item.page)}
            >
              {item.icon}
              <span>{item.label}</span>
              {counts[item.page] ? <span className={s.navCount}>{counts[item.page]}</span> : null}
            </button>
          </li>
        ))}
        <li>
          <button type="button" className={s.navItem} onClick={onSettings}>
            <Settings size={16} />
            <span>Settings</span>
          </button>
        </li>
      </ul>

      {active && (
        <div className={s.navSection}>
          <span className={s.navHeading}>Selected build</span>
          <button
            type="button"
            className={s.activeCard}
            onClick={() => {
              onPage('sessions');
              onOpenSession(active.id);
            }}
          >
            <span className={s.activeTop}>
              <span className={s.activeTitle}>
                {active.identity && (
                  <ActorBadge {...active.identity} title={traceLabel(active.identity)} />
                )}
                {active.title}
              </span>
              <span className={s.liveTag} data-live={active.live || undefined}>
                <span className={s.liveDot} aria-hidden />
                {active.live ? 'Live' : 'Replay'}
              </span>
            </span>
            <span className={s.activeMeta}>{active.meta}</span>
          </button>
        </div>
      )}

      <div className={s.navSection} data-grow>
        <span className={s.navHeading}>Recent builds</span>
        {recent.length === 0 ? (
          <p className={s.navEmpty}>No other builds in this project yet.</p>
        ) : (
          <ul className={s.recent}>
            {recent.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={s.recentItem}
                  onClick={() => {
                    onPage('sessions');
                    onOpenSession(r.id);
                  }}
                >
                  <StatusDot status={r.status} />
                  <span className={s.recentTitle}>
                    {r.identity && <ActorBadge {...r.identity} title={traceLabel(r.identity)} />}
                    {r.title}
                  </span>
                  <span className={s.recentMeta}>{r.meta}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------- session header */

export type SessionTab = 'board' | 'plan' | 'visual' | 'output' | 'files' | 'commits';

export function SessionHeader({
  state,
  source,
  title,
  goal,
  build,
  mode,
  elapsedMs,
  timeMode = 'elapsed',
  tab,
  onTab,
  counts,
  onNewTask,
  onAddRepo,
  onSelectRepo,
  stopAll,
  repos,
  activeCount,
  hideTabs = false,
}: {
  state: ProjectState;
  source: HelixSource;
  title: string;
  goal?: string;
  build?: BuildView;
  mode: 'live' | 'replaying' | 'recording' | 'paused';
  elapsedMs: number;
  timeMode?: 'active' | 'elapsed';
  tab: SessionTab;
  onTab: (t: SessionTab) => void;
  counts: Partial<Record<SessionTab, number>>;
  onNewTask: () => void;
  onAddRepo: () => void;
  onSelectRepo: (id: string) => void;
  stopAll: ReactNode;
  repos: readonly Project[];
  activeCount: number;
  hideTabs?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const p = state.project;
  const recorded = source.recording
    ? new Date(source.recording.header.recordedAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : undefined;
  return (
    <div className={s.sessionHead} data-tabs-hidden={hideTabs || undefined}>
      <ol className={s.crumbs} aria-label="Breadcrumbs">
        <li>helix</li>
        <li aria-hidden>/</li>
        <li>{p.github?.owner ?? 'local'}</li>
        <li aria-hidden>/</li>
        <li>{p.github?.repo ?? p.name}</li>
        <li aria-hidden>
          <ChevronRight size={12} />
        </li>
        <li>Builds</li>
        <li aria-hidden>
          <ChevronRight size={12} />
        </li>
        <li className={s.crumbCurrent}>{title}</li>
      </ol>

      <div className={s.titleRow}>
        <div className={s.titleBlock}>
          <h1 className={s.title}>
            <span className={s.titleText}>{title}</span>
            <span className={s.modeBadge} data-mode={mode}>
              <span className={s.liveDot} aria-hidden />
              {mode === 'live'
                ? 'Live'
                : mode === 'replaying'
                  ? 'Replaying'
                  : mode === 'paused'
                    ? 'Paused'
                    : 'Recorded run'}
            </span>
          </h1>
          {goal && (
            <p className={s.goal} title={goal}>
              {goal}
            </p>
          )}
          {build && <BuildStages build={build} />}
          <p className={s.subMeta}>
            {recorded ? `Recorded ${recorded} · ` : source.mode !== 'live' ? 'Example run · ' : ''}
            {formatDuration(elapsedMs)} {timeMode} project history
            {source.recordingError && (
              <span className={s.recordingError} role="alert">
                {' '}
                · {source.recordingError}
              </span>
            )}
          </p>
        </div>

        <div className={s.headActions}>
          <input
            ref={input}
            type="file"
            accept=".helixlog"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void source.openRecording(file);
            }}
          />
          <Menu
            align="end"
            trigger={
              <IconButton label="More actions" variant="secondary" icon={<Ellipsis size={16} />} />
            }
          >
            <MenuItem icon={<FileUp size={14} />} onSelect={() => input.current?.click()}>
              Open recording…
            </MenuItem>
            <MenuItem icon={<FolderPlus size={14} />} onSelect={onAddRepo}>
              Add repository…
            </MenuItem>
          </Menu>
          <Menu
            align="end"
            trigger={
              <Button variant="outline" icon={<Plus size={14} />} shortcut="⌘N">
                Tasks
                <ChevronDown size={13} aria-hidden />
              </Button>
            }
          >
            <MenuItem icon={<Plus size={14} />} shortcut="⌘N" onSelect={onNewTask}>
              New build
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>Repositories</MenuLabel>
            {repos.map((repo) => {
              const isCurrent = repo.id === p.id;
              return (
                <MenuItem
                  key={repo.id}
                  icon={repo.github ? <GitBranch size={14} /> : <FolderGit2 size={14} />}
                  shortcut={isCurrent ? `✓ ${activeCount} active` : repo.defaultBranch}
                  onSelect={() => !isCurrent && onSelectRepo(repo.id)}
                >
                  {repo.github ? `${repo.github.owner}/${repo.github.repo}` : repo.name}
                </MenuItem>
              );
            })}
            <MenuSeparator />
            <MenuItem icon={<FolderPlus size={14} />} onSelect={onAddRepo}>
              Add repository…
            </MenuItem>
          </Menu>
          {stopAll}
        </div>
      </div>

      {!hideTabs && <SessionTabs tab={tab} onTab={onTab} counts={counts} />}
    </div>
  );
}

/** Session navigation stays a tablist; workspace actions are separate sibling controls. */
export function SessionTabs({
  tab,
  onTab,
  counts,
}: {
  tab: SessionTab;
  onTab: (tab: SessionTab) => void;
  counts: Partial<Record<SessionTab, number>>;
}) {
  return (
    <div className={s.tabs} role="tablist" aria-label="Build views">
      {(
        [
          ['board', 'Board'],
          ['plan', 'Plan'],
          ['visual', 'Design'],
          ['output', 'Output'],
          ['files', 'Files'],
          ['commits', 'Commits'],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={tab === value}
          className={cx(s.tab, tab === value && s.tabActive)}
          onClick={() => onTab(value)}
        >
          {label}
          {counts[value] ? <span className={s.tabCount}>{counts[value]}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Stop all, styled for the header. In demo mode it is shown but disabled. */
export function DemoStopAll() {
  return (
    <Tooltip content="Stop all works in a live run">
      <span>
        <Button variant="stop" disabled>
          Stop all
        </Button>
      </span>
    </Tooltip>
  );
}
