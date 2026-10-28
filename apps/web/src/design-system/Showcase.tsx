import { useState, type ReactNode } from 'react';
import {
  Archive,
  CheckCheck,
  GitMerge,
  LayoutGrid,
  Monitor,
  Moon,
  MoreHorizontal,
  Network,
  Plus,
  Search,
  Square,
  Sun,
} from 'lucide-react';
import {
  AgentBadge,
  Button,
  Dialog,
  EmptyState,
  HelixLogo,
  IconButton,
  Kbd,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  SectionLabel,
  Segmented,
  SessionCard,
  Skeleton,
  Spinner,
  StatusDot,
  StatusPill,
  Switch,
  TabPanel,
  Tabs,
  TextArea,
  TextField,
  Tooltip,
  columnMeta,
  statusMeta,
  toneVar,
  useTheme,
  type BoardColumn,
  type DisplayStatus,
  type ThemePreference,
} from '@helix/ui';
import { boardSample } from './sample';
import s from './Showcase.module.css';

const STATUSES = Object.keys(statusMeta) as DisplayStatus[];
const COLUMNS: BoardColumn[] = ['pending', 'working', 'needs_you', 'in_review', 'ready_to_merge'];

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={s.section}>
      <header className={s.sectionHead}>
        <h2>{title}</h2>
        {note && <p>{note}</p>}
      </header>
      {children}
    </section>
  );
}

function Swatch({ name, label }: { name: string; label?: string }) {
  return (
    <div className={s.swatch}>
      <span className={s.chip} style={{ background: `var(${name})` }} />
      <code>{name}</code>
      {label && <span className={s.swatchLabel}>{label}</span>}
    </div>
  );
}

function ThemeSwitch() {
  const { preference, setPreference } = useTheme();
  return (
    <Segmented
      label="Theme"
      size="sm"
      value={preference}
      onValueChange={(v) => setPreference(v as ThemePreference)}
      items={[
        { value: 'system', label: 'System', icon: <Monitor size={13} /> },
        { value: 'dark', label: 'Dark', icon: <Moon size={13} /> },
        { value: 'light', label: 'Light', icon: <Sun size={13} /> },
      ]}
    />
  );
}

