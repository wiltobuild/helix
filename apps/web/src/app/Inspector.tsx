import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  CircleAlert,
  Clock,
  FileText,
  GitBranch,
  GitMerge,
  GitPullRequest,
  ListChecks,
  MessageSquare,
  Send,
  Sparkles,
  Terminal,
  Users,
  Workflow,
  X,
} from 'lucide-react';
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
import {
  AgentBadge,
  AgentEmblem,
  Button,
  IconButton,
  Kbd,
  Segmented,
  StatusPill,
  TabPanel,
  Tabs,
} from '@helix/ui';
import {
  describeEvent,
  eventTone,
  provenance,
  provenanceLabel,
  statusLine,
  turnLimitNote,
  type Provenance,
} from '../data/describe';
import s from './Inspector.module.css';
import { handlePlanShortcut } from './keyboardShortcuts';
import { crossReview, reviewerTarget, sessionHistory } from '../data/crossReview';
import { ReviewSection } from './ReviewSection';
import { ReviewChip } from './ReviewChip';
import {
  agentLabel,
  formatDuration,
  planBlockers,
  planSummary,
  type PlanTree,
} from '../data/observatory';

interface InspectorProps {
  session: SessionState;
  state: ProjectState;
  events: readonly HelixEvent[];
  upTo: number;
  onClose: () => void;
  onJump: (seq: number) => void;
  tab: string;
  onTabChange: (tab: string) => void;
  onSelect: (id: string, tab: string) => void;
  /** Present in live mode. Actions are enabled only while viewing the live moment. */
  client?: HelixClient;
  isLive?: boolean;
  /** The plan tree, for the orchestrator's plan summary. */
  tree?: PlanTree;
}

