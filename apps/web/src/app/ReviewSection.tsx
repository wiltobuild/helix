import type { AgentReview, HelixEvent, ProjectState, SessionState } from '@helix/contracts';
import { AgentBadge, Button } from '@helix/ui';
import { crossReview } from '../data/crossReview';
import { ReviewChip } from './ReviewChip';
import s from './Review.module.css';

export function ReviewSection({
  session,
  state,
  events,
  upTo,
  onSelect,
}: {
  session: SessionState;
  state: ProjectState;
  events: readonly HelixEvent[];
  upTo: number;
  onSelect: (id: string, tab: string) => void;
}) {
  const display = crossReview(session, state);
  const current = session.agentReview;
  const verdicts = events.filter(
    (e): e is HelixEvent<'agent_review.submitted'> =>
      e.seq <= upTo &&
      e.type === 'agent_review.submitted' &&
      e.payload.workerSessionId === session.session.id,
  );
  const latest = verdicts.at(-1);
  const currentVerdict = current?.review && !display?.stale ? current.review : undefined;
  const earlier = verdicts
    .filter((e) => !(currentVerdict && e === latest && e.payload.headSha === current?.headSha))
    .reverse();

  return (
    <section className={s.section} aria-label="Cross-agent review">
      <h3>Review</h3>
      {display && current ? (
        <>
          <ReviewChip review={display} />
          <p className={s.head}>
            Head <code>{display.stale ? session.pr?.headSha : current.headSha}</code>
          </p>
          {display.stale && (
            <p>The PR head changed. Waiting for {display.name}'s review of the new head.</p>
          )}
          {currentVerdict && <Verdict review={currentVerdict} />}
          <Button size="sm" onClick={() => onSelect(current.reviewerSessionId, 'activity')}>
            Open {display.name}'s conversation
          </Button>
        </>
      ) : (
        <p>No cross-agent review in progress.</p>
      )}
      {earlier.map((event) => {
        const reviewer = event.sessionId ? state.sessions[event.sessionId] : undefined;
        return (
          <details key={event.seq} className={s.earlier}>
            <summary>
              {event.payload.review.verdict === 'approve' ? 'Approved' : 'Changes requested'}
              {' · '}
              {event.payload.headSha.slice(0, 7)}
              {' · earlier verdict'}
            </summary>
            <p className={s.head}>
              Head <code>{event.payload.headSha}</code>
            </p>
            {reviewer && <AgentBadge agent={reviewer.session.agent} variant="full" />}
            <Verdict review={event.payload.review} />
            {event.sessionId && (
              <Button size="sm" onClick={() => onSelect(event.sessionId!, 'activity')}>
                Open reviewer's conversation
              </Button>
            )}
          </details>
        );
      })}
    </section>
  );
}

function Verdict({ review }: { review: AgentReview }) {
  return (
    <div className={s.verdict}>
      <h3>{review.verdict === 'approve' ? 'Approved' : 'Changes requested'}</h3>
      <span className={s.source}>Agent's own judgment</span>
      <p>{review.summary}</p>
      {(['blocker', 'major', 'minor', 'nit'] as const).map((severity) => {
        const findings = review.findings.filter((f) => f.severity === severity);
        return (
          findings.length > 0 && (
            <section key={severity} className={s.group} data-severity={severity}>
              <h4>
                {severity.charAt(0).toUpperCase() + severity.slice(1)} · {findings.length}
              </h4>
              <ul>
                {findings.map((finding, index) => (
                  <li key={index}>
                    <strong>{finding.title}</strong>
                    {finding.file && (
                      <div className={s.head}>
                        {finding.file}
                        {finding.line !== undefined ? `:${finding.line}` : ''}
                      </div>
                    )}
                    <p>{finding.detail}</p>
                  </li>
                ))}
              </ul>
            </section>
          )
        );
      })}
      {review.findings.length === 0 && <p>No findings.</p>}
    </div>
  );
}
