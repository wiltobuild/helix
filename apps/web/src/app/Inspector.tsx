import { useMemo, useState } from 'react';
import { GitBranch, GitPullRequest, Sparkles, Terminal, X } from 'lucide-react';
import {
  deriveStatus,
  type ChatItem,
  type HelixEvent,
  type ProjectState,
  type SessionState,
} from '@helix/contracts';
import { AgentBadge, Button, IconButton, StatusPill, TabPanel, Tabs } from '@helix/ui';
import { describeEvent, eventTone, statusLine } from '../data/describe';
import s from './Inspector.module.css';

interface InspectorProps {
  session: SessionState;
  state: ProjectState;
  events: readonly HelixEvent[];
  upTo: number;
  onClose: () => void;
  onJump: (seq: number) => void;
}

export function Inspector({ session, state, events, upTo, onClose, onJump }: InspectorProps) {
  const [tab, setTab] = useState('summary');
  const status = deriveStatus(session);
  const plan = Object.values(state.plans).find((p) =>
    p.nodes.some((n) => n.id === session.session.planNodeId),
  );
  const node = plan?.nodes.find((n) => n.id === session.session.planNodeId);

  const history = useMemo(
    () => events.filter((e) => e.seq <= upTo && e.sessionId === session.session.id).reverse(),
    [events, upTo, session.session.id],
  );

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
        <StatusPill
          status={status}
          {...(statusLine(session, status, state)
            ? { label: statusLine(session, status, state)! }
            : {})}
        />
      </header>

      <Tabs
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'summary', label: 'Summary' },
          { value: 'activity', label: 'Activity', count: session.chat.length },
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
              className={s.cta}
              disabled
              title="Merging is disabled in demo mode"
            >
              Merge pull request
            </Button>
          )}
        </TabPanel>

        <TabPanel value="activity" className={s.panel}>
          {session.chat.length === 0 ? (
            <p className={s.muted}>No activity yet.</p>
          ) : (
            <ol className={s.chat}>
              {session.chat.map((item, i) => (
                <ChatRow key={i} item={item} state={state} />
              ))}
            </ol>
          )}
        </TabPanel>

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

function ChatRow({ item, state }: { item: ChatItem; state: ProjectState }) {
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
              <Button size="sm" variant="ghost" disabled>
                Reject
              </Button>
              <Button size="sm" disabled>
                Request change
              </Button>
              <Button size="sm" variant="primary" disabled>
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
