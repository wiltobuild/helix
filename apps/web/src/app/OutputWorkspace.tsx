import { useEffect, useRef, useState, type RefObject } from 'react';
import type { HelixClient } from '@helix/api-client';
import {
  outputLeaseSchema,
  type HelixEvent,
  type OutputLease,
  type OutputRequest,
  type ProjectState,
  type SessionId,
} from '@helix/contracts';
import { Button } from '@helix/ui';
import s from './OutputWorkspace.module.css';

export function OutputWorkspace({
  state,
  events,
  isLive,
  connected,
  client,
}: {
  state: ProjectState;
  events: readonly HelixEvent[];
  isLive: boolean;
  connected: boolean;
  client?: HelixClient;
}) {
  const workers = Object.values(state.sessions).filter(
    (x) => x.session.role === 'worker' && x.worktree,
  );
  const [selected, setSelected] = useState('');
  const worker =
    workers.find((x) => x.session.id === selected) ??
    workers.find((x) => x.output?.status === 'running') ??
    workers[0];
  return (
    <section className={s.workspace} aria-label="Live Output workspace">
      <header className={s.header}>
        <div>
          <h2>Output</h2>
          <p>Test the application as it takes shape. Approved concepts stay in Design.</p>
        </div>
        {workers.length > 0 && (
          <label>
            Worker{' '}
            <select
              aria-label="Output worker"
              value={worker?.session.id ?? ''}
              onChange={(e) => setSelected(e.target.value)}
            >
              {workers.map((w) => (
                <option key={w.session.id} value={w.session.id}>
                  {w.session.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      {worker ? (
        <WorkerOutput
          key={`${state.project.id}:${worker.session.id}`}
          state={state}
          events={events}
          id={worker.session.id}
          isLive={isLive}
          connected={connected}
          {...(client ? { client } : {})}
        />
      ) : (
        <p>
          No worker checkout yet. Output becomes available after plan approval and an application
          export.
        </p>
      )}
    </section>
  );
}

type WorkerProps = {
  state: ProjectState;
  events: readonly HelixEvent[];
  id: SessionId;
  isLive: boolean;
  connected: boolean;
  client?: HelixClient;
};
function WorkerOutput(props: WorkerProps) {
  const [text, setText] = useState('');
  const submittingRef = useRef(false);
  const pendingRef = useRef<OutputRequest | null>(null);
  const output = props.state.sessions[props.id]?.output;
  // Reset live capability/readiness on reconnect or revision change, preserving the user's draft.
  return (
    <ConnectedOutput
      key={[props.id, props.isLive, props.connected, output?.revision, output?.status].join(':')}
      {...props}
      text={text}
      setText={setText}
      submittingRef={submittingRef}
      pendingRef={pendingRef}
    />
  );
}
function ConnectedOutput({
  state,
  events,
  id,
  isLive,
  connected,
  client,
  text,
  setText,
  submittingRef,
  pendingRef,
}: WorkerProps & {
  text: string;
  setText: (value: string) => void;
  submittingRef: RefObject<boolean>;
  pendingRef: RefObject<OutputRequest | null>;
}) {
  const worker = state.sessions[id]!;
  const output = worker.output;
  const [lease, setLease] = useState<OutputLease | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [viewerBlocked, setViewerBlocked] = useState(false);
  const viewer = useRef<HTMLIFrameElement>(null);
  const lastLeaseUrl = useRef<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const writable = isLive && connected && !!client;
  useEffect(() => {
    let disposed = false;
    if (!writable || !client || output?.status !== 'running') return;
    const poll = async () => {
      try {
        const result = await client.outputLease(id);
        if (!disposed) {
          const next = result.lease ? outputLeaseSchema.parse(result.lease) : null;
          if (next?.url !== lastLeaseUrl.current) {
            setLoaded(false);
            setViewerBlocked(false);
          }
          lastLeaseUrl.current = next?.url ?? null;
          setLease(next);
        }
      } catch {
        if (!disposed) {
          lastLeaseUrl.current = null;
          setLoaded(false);
          setViewerBlocked(false);
          setLease(null);
          setError('Preview connection unavailable.');
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [writable, client, id, output?.revision, output?.status, refresh]);
  const current =
    writable &&
    output?.status === 'running' &&
    lease?.revision === output.revision &&
    lease.artifactHash === output.artifactHash
      ? lease
      : null;
  // A stalled outer navigation cannot report the wrapper's own timeout. Retry that
  // viewer once, then expose failure; only a matching wrapper message can mark it ready.
  useEffect(() => {
    if (!current?.url || loaded || viewerBlocked) return;
    const timer = setTimeout(() => {
      if (refresh === 0) setRefresh(1);
      else {
        setViewerBlocked(true);
        setError('Application could not be loaded. Check the preview connection and retry.');
      }
    }, 10000);
    return () => clearTimeout(timer);
  }, [current?.url, loaded, viewerBlocked, refresh]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (typeof data !== 'object' || data === null || !('load' in data) || !('type' in data))
        return;
      if (
        !current ||
        event.source !== viewer.current?.contentWindow ||
        data.load !== '#' + output!.revision + '-' + refresh
      )
        return;
      if (data.type === 'helix-output-ready') {
        setViewerBlocked(false);
        setLoaded(true);
        setError('');
      }
      if (data.type === 'helix-output-unavailable') {
        setViewerBlocked(true);
        setLoaded(false);
        setError('Application could not be loaded. Check the preview connection and retry.');
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [current, output, refresh]);
  const feedbackAllowed = loaded && !!current && !current.stale && !current.pendingChanges;
  async function send(action: OutputRequest['action'], feedbackId?: string) {
    if (!client || !writable || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError('');
    const base = { requestId: crypto.randomUUID(), revision: output?.revision ?? 0 };
    const request: OutputRequest =
      action === 'feedback'
        ? { ...base, action, headSha: output!.headSha, text }
        : action === 'resolve'
          ? {
              ...base,
              action,
              feedbackId: feedbackId!,
              status: 'resolved',
              disposition: 'Marked addressed by the user after inspecting Output.',
            }
          : { ...base, action };
    // A retry after an uncertain transport result reuses the exact receipt and payload.
    const retry = pendingRef.current;
    const actual =
      retry &&
      retry.action === action &&
      retry.revision === request.revision &&
      (action !== 'resolve' || ('feedbackId' in retry && retry.feedbackId === feedbackId)) &&
      (action !== 'feedback' || ('text' in retry && retry.text === text))
        ? retry
        : request;
    pendingRef.current = actual;
    try {
      await client.changeOutput(id, actual);
      pendingRef.current = null;
      if (action === 'feedback') setText('');
      if (action === 'start' || action === 'stop') setRefresh((n) => n + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Output request failed. Retry safely.');
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }
  const history = events.filter(
    (e) => e.seq <= state.lastSeq && e.type === 'output.updated' && e.sessionId === id,
  );
  return (
    <>
      <div className={s.controls}>
        <strong role="status">
          {!isLive
            ? 'Replay — recorded evidence only'
            : !connected
              ? 'Disconnected'
              : output?.status === 'running'
                ? viewerBlocked
                  ? 'Server running · viewer unavailable'
                  : loaded
                    ? 'Interactive preview'
                    : 'Server running · checking browser'
                : (output?.status ?? 'Not started')}
        </strong>
        <Button
          size="sm"
          disabled={
            !writable || busy || output?.status === 'starting' || output?.status === 'running'
          }
          onClick={() => void send('start')}
        >
          Start preview
        </Button>
        <Button
          size="sm"
          disabled={!writable || busy || !output || output.status === 'stopped'}
          onClick={() => void send('stop')}
        >
          Stop preview
        </Button>
        <Button
          size="sm"
          disabled={!current}
          onClick={() => {
            setLoaded(false);
            setViewerBlocked(false);
            setError('');
            setRefresh((n) => n + 1);
          }}
        >
          Reset viewer
        </Button>
        <label>
          <input type="checkbox" checked={narrow} onChange={(e) => setNarrow(e.target.checked)} />{' '}
          Narrow viewport
        </label>
      </div>
      <p>
        {output?.message ??
          'The worker publishes the actual compiled application bundle. This preview supports client-side interactions; backend APIs and persistent storage are not supported.'}
      </p>
      {output && (
        <dl className={s.provenance}>
          <div>
            <dt>Build / worker</dt>
            <dd>
              {output.buildSessionId} / {id}
            </dd>
          </div>
          <div>
            <dt>Branch / commit</dt>
            <dd>
              {output.branch} / <code>{output.headSha}</code>
            </dd>
          </div>
          <div>
            <dt>Preview revision / artifact</dt>
            <dd>
              {output.revision} / <code>{output.artifactHash ?? 'Preparing'}</code>
            </dd>
          </div>
        </dl>
      )}
      {(current?.stale || current?.pendingChanges) && (
        <p role="status" className={s.notice}>
          This preview has{' '}
          {current.stale
            ? 'a newer commit or changed approved context'
            : 'uncommitted worker changes'}
          . Feedback is paused until the next committed preview.
        </p>
      )}
      {error && (
        <p role="alert" className={s.notice}>
          {error}
        </p>
      )}
      <div className={s.viewer} data-narrow={narrow}>
        {current ? (
          <>
            <iframe
              key={`${current.url}:${refresh}`}
              title={`Application Output revision ${output!.revision}`}
              ref={viewer}
              src={`${current.url}#${output!.revision}-${refresh}`}
              sandbox="allow-scripts allow-forms"
              referrerPolicy="no-referrer"
            />
            <span className={s.caption}>
              {loaded
                ? 'Viewer loaded — this does not certify application correctness.'
                : viewerBlocked
                  ? 'Application could not be loaded. Reset the viewer to retry.'
                  : 'Checking browser and loading application…'}
            </span>
          </>
        ) : (
          <div className={s.empty}>
            {!isLive
              ? 'Historical preview servers are never opened during replay.'
              : output?.status === 'starting'
                ? 'Preparing a task-owned local preview…'
                : 'No verified live preview lease. Start the preview when an export is ready.'}
          </div>
        )}
      </div>
      <div className={s.feedback}>
        <label htmlFor={`feedback-${id}`}>
          Request a visual or structural change to this revision
        </label>
        <textarea
          id={`feedback-${id}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={4000}
          rows={3}
          disabled={!feedbackAllowed || busy}
          placeholder="Describe one bounded change and the result you expect."
        />
        <Button
          disabled={!feedbackAllowed || busy || !text.trim()}
          onClick={() => void send('feedback')}
        >
          Send to owning worker
        </Button>
        <p>
          Changes outside the approved brief or design require a new approval. This never approves a
          plan, design or merge.
        </p>
        {output?.feedback.map((f) => (
          <article key={f.id}>
            <strong>
              Revision {f.revision} · {f.status}
            </strong>
            <p>{f.text}</p>
            <p>{f.disposition}</p>
            {f.status !== 'resolved' && f.status !== 'dismissed' && (
              <Button
                size="sm"
                disabled={!writable || busy}
                onClick={() => void send('resolve', f.id)}
              >
                Mark addressed
              </Button>
            )}
          </article>
        ))}
      </div>
      <details>
        <summary>Preview history ({history.length} events)</summary>
        <ol>
          {history.map(
            (e) =>
              e.type === 'output.updated' && (
                <li key={e.seq}>
                  #{e.seq} · revision {e.payload.output.revision} · {e.payload.output.status} ·{' '}
                  {e.payload.output.headSha.slice(0, 10)} — {e.payload.output.message}
                </li>
              ),
          )}
        </ol>
      </details>
    </>
  );
}