export function Showcase() {
  const [tab, setTab] = useState('summary');
  const [view, setView] = useState('board');
  const [dialog, setDialog] = useState(false);
  const [autoReview, setAutoReview] = useState(true);
  const [selected, setSelected] = useState<string | null>('api');

  return (
    <div className={s.page}>
      <header className={s.top}>
        <div className={s.brand}>
          <HelixLogo size={24} active />
          <span className={s.wordmark}>helix</span>
          <span className={s.tag}>design system · v0</span>
        </div>
        <ThemeSwitch />
      </header>

      <main className={s.main}>
        <Section
          id="board"
          title="Board"
          note="The home screen. Attention first: what needs you is visible in two seconds."
        >
          <div className={s.boardBar}>
            <Segmented
              label="View"
              value={view}
              onValueChange={setView}
              items={[
                { value: 'board', label: 'Board', icon: <LayoutGrid size={13} /> },
                { value: 'plan', label: 'Plan', icon: <Network size={13} /> },
              ]}
            />
            <div className={s.row}>
              <TextField
                placeholder="Filter tasks"
                icon={<Search size={14} />}
                aria-label="Filter tasks"
              />
              <Button variant="primary" icon={<Plus size={14} />} shortcut="⌘N">
                New task
              </Button>
            </div>
          </div>
          <div className={s.board}>
            {COLUMNS.map((col) => {
              const cards = boardSample.filter((c) => c.column === col);
              return (
                <div key={col} className={s.column}>
                  <div className={s.columnHead}>
                    <span
                      className={s.columnDot}
                      style={{ background: toneVar(columnMeta[col].tone) }}
                    />
                    <SectionLabel count={cards.length}>{columnMeta[col].label}</SectionLabel>
                  </div>
                  {cards.map((c) => (
                    <SessionCard
                      key={c.id}
                      {...c.card}
                      selected={selected === c.id}
                      onOpen={() => setSelected(c.id)}
                    />
                  ))}
                  {cards.length === 0 && <p className={s.columnEmpty}>Nothing here</p>}
                </div>
              );
            })}
          </div>
        </Section>

        <Section
          id="status"
          title="Status"
          note="Derived, never stored. Always icon + label; color reinforces, never carries meaning alone."
        >
          <div className={s.wrap}>
            {STATUSES.map((st) => (
              <StatusPill key={st} status={st} />
            ))}
          </div>
          <div className={s.wrap}>
            {STATUSES.map((st) => (
              <StatusPill key={st} status={st} variant="inline" />
            ))}
          </div>
          <div className={s.wrap}>
            {STATUSES.slice(0, 8).map((st) => (
              <span key={st} className={s.dotRow}>
                <StatusDot status={st} /> {statusMeta[st].label}
              </span>
            ))}
          </div>
        </Section>

        <Section
          id="agents"
          title="Agents"
          note="Two strands. Claude orange is Claude Code, teal is Codex."
        >
          <div className={s.wrap}>
            <AgentBadge agent="claude-code" variant="full" model="opus" active />
            <AgentBadge agent="codex" variant="full" model="gpt-6-astra" active />
            <AgentBadge agent="claude-code" />
            <AgentBadge agent="codex" />
            <AgentBadge agent="claude-code" variant="glyph" active />
            <AgentBadge agent="codex" variant="glyph" active />
          </div>
        </Section>

        <Section id="actions" title="Actions">
          <div className={s.wrap}>
            <Button variant="primary" icon={<GitMerge size={14} />}>
              Merge PR
            </Button>
            <Button icon={<CheckCheck size={14} />}>Approve once</Button>
            <Button variant="ghost">Request change</Button>
            <Button variant="danger" icon={<Square size={13} />}>
              Stop agent
            </Button>
            <Button loading>Starting</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className={s.wrap}>
            <Button size="sm" variant="primary">
              Merge
            </Button>
            <Button size="sm">Answer</Button>
            <IconButton label="Archive" shortcut="E" icon={<Archive size={15} />} />
            <Menu trigger={<IconButton label="More actions" icon={<MoreHorizontal size={16} />} />}>
              <MenuLabel>Session</MenuLabel>
              <MenuItem icon={<GitMerge size={14} />} shortcut="⌘↵">
                Merge pull request
              </MenuItem>
              <MenuItem icon={<Archive size={14} />} shortcut="E">
                Archive
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Square size={13} />} danger>
                Stop agent
              </MenuItem>
            </Menu>
            <Tooltip content="Open the command palette" shortcut="⌘K">
              <Button variant="ghost" icon={<Search size={14} />}>
                Search
              </Button>
            </Tooltip>
            <span className={s.kbds}>
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
              <Kbd>J</Kbd>
              <Kbd>[</Kbd>
              <Kbd>]</Kbd>
            </span>
          </div>
        </Section>

        <Section id="panes" title="Panes & inputs">
          <div className={s.split}>
            <div className={s.pane}>
              <Tabs
                value={tab}
                onValueChange={setTab}
                items={[
                  { value: 'summary', label: 'Summary' },
                  { value: 'files', label: 'Files', count: 6 },
                  { value: 'pr', label: 'PR & CI' },
                ]}
              >
                <TabPanel value="summary" className={s.paneBody}>
                  <div className={s.kv}>
                    <span>Status</span>
                    <StatusPill status="ci_failed" label="CI failed · token.test.ts" />
                    <span>Agent</span>
                    <AgentBadge agent="codex" variant="full" model="gpt-6-astra" />
                    <span>Branch</span>
                    <code>helix/reset-api</code>
                    <span>Checks</span>
                    <span className="tabular">18 / 19 passed</span>
                  </div>
                  <Switch
                    checked={autoReview}
                    onCheckedChange={setAutoReview}
                    label="Auto review"
                    description="Run a reviewer agent when the PR is ready. Never merges on its own."
                  />
                </TabPanel>
                <TabPanel value="files" className={s.paneBody}>
                  <div className={s.skeletons}>
                    <Skeleton width="60%" />
                    <Skeleton width="85%" />
                    <Skeleton width="40%" />
                    <Spinner />
                  </div>
                </TabPanel>
                <TabPanel value="pr" className={s.paneBody}>
                  <EmptyState
                    icon={<GitMerge size={18} />}
                    title="No pull request yet"
                    description="The agent opens one when its task is done. Helix tracks CI and reviews from there."
                  />
                </TabPanel>
              </Tabs>
            </div>
            <div className={s.pane}>
              <div className={s.paneBody}>
                <TextField label="Task" placeholder="Add password reset to the login flow" />
                <TextArea
                  label="What should the agent do?"
                  hint="Enter to start · Shift+Enter for a new line"
                  placeholder="Describe the outcome, not the steps."
                />
                <TextField
                  label="Base branch"
                  defaultValue="main"
                  error="Branch main has uncommitted changes in your checkout."
                />
                <div className={s.row}>
                  <Button variant="primary" onClick={() => setDialog(true)}>
                    Open dialog
                  </Button>
                </div>
              </div>
            </div>
          </div>
          <Dialog
            open={dialog}
            onOpenChange={setDialog}
            title="Approve database migration?"
            description="Claude Code wants to run a command in helix/reset-ui."
            footer={
              <>
                <Button variant="ghost" onClick={() => setDialog(false)}>
                  Reject
                </Button>
                <Button onClick={() => setDialog(false)}>Request change</Button>
                <Button variant="primary" onClick={() => setDialog(false)}>
                  Approve once
                </Button>
              </>
            }
          >
            <pre className={s.code}>pnpm db:migrate --name add_reset_tokens</pre>
          </Dialog>
        </Section>

        <Section id="empty" title="Empty states" note="Every empty state names the next step.">
          <div className={s.split}>
            <div className={s.pane}>
              <EmptyState
                tone="calm"
                icon={<CheckCheck size={18} />}
                title="Nothing needs your attention"
                description="Agents are working. Helix will bring anything that needs a decision here."
              />
            </div>
            <div className={s.pane}>
              <EmptyState
                icon={<Plus size={18} />}
                title="Add your first project"
                description="Point Helix at a local git repository. Agents work in their own branches, never in your checkout."
                action={<Button variant="primary">Add repository</Button>}
              />
            </div>
          </div>
        </Section>

        <Section id="tokens" title="Tokens">
          <div className={s.tokenGrid}>
            <div>
              <SectionLabel>Surfaces</SectionLabel>
              {[
                '--bg',
                '--bg-sunk',
                '--surface',
                '--surface-2',
                '--surface-3',
                '--border',
                '--border-strong',
              ].map((n) => (
                <Swatch key={n} name={n} />
              ))}
            </div>
            <div>
              <SectionLabel>Text & accent</SectionLabel>
              {[
                '--text',
                '--text-2',
                '--text-3',
                '--accent',
                '--strand-claude',
                '--strand-codex',
              ].map((n) => (
                <Swatch key={n} name={n} />
              ))}
            </div>
            <div>
              <SectionLabel>Status</SectionLabel>
              {(
                [
                  ['--status-working', 'working'],
                  ['--status-needs', 'needs you'],
                  ['--status-failed', 'failed'],
                  ['--status-review', 'in review'],
                  ['--status-ready', 'ready'],
                  ['--status-merged', 'merged'],
                  ['--status-pending', 'pending'],
                ] as const
              ).map(([n, l]) => (
                <Swatch key={n} name={n} label={l} />
              ))}
            </div>
          </div>
          <div className={s.typeScale}>
            {(
              [
                ['--text-2xl', '28 · Empty-state headline'],
                ['--text-xl', '20 · Page title'],
                ['--text-lg', '16 · Panel title'],
                ['--text-md', '14 · Reading text for chat and descriptions'],
                ['--text-sm', '13 · Default interface text'],
                ['--text-xs', '12 · Metadata and hints'],
              ] as const
            ).map(([v, l]) => (
              <p key={v} style={{ fontSize: `var(${v})` }}>
                {l}
              </p>
            ))}
            <p className={s.mono}>11 · MONO LABEL · helix/reset-api · #12 · 18/19</p>
          </div>
        </Section>
      </main>
    </div>
  );
}