export function Inspector({
  session,
  state,
  events,
  upTo,
  onClose,
  onJump,
  tab,
  onTabChange,
  onSelect,
  client,
  isLive,
  tree,
}: InspectorProps) {
  const [busy, setBusy] = useState<string>();
  const [changes, setChanges] = useState<string>();
  const [error, setError] = useState<string>();
  const id = session.session.id;
  const review = crossReview(session, state);
  const target = reviewerTarget(session, state, events, upTo);
  const orchPlan = Object.values(state.plans).findLast((p) => p.orchestratorSessionId === id);
  const planNeedsReview = orchPlan?.status === 'awaiting_approval';
  const rawStatus = deriveStatus(session);
  const status = planNeedsReview ? 'needs_you' : rawStatus;
  const plan = Object.values(state.plans).findLast((p) =>
    p.nodes.some((n) => n.id === session.session.planNodeId),
  );
  const node = plan?.nodes.find((n) => n.id === session.session.planNodeId);
  const canAct = Boolean(client && isLive);
  const turnLimit = turnLimitNote(session);
  const label = planNeedsReview
    ? `Approve plan · ${orchPlan.nodes.length} task${orchPlan.nodes.length === 1 ? '' : 's'}`
    : statusLine(session, status, state);
  const pendingApprovals = session.pendingApprovalIds
    .map((aid) => state.approvals[aid])
    .filter((a): a is NonNullable<typeof a> => Boolean(a && !a.decision));

  const history = useMemo(() => sessionHistory(events, id, upTo), [events, upTo, id]);

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

  const decidePlan = (decision: 'approve' | 'reject', reason?: string) =>
    act(`plan:${decision}`, async () => {
      await client!.decidePlan(orchPlan!.id, { decision, ...(reason ? { reason } : {}) });
      // Rejecting only records the decision; the orchestrator has to hear what to change, or it
      // stays idle. Send the request so it revises and submits a new plan for approval.
      if (decision === 'reject')
        await client!.sendMessage(id, {
          text: reason
            ? `I sent your plan back. Please revise it and submit a new plan for my approval. Requested changes: ${reason}`
            : 'I sent your plan back. Please revise it and submit a new plan for my approval.',
          mode: 'queue',
        });
      setChanges(undefined);
    });

  const isOrchestrator = session.session.role === 'orchestrator';
  const planTreeHere = isOrchestrator && tree && tree.plan.id === orchPlan?.id ? tree : undefined;
  const orchTasks = planTreeHere?.tasks ?? [];
  const filesCount = isOrchestrator
    ? new Set(orchTasks.flatMap((t) => t.node.files)).size || undefined
    : (session.worktree?.diff?.filesChanged ?? (node?.files.length || undefined));
  const prCount = isOrchestrator
    ? orchTasks.filter((t) => t.pr).length || undefined
    : session.pr
      ? 1
      : undefined;

  return (
    <aside
      className={s.inspector}
      aria-label={`Session: ${session.session.title}`}
      onKeyDown={(event) =>
        handlePlanShortcut(event, {
          enabled: planNeedsReview && canAct && !busy,
          canApprove: changes === undefined,
          approve: () => void decidePlan('approve'),
          requestChanges: () => setChanges((c) => c ?? ''),
        })
      }
    >
      <header className={s.header}>
        <div className={s.headTop}>
          {isOrchestrator ? (
            <span className={s.orchTile} data-active={status === 'working' || undefined}>
              <Workflow size={22} aria-hidden />
            </span>
          ) : (
            <AgentEmblem agent={session.session.agent} active={status === 'working'} size={40} />
          )}
          <div className={s.headText}>
            <span className={s.headName}>
              {isOrchestrator ? 'Orchestrator' : agentLabel(session.session.agent)}
              {session.session.model && <span className={s.model}> · {session.session.model}</span>}
            </span>
            <span className={s.headSub}>
              {isOrchestrator
                ? 'Plan and coordinate all tasks'
                : node
                  ? `Task in the plan`
                  : 'Standalone task'}
            </span>
          </div>
          <StatusPill status={status} {...(planNeedsReview ? { label: 'Needs review' } : {})} />
          <IconButton
            label="Close"
            shortcut="Esc"
            icon={<X size={16} />}
            size="sm"
            onClick={onClose}
          />
        </div>
        <h2 className={s.title}>
          {target
            ? `Reviewing ${target.worker.session.title}${target.prNumber ? ` · PR #${target.prNumber}` : ''}`
            : session.session.title}
        </h2>
        {target && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onSelect(target.worker.session.id, 'review')}
          >
            Back to {target.worker.session.title}
          </Button>
        )}
        {label && !planNeedsReview && <p className={s.statusLine}>{label}</p>}
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
        onValueChange={onTabChange}
        items={[
          { value: 'summary', label: 'Summary' },
          // The diff endpoint only knows the present; never imply it shows the moment being viewed.
          {
            value: 'files',
            label: client && !isLive ? 'Current changes' : 'Files',
            count: filesCount,
          },
          { value: 'pr', label: 'PR & CI', count: prCount },
          { value: 'activity', label: 'Activity', count: session.chat.length },
          ...(session.session.role === 'worker' ? [{ value: 'review', label: 'Review' }] : []),
          { value: 'why', label: 'Why' },
        ]}
        className={s.tabs}
      >
        <TabPanel value="summary" className={s.panel}>
          {session.turnLimited && (
            <section className={s.pastNotice} role="status">
              <strong>Turn limit reached.</strong> Helix paused this task so it can’t run away with
              time or usage. Send a message in <em>Activity</em> to let it continue.
              <SourceTag source="helix" /> {turnLimit}
            </section>
          )}
          {orchPlan && planTreeHere && (
            <PlanPanel
              tree={planTreeHere}
              state={state}
              canAct={canAct}
              live={Boolean(client)}
              busy={busy}
              changes={changes}
              onChanges={setChanges}
              onDecide={(d, reason) => void decidePlan(d, reason)}
              onSelect={(sid) => onSelect(sid, 'summary')}
            />
          )}
          {pendingApprovals.map((a) => {
            const pending = busy === `approval:${a.id}`;
            return (
              <section key={a.id} className={s.approval} data-decided="no">
                <span className={s.role}>Approval · {a.kind}</span>
                <p className={s.approvalSummary}>{a.summary}</p>
                <p className={s.approvalDetail}>{a.detail}</p>
                <div className={s.approvalActions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canAct || pending}
                    onClick={() => void decide(a.id, 'rejected')}
                  >
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    disabled={!canAct || pending}
                    onClick={() => void decide(a.id, 'changes_requested')}
                  >
                    Request change
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!canAct}
                    loading={pending}
                    onClick={() => void decide(a.id, 'approved')}
                  >
                    Approve once
                  </Button>
                </div>
              </section>
            );
          })}
          {node && (
            <section className={s.block}>
              <h3 className={s.blockTitle}>
                <Sparkles size={13} aria-hidden /> Intent
              </h3>
              <SourceTag source="plan" />
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

          {!isOrchestrator && (
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
                    {plural(session.worktree.diff.filesChanged, 'file')}{' '}
                    <span className={s.add}>+{session.worktree.diff.insertions}</span>{' '}
                    <span className={s.del}>−{session.worktree.diff.deletions}</span>
                  </dd>
                </>
              )}
              <dt>Pull request</dt>
              <dd>
                {session.pr ? (
                  <button type="button" className={s.linkBtn} onClick={() => onTabChange('pr')}>
                    <GitPullRequest size={13} aria-hidden /> #{session.pr.number} ·{' '}
                    {session.pr.checks.passed}/{session.pr.checks.total} checks
                  </button>
                ) : (
                  <span className={s.muted}>Opens when the agent finishes</span>
                )}
              </dd>
            </dl>
          )}

          {review && <ReviewChip review={review} onOpen={() => onTabChange('review')} />}
          {session.pr?.state === 'open' && review?.status === 'reviewing' && (
            <p className={s.muted} role="status">
              Waiting for {review.name}'s review{review.stale ? ' of the new head' : ''}.
            </p>
          )}

          {status === 'ready_to_merge' && (
            <Button
              variant="go"
              size="lg"
              icon={<GitMerge size={16} />}
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

        {session.session.role === 'worker' && (
          <TabPanel value="review" className={s.panel}>
            <ReviewSection
              session={session}
              state={state}
              events={events}
              upTo={upTo}
              onSelect={onSelect}
            />
          </TabPanel>
        )}

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

        <TabPanel value="files" className={s.panel}>
          {client && !isLive && (
            <p className={s.pastNotice}>
              You’re viewing the past, but this shows the task’s changes as they are now.
            </p>
          )}
          {isOrchestrator ? (
            <ClaimedFiles
              tasks={orchTasks.map((t) => ({
                title: t.node.title,
                agent: t.node.agent,
                files: t.node.files,
                insertions: t.insertions,
                deletions: t.deletions,
              }))}
            />
          ) : client ? (
            <FilesPanel
              client={client}
              sessionId={id}
              hasPr={Boolean(session.pr)}
              refreshKey={upTo}
            />
          ) : (
            <ClaimedFiles
              tasks={[
                {
                  title: session.session.title,
                  agent: session.session.agent,
                  files: node?.files ?? [],
                  insertions: session.worktree?.diff?.insertions,
                  deletions: session.worktree?.diff?.deletions,
                  changed: session.worktree?.diff?.filesChanged,
                },
              ]}
              note="This recording keeps file counts, not file contents. In a live run this tab shows the full diff."
            />
          )}
        </TabPanel>

        <TabPanel value="pr" className={s.panel}>
          {isOrchestrator ? (
            orchTasks.length === 0 ? (
              <p className={s.muted}>No tasks yet.</p>
            ) : (
              <ul className={s.prList}>
                {orchTasks.map((t) => (
                  <li key={t.node.id}>
                    <button
                      type="button"
                      disabled={!t.session}
                      onClick={() => t.session && onSelect(t.session.session.id, 'pr')}
                    >
                      <AgentBadge agent={t.node.agent} variant="glyph" />
                      <span className={s.prTitle}>
                        Task {t.number} · {t.node.title}
                      </span>
                      <span className={s.mono}>{t.pr ? `#${t.pr}` : '—'}</span>
                      <span className={s.mono}>
                        {t.checks ? `${t.checks.passed}/${t.checks.total} CI` : 'no CI'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : session.pr ? (
            <>
              <dl className={s.facts}>
                <dt>Pull request</dt>
                <dd>
                  <a href={session.pr.url} target="_blank" rel="noreferrer" className={s.prLink}>
                    <GitPullRequest size={13} aria-hidden /> #{session.pr.number}
                    {session.pr.draft ? ' · draft' : ''} · {session.pr.state}
                  </a>
                </dd>
                <dt>Checks</dt>
                <dd className={s.mono}>
                  {session.pr.checks.passed}/{session.pr.checks.total} passed
                  {session.pr.checks.pending > 0 && ` · ${session.pr.checks.pending} running`}
                  {session.pr.checks.failed > 0 && (
                    <span className={s.del}> · {session.pr.checks.failingNames.join(', ')}</span>
                  )}
                </dd>
                <dt>GitHub review</dt>
                <dd>{reviewLabel(session.pr.review.decision)}</dd>
                {review && (
                  <>
                    <dt>Agent review</dt>
                    <dd>
                      <ReviewChip review={review} onOpen={() => onTabChange('review')} />
                    </dd>
                  </>
                )}
              </dl>
              <CiHistory events={events} sessionId={id} upTo={upTo} onJump={onJump} />
              {status === 'ready_to_merge' && (
                <Button
                  variant="go"
                  size="lg"
                  icon={<GitMerge size={16} />}
                  className={s.cta}
                  disabled={!canAct}
                  loading={busy === 'merge'}
                  title={canAct ? undefined : 'Available in live mode'}
                  onClick={() => void act('merge', () => client!.mergeSession(id))}
                >
                  Merge pull request
                </Button>
              )}
            </>
          ) : (
            <p className={s.muted}>
              No pull request yet. The agent opens one when it finishes; Helix then watches CI and
              routes any failure back to it.
            </p>
          )}
        </TabPanel>

        <TabPanel value="why" className={s.panel}>
          <p className={s.muted}>
            Everything that happened to this task, newest first. Select an event to replay the
            project to that moment.
          </p>
          <div className={s.legend} aria-label="Where each entry comes from">
            <SourceTag source="plan" />
            <SourceTag source="helix" />
            <SourceTag source="agent" />
          </div>
          <ol className={s.history}>
            {history.map((e) => (
              <li key={e.seq}>
                <button type="button" onClick={() => onJump(e.seq)} data-tone={eventTone(e)}>
                  <span className={s.histSeq}>#{e.seq}</span>
                  <span className={s.histText}>{describeEvent(e, state)}</span>
                  <span className={s.histMeta}>
                    <SourceTag source={provenance(e, state)} />
                    {e.causedBy && <span className={s.cause}>caused by #{e.causedBy}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </TabPanel>
      </Tabs>
    </aside>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function SourceTag({ source }: { source: Provenance }) {
  return (
    <span className={s.source} data-source={source}>
      {provenanceLabel[source]}
    </span>
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
                {line || ' '}
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

function PlanPanel({
  tree,
  state,
  canAct,
  live,
  busy,
  changes,
  onChanges,
  onDecide,
  onSelect,
}: {
  tree: PlanTree;
  state: ProjectState;
  canAct: boolean;
  live: boolean;
  busy: string | undefined;
  changes: string | undefined;
  onChanges: (v: string | undefined) => void;
  onDecide: (d: 'approve' | 'reject', reason?: string) => void;
  onSelect: (sessionId: string) => void;
}) {
  const sum = planSummary(tree);
  const blockers = planBlockers(tree, state);
  const awaiting = tree.plan.status === 'awaiting_approval';
  return (
    <>
      <section className={s.planSummary}>
        <h3 className={s.planHeading}>Plan summary</h3>
        <p className={s.planGoal}>{tree.plan.goal}</p>
        <ul className={s.planStats}>
          <li>
            <ListChecks size={15} aria-hidden /> {plural(sum.tasks, 'task')} planned
          </li>
          <li>
            <FileText size={15} aria-hidden />{' '}
            {sum.files ? `${plural(sum.files, 'file path')} claimed` : 'No file claims recorded'}
          </li>
          <li>
            <GitPullRequest size={15} aria-hidden /> {sum.prsMerged} merged · {sum.prsOpen} open of{' '}
            {plural(sum.tasks, 'pull request')}
          </li>
          <li>
            <Users size={15} aria-hidden />{' '}
            {tree.agents.map((a) => agentLabel(a.agent)).join(' + ')}
          </li>
          <li>
            <Clock size={15} aria-hidden /> {formatDuration(sum.elapsedMs)} so far
          </li>
        </ul>
      </section>

      {blockers && (
        <section
          className={s.blocked}
          data-kind={awaiting ? 'approval' : 'attention'}
          role="status"
        >
          <h3>
            <CircleAlert size={15} aria-hidden />
            {awaiting ? 'Why this plan is blocked' : 'What needs attention'}
          </h3>
          {blockers.map((b) => (
            <p key={b}>{b}</p>
          ))}
        </section>
      )}

      {awaiting && (
        <section className={s.decide}>
          {changes === undefined ? (
            <>
              <Button
                variant="go"
                size="lg"
                className={s.bigAction}
                icon={<Check size={18} />}
                disabled={!canAct || Boolean(busy)}
                loading={busy === 'plan:approve'}
                onClick={() => onDecide('approve')}
              >
                <span className={s.bigLabel}>Approve plan</span>
                <Kbd>⌘↵</Kbd>
              </Button>
              <p className={s.bigHint}>Start all tasks and let agents proceed</p>
              <Button
                variant="secondary"
                size="lg"
                className={s.bigAction}
                icon={<MessageSquare size={17} />}
                disabled={!canAct || Boolean(busy)}
                onClick={() => onChanges('')}
              >
                <span className={s.bigLabel}>Request changes</span>
                <Kbd>⌘R</Kbd>
              </Button>
              <p className={s.bigHint}>Ask for modifications to the plan</p>
            </>
          ) : (
            <form
              className={s.changesForm}
              onSubmit={(e) => {
                e.preventDefault();
                onDecide('reject', changes.trim() || undefined);
              }}
            >
              <label htmlFor="plan-changes" className={s.changesLabel}>
                What should the orchestrator change?
              </label>
              <textarea
                id="plan-changes"
                className={s.composerInput}
                rows={3}
                autoFocus
                value={changes}
                onChange={(e) => onChanges(e.target.value)}
                placeholder="e.g. Split the receipt work into its own task and give it to Codex."
              />
              <div className={s.approvalActions}>
                <Button type="button" variant="ghost" onClick={() => onChanges(undefined)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!canAct}
                  loading={busy === 'plan:reject'}
                >
                  Send back for a new plan
                </Button>
              </div>
            </form>
          )}
          {!live && (
            <p className={s.muted}>
              This is a recorded run, so the buttons are inactive. In a live run nothing starts
              until you approve here.
            </p>
          )}
        </section>
      )}

      {!awaiting && (
        <p className={s.decided}>
          <Check size={14} aria-hidden />{' '}
          {tree.plan.status === 'approved'
            ? `You approved this plan${tree.plan.decidedAt ? ` at ${new Date(tree.plan.decidedAt).toLocaleTimeString()}` : ''}. Agents started from it.`
            : `You sent this plan back${tree.plan.rejectionReason ? `: ${tree.plan.rejectionReason}` : '.'}`}
        </p>
      )}

      <section className={s.block}>
        <h3 className={s.blockTitle}>
          <Sparkles size={13} aria-hidden /> Tasks in this plan
        </h3>
        <SourceTag source="plan" />
        <ol className={s.taskList}>
          {tree.tasks.map((t) => (
            <li key={t.node.id}>
              <button
                type="button"
                disabled={!t.session}
                onClick={() => t.session && onSelect(t.session.session.id)}
              >
                <span className={s.taskTop}>
                  <AgentBadge
                    agent={t.node.agent}
                    variant="glyph"
                    active={t.status === 'working'}
                  />
                  <strong>
                    {t.number}. {t.node.title}
                  </strong>
                  <span className={s.taskChip} data-tone={t.tone}>
                    {t.label}
                  </span>
                </span>
                <span className={s.taskWhy}>{t.node.rationale}</span>
                {t.node.files.length > 0 && (
                  <span className={s.taskFiles}>{t.node.files.join('  ·  ')}</span>
                )}
                {t.node.dependsOn.length > 0 && (
                  <span className={s.taskDeps}>
                    After{' '}
                    {t.node.dependsOn
                      .map((d) => tree.tasks.find((x) => x.node.id === d)?.number)
                      .filter(Boolean)
                      .map((n) => `task ${n}`)
                      .join(', ')}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function ClaimedFiles({
  tasks,
  note,
}: {
  tasks: {
    title: string;
    agent: string;
    files: readonly string[];
    insertions?: number | undefined;
    deletions?: number | undefined;
    changed?: number | undefined;
  }[];
  note?: string;
}) {
  return (
    <div className={s.files}>
      {note && <p className={s.muted}>{note}</p>}
      {tasks.map((t) => (
        <section key={t.title} className={s.claim}>
          <span className={s.claimHead}>
            <AgentBadge agent={t.agent} variant="glyph" />
            <strong>{t.title}</strong>
            {t.insertions !== undefined && (
              <span className={s.mono}>
                {t.changed !== undefined && `${plural(t.changed, 'file')} `}
                <span className={s.add}>+{t.insertions}</span>{' '}
                <span className={s.del}>−{t.deletions}</span>
              </span>
            )}
          </span>
          {t.files.length ? (
            <ul className={s.fileList}>
              {t.files.map((f) => (
                <li key={f}>
                  <FileText size={12} aria-hidden />
                  <span className={s.filePath}>{f}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.muted}>No file claims recorded for this task.</p>
          )}
        </section>
      ))}
    </div>
  );
}

function CiHistory({
  events,
  sessionId,
  upTo,
  onJump,
}: {
  events: readonly HelixEvent[];
  sessionId: string;
  upTo: number;
  onJump: (seq: number) => void;
}) {
  const runs = events.filter(
    (e) =>
      e.seq <= upTo &&
      e.sessionId === sessionId &&
      (e.type === 'ci.updated' || e.type === 'feedback.routed' || e.type === 'pr.merged'),
  );
  if (runs.length === 0) return null;
  return (
    <section className={s.block}>
      <h3 className={s.blockTitle}>CI history</h3>
      <ol className={s.history}>
        {runs.map((e) => (
          <li key={e.seq}>
            <button type="button" onClick={() => onJump(e.seq)} data-tone={eventTone(e)}>
              <span className={s.histSeq}>#{e.seq}</span>
              <span className={s.histText}>
                {e.type === 'ci.updated'
                  ? e.payload.checks.failed > 0
                    ? `Failed: ${e.payload.checks.failingNames.join(', ')}`
                    : e.payload.checks.pending > 0
                      ? `Running ${e.payload.checks.passed}/${e.payload.checks.total}`
                      : `Passed ${e.payload.checks.passed}/${e.payload.checks.total}`
                  : e.type === 'feedback.routed'
                    ? 'Helix sent the failure back to the agent'
                    : 'Merged'}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
