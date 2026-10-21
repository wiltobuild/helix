import { useEffect, useMemo, useState } from 'react';
import { GitBranch, GitMerge, GitPullRequest, Send, Sparkles, Terminal, X } from 'lucide-react';
import type { HelixClient } from '@helix/api-client';
import {
  deriveStatus,
  type ApprovalDecision,
  type ApprovalId,
  type ChatItem,
  type DiffResponse,
  type DiffScope,
  type HelixEvent,
  type ProjectState,
  type SessionState,
} from '@helix/contracts';
import { AgentBadge, Button, IconButton, Segmented, StatusPill, TabPanel, Tabs } from '@helix/ui';
import { describeEvent, eventTone, statusLine } from '../data/describe';
import s from './Inspector.module.css';

interface InspectorProps {
  session: SessionState;
  state: ProjectState;
  events: readonly HelixEvent[];
  upTo: number;
  onClose: () => void;
  onJump: (seq: number) => void;
  /** Present in live mode. Actions are enabled only while viewing the live moment. */
  client?: HelixClient;
  isLive?: boolean;
}

export function Inspector({
  session,
  state,
  events,
  upTo,
  onClose,
  onJump,
  client,
  isLive,
}: InspectorProps) {
  const [tab, setTab] = useState('summary');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const status = deriveStatus(session);
  const id = session.session.id;
  const plan = Object.values(state.plans).find((p) =>
    p.nodes.some((n) => n.id === session.session.planNodeId),
  );
  const node = plan?.nodes.find((n) => n.id === session.session.planNodeId);
  const canAct = Boolean(client && isLive);
  const label = statusLine(session, status, state);

  const history = useMemo(
    () => events.filter((e) => e.seq <= upTo && e.sessionId === id).reverse(),
    [events, upTo, id],
  );

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That action failed.');
    } finally {
      setBusy(undefined);
    }
  };

  const decide = (approvalId: ApprovalId, decision: ApprovalDecision) =>
    act(`approval:${approvalId}`, () => client!.decideApproval(approvalId, { decision }));

  return (
    <aside className={s.inspector} aria-label={`Session: ${session.session.title}`}>
      <header className={s.header}>
        <div className={s.headTop}>
          <AgentBadge
            agent={session.session.agent}
            variant="full"
            {...(session.session.model ? { model: session.session.model } : {})}
          />
          <IconButton
            label="Close"
            shortcut="Esc"
            icon={<X size={16} />}
            size="sm"
            onClick={onClose}
          />
        </div>
        <h2 className={s.title}>{session.session.title}</h2>
        <StatusPill status={status} {...(label ? { label } : {})} />
        {client && !isLive && (
          <p className={s.rewound}>Viewing the past. Go back to live to take actions.</p>
        )}
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
      </header>

      <Tabs
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'summary', label: 'Summary' },
          { value: 'activity', label: 'Activity', count: session.chat.length },
          ...(client ? [{ value: 'files', label: 'Files' }] : []),
          { value: 'why', label: 'Why' },
        ]}
        className={s.tabs}
      >
        <TabPanel value="summary" className={s.panel}>
          {node && (
            <section className={s.block}>
              <h3 className={s.blockTitle}>
                <Sparkles size={13} aria-hidden /> Intent
              </h3>
              <p className={s.rationale}>{node.rationale}</p>
              {node.acceptance.length > 0 && (
                <ul className={s.acceptance}>
                  {node.acceptance.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {!node && (
            <section className={s.block}>
              <h3 className={s.blockTitle}>
                <Sparkles size={13} aria-hidden /> Task
              </h3>
              <p className={s.rationale}>{session.session.prompt}</p>
            </section>
          )}

          <dl className={s.facts}>
            <dt>Branch</dt>
            <dd className={s.mono}>
              {session.session.branch ? (
                <>
                  <GitBranch size={12} aria-hidden /> {session.session.branch}
                </>
              ) : (
                'Not created yet'
              )}
            </dd>
            {session.worktree?.diff && (
              <>
                <dt>Changes</dt>
                <dd className={s.mono}>
                  {session.worktree.diff.filesChanged} files{' '}
                  <span className={s.add}>+{session.worktree.diff.insertions}</span>{' '}
                  <span className={s.del}>−{session.worktree.diff.deletions}</span>
                </dd>
              </>
            )}
            <dt>Pull request</dt>
            <dd>
              {session.pr ? (
                <a href={session.pr.url} target="_blank" rel="noreferrer" className={s.prLink}>
                  <GitPullRequest size={13} aria-hidden /> #{session.pr.number}
                  {session.pr.draft ? ' · draft' : ''}
                </a>
              ) : (
                <span className={s.muted}>Opens when the agent finishes</span>
              )}
            </dd>
            {session.pr && (
              <>
                <dt>Checks</dt>
                <dd className={s.mono}>
                  {session.pr.checks.passed}/{session.pr.checks.total} passed
                  {session.pr.checks.failed > 0 && (
                    <span className={s.del}> · {session.pr.checks.failingNames.join(', ')}</span>
                  )}
                </dd>
                <dt>Review</dt>
                <dd>{reviewLabel(session.pr.review.decision)}</dd>
              </>
            )}
          </dl>

          {status === 'ready_to_merge' && (
            <Button
              variant="primary"
              icon={<GitMerge size={14} />}
              className={s.cta}
              disabled={!canAct}
              loading={busy === 'merge'}
              title={canAct ? undefined : 'Available in live mode'}
              onClick={() => void act('merge', () => client!.mergeSession(id))}
            >
              Merge pull request
            </Button>
          )}
        </TabPanel>

        <TabPanel value="activity" className={s.activity}>
          <div className={s.panel}>
            {session.chat.length === 0 ? (
              <p className={s.muted}>No activity yet.</p>
            ) : (
              <ol className={s.chat}>
                {session.chat.map((item, i) => (
                  <ChatRow
                    key={i}
                    item={item}
                    state={state}
                    canAct={canAct}
                    busy={busy}
                    onDecide={(a, d) => void decide(a, d)}
                  />
                ))}
              </ol>
            )}
          </div>
          {client && (
            <Composer
              disabled={!canAct || status === 'merged' || status === 'archived'}
              busy={busy === 'send'}
              onSend={(text, mode) => act('send', () => client.sendMessage(id, { text, mode }))}
            />
          )}
        </TabPanel>

        {client && (
          <TabPanel value="files" className={s.panel}>
            <FilesPanel
              client={client}
              sessionId={id}
              hasPr={Boolean(session.pr)}
              refreshKey={upTo}
            />
          </TabPanel>
        )}

        <TabPanel value="why" className={s.panel}>
          <p className={s.muted}>
            Everything that happened to this task, newest first. Select an event to rewind to it.
          </p>
          <ol className={s.history}>
            {history.map((e) => (
              <li key={e.seq}>
                <button type="button" onClick={() => onJump(e.seq)} data-tone={eventTone(e)}>
                  <span className={s.histSeq}>#{e.seq}</span>
                  <span className={s.histText}>{describeEvent(e, state)}</span>
                  {e.causedBy && <span className={s.cause}>caused by #{e.causedBy}</span>}
                </button>
              </li>
            ))}
          </ol>
        </TabPanel>
      </Tabs>
    </aside>
  );
}

function reviewLabel(d: string) {
  return d === 'approved'
    ? 'Approved'
    : d === 'changes_requested'
      ? 'Changes requested'
      : d === 'review_required'
        ? 'Review required'
        : 'No review needed';
}

function Composer({
  disabled,
  busy,
  onSend,
}: {
  disabled: boolean;
  busy: boolean;
  onSend: (text: string, mode: 'queue' | 'interrupt') => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'queue' | 'interrupt'>('queue');
  const send = async () => {
    if (!text.trim() || disabled) return;
    await onSend(text.trim(), mode);
    setText('');
  };
  return (
    <div className={s.composer}>
      <textarea
        id="inspector-composer"
        className={s.composerInput}
        placeholder={disabled ? 'Messaging is available while viewing live' : 'Message the agent…'}
        value={text}
        disabled={disabled}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        aria-label="Message the agent"
      />
      <div className={s.composerBar}>
        <Segmented
          label="Delivery"
          size="sm"
          value={mode}
          onValueChange={(v) => setMode(v as 'queue' | 'interrupt')}
          items={[
            { value: 'queue', label: 'After this turn' },
            { value: 'interrupt', label: 'Interrupt now' },
          ]}
        />
        <Button
          size="sm"
          variant="primary"
          icon={<Send size={13} />}
          disabled={disabled || !text.trim()}
          loading={busy}
          onClick={() => void send()}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

function FilesPanel({
  client,
  sessionId,
  hasPr,
  refreshKey,
}: {
  client: HelixClient;
  sessionId: SessionState['session']['id'];
  hasPr: boolean;
  refreshKey: number;
}) {
  const [scope, setScope] = useState<DiffScope>('workspace');
  const [diff, setDiff] = useState<DiffResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    client
      .sessionDiff(sessionId, { scope })
      .then((d) => {
        if (cancelled) return;
        setError(undefined);
        setDiff(d);
      })
      .catch(
        (e: unknown) =>
          !cancelled && setError(e instanceof Error ? e.message : 'Could not load the diff.'),
      );
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, scope, refreshKey]);

  return (
    <div className={s.files}>
      <Segmented
        label="Diff scope"
        size="sm"
        value={scope}
        onValueChange={(v) => setScope(v as DiffScope)}
        items={[
          { value: 'workspace', label: 'Workspace' },
          ...(hasPr ? [{ value: 'pr', label: 'Pull request' }] : []),
          { value: 'last_turn', label: 'Last turn' },
        ]}
      />
      {error && <p className={s.error}>{error}</p>}
      {diff && diff.files.length === 0 && <p className={s.muted}>No changes in this scope.</p>}
      {diff && diff.files.length > 0 && (
        <>
          <ul className={s.fileList}>
            {diff.files.map((f) => (
              <li key={f.path}>
                <span className={s.fileStatus} data-status={f.status}>
                  {f.status[0]!.toUpperCase()}
                </span>
                <span className={s.filePath}>{f.path}</span>
                <span className={s.add}>+{f.insertions}</span>
                <span className={s.del}>−{f.deletions}</span>
              </li>
            ))}
          </ul>
          <pre className={s.diff}>
            {diff.unifiedDiff.split('\n').map((line, i) => (
              <span
                key={i}
                className={
                  line.startsWith('+') && !line.startsWith('+++')
                    ? s.lineAdd
                    : line.startsWith('-') && !line.startsWith('---')
                      ? s.lineDel
                      : line.startsWith('@@')
                        ? s.lineHunk
                        : undefined
                }
              >
                {line + '\n'}
              </span>
            ))}
          </pre>
        </>
      )}
    </div>
  );
}

function ChatRow({
  item,
  state,
  canAct,
  busy,
  onDecide,
}: {
  item: ChatItem;
  state: ProjectState;
  canAct: boolean;
  busy: string | undefined;
  onDecide: (id: ApprovalId, d: ApprovalDecision) => void;
}) {
  switch (item.kind) {
    case 'message':
      return (
        <li className={s.msg} data-role={item.role}>
          <span className={s.role}>
            {item.role === 'assistant' ? 'Agent' : item.role === 'system' ? 'Helix' : 'You'}
          </span>
          <p>{item.text}</p>
        </li>
      );
    case 'tool_call':
      return (
        <li className={s.tool}>
          <Terminal size={13} aria-hidden />
          <div>
            <code>{item.inputSummary}</code>
            {item.outputSummary && <p>{item.outputSummary}</p>}
          </div>
        </li>
      );
    case 'reasoning_summary':
      return (
        <li className={s.reasoning}>
          <span className={s.role}>Reasoning</span>
          <p>{item.text}</p>
        </li>
      );
    case 'approval': {
      const a = state.approvals[item.approvalId];
      if (!a) return null;
      const pending = busy === `approval:${a.id}`;
      return (
        <li className={s.approval} data-decided={a.decision ? 'yes' : 'no'}>
          <span className={s.role}>Approval · {a.kind}</span>
          <p className={s.approvalSummary}>{a.summary}</p>
          <p className={s.approvalDetail}>{a.detail}</p>
          {a.decision ? (
            <p className={s.decided}>
              You {a.decision === 'approved' ? 'approved this once' : a.decision.replace('_', ' ')}.
            </p>
          ) : (
            <div className={s.approvalActions}>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canAct || pending}
                onClick={() => onDecide(a.id, 'rejected')}
              >
                Reject
              </Button>
              <Button
                size="sm"
                disabled={!canAct || pending}
                onClick={() => onDecide(a.id, 'changes_requested')}
              >
                Request change
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!canAct}
                loading={pending}
                onClick={() => onDecide(a.id, 'approved')}
              >
                Approve once
              </Button>
            </div>
          )}
        </li>
      );
    }
    case 'plan_update':
      return (
        <li className={s.reasoning}>
          <span className={s.role}>Plan</span>
          <p>{item.text}</p>
        </li>
      );
    case 'question':
      return (
        <li className={s.msg} data-role="assistant">
          <span className={s.role}>Question</span>
          <p>{item.prompt}</p>
        </li>
      );
  }
}
