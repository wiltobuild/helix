import { Bell, FolderGit2, Search, Settings } from 'lucide-react';
import { HelixLogo, Kbd, SectionLabel, StatusDot, cx } from '@helix/ui';
import type { Project } from '@helix/contracts';
import type { BoardCard } from '../data/describe';
import s from './Sidebar.module.css';

interface SidebarProps {
  project: Project;
  cards: BoardCard[];
  needsYou: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onSearch?: () => void;
  onSettings?: () => void;
  demo?: boolean;
  /** Live event stream status (live mode only). */
  stream?: 'connecting' | 'live' | 'reconnecting' | 'closed';
}

export function Sidebar({
  project,
  cards,
  needsYou,
  selected,
  onSelect,
  onSearch,
  onSettings,
  demo,
  stream,
}: SidebarProps) {
  const active = cards.filter((c) => c.column !== 'archive');
  const done = cards.filter((c) => c.column === 'archive');
  const hasWorking = active.some((c) => c.status === 'working');
  return (
    <nav className={s.sidebar} aria-label="Workspace">
      <div className={s.brand}>
        <HelixLogo size={22} active={hasWorking} />
        <span className={s.wordmark}>helix</span>
        {demo && <span className={s.demo}>demo</span>}
        {stream && (
          <span className={cx(s.stream, s[stream])} title={`Event stream: ${stream}`}>
            {stream === 'live' ? 'live' : stream === 'closed' ? 'offline' : 'connecting'}
          </span>
        )}
      </div>

      <button type="button" className={s.search} onClick={onSearch}>
        <Search size={14} aria-hidden />
        <span>Search</span>
        <Kbd>⌘K</Kbd>
      </button>

      <button
        type="button"
        className={cx(s.item, s.needs, needsYou > 0 && s.hasNeeds)}
        onClick={() => {
          const first = cards.find((c) => c.column === 'needs_you');
          if (first) onSelect(first.id);
        }}
      >
        <Bell size={15} aria-hidden />
        <span>Needs you</span>
        <span className={s.count}>{needsYou}</span>
      </button>

      <div className={s.group}>
        <SectionLabel>Projects</SectionLabel>
        <div className={cx(s.item, s.project)}>
          <FolderGit2 size={15} aria-hidden />
          <span>{project.name}</span>
        </div>
        <ul className={s.sessions}>
          {active.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={cx(s.session, selected === c.id && s.selected)}
                onClick={() => onSelect(c.id)}
                aria-current={selected === c.id || undefined}
              >
                <StatusDot status={c.status} />
                <span>{c.card.title}</span>
              </button>
            </li>
          ))}
        </ul>
        {done.length > 0 && (
          <>
            <p className={s.done}>{done.length} merged or archived</p>
            <ul className={s.sessions}>
              {done.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={cx(s.session, selected === c.id && s.selected)}
                    onClick={() => onSelect(c.id)}
                    aria-current={selected === c.id || undefined}
                  >
                    <StatusDot status={c.status} />
                    <span>{c.card.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className={s.footer}>
        <button type="button" className={s.item} onClick={onSettings}>
          <Settings size={15} aria-hidden />
          <span>Settings</span>
        </button>
      </div>
    </nav>
  );
}
