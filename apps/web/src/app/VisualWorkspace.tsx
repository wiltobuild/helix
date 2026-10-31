import { useRef, useState } from 'react';
import type { VisualPalette } from '@helix/contracts';
import { designPalettes, samePalette } from '../data/designPalettes';
import { Button } from '@helix/ui';
import {
  canChooseRound,
  parseVisualReferences,
  rasterUrl,
  visualUrl,
  VisualSubmission,
  VisualSubmissionRejected,
  type VisualAction,
  type VisualConceptView,
  type VisualRoundView,
  type VisualWorkspaceAdapter,
  type VisualWorkspaceView,
} from '../data/visualWorkspace';
import s from './VisualWorkspace.module.css';

export interface VisualWorkspaceProps {
  workspace?: VisualWorkspaceView;
  adapter?: VisualWorkspaceAdapter;
  connection: 'loading' | 'live' | 'disconnected' | 'replay' | 'unavailable' | 'error';
  error?: string;
  onRefresh?: () => void;
}

export function VisualWorkspace(props: VisualWorkspaceProps) {
  const { workspace, connection, error, onRefresh } = props;
  if (!workspace) {
    const message = {
      loading: 'Loading visual decisions…',
      live: 'Visual exploration will appear here when a UI or website task reaches design discovery.',
      disconnected: 'The visual workspace is disconnected. Reconnect to load the latest decisions.',
      replay: 'This recording contains no visual design decisions at this point.',
      unavailable: 'Visual exploration is not available from this daemon.',
      error: 'The visual workspace could not be loaded.',
    }[connection];
    return (
      <section className={s.empty} aria-label="Visual design workspace">
        <span className={s.eyebrow}>DESIGN TOGETHER</span>
        <h2>Explore before you build</h2>
        <p role={connection === 'error' ? 'alert' : 'status'}>{error ?? message}</p>
        {connection === 'unavailable' && (
          <p>
            Use a daemon with the visual design workflow and a supported image-generation provider.
            No concepts have been generated.
          </p>
        )}
        {onRefresh && <Button onClick={onRefresh}>Refresh visual workspace</Button>}
      </section>
    );
  }
  // A server revision resets the draft and retry identity: old selections never apply to a new round.
  return (
    <WorkspaceRevision
      key={`${workspace.id}:${workspace.revision}`}
      {...props}
      workspace={workspace}
    />
  );
}

function WorkspaceRevision({
  workspace,
  adapter,
  connection,
  error,
  onRefresh,
}: VisualWorkspaceProps & { workspace: VisualWorkspaceView }) {
  const active = workspace.rounds.find((round) => round.id === workspace.activeRoundId);
  const [roundId, setRoundId] = useState(workspace.activeRoundId);
  const round = workspace.rounds.find((item) => item.id === roundId) ?? active;
  const [palette, setPalette] = useState<VisualPalette | null>(active?.palette ?? null);
  const paletteChanged = !samePalette(palette, active?.palette);
  const [selected, setSelected] = useState<string[]>([]);
  const [feedback, setFeedback] = useState('');
  const [references, setReferences] = useState('');
  const [images, setImages] = useState<{ name: string; url: string }[]>([]);
  const [readingImages, setReadingImages] = useState(false);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [uncertain, setUncertain] = useState<VisualAction>();
  const submission = useRef(new VisualSubmission());
  const historical = round?.id !== workspace.activeRoundId;
  const writable = connection === 'live' && !!adapter && !historical && !busy && !sent;
  const ready = !!round && canChooseRound(round);
  const generating = round?.status === 'pending' || round?.status === 'generating';
  const actionable = writable && !uncertain && !readingImages;

  async function attachImages(files: FileList | null) {
    if (!files) return;
    setActionError('');
    if (
      files.length + images.length > 4 ||
      [...files].some(
        (file) =>
          !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
          file.size > 5 * 1024 * 1024,
      )
    ) {
      setActionError('Attach up to four PNG, JPEG, or WebP images, at most 5 MB each.');
      return;
    }
    setReadingImages(true);
    try {
      const additions = await Promise.all(
        [...files].map(
          (file) =>
            new Promise<{ name: string; url: string }>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                if (typeof reader.result === 'string')
                  resolve({ name: file.name, url: reader.result });
                else reject(new Error(`Could not read ${file.name} as an image.`));
              };
              reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
              reader.readAsDataURL(file);
            }),
        ),
      );
      setImages((previous) => [...previous, ...additions]);
    } catch (failure) {
      setActionError(
        failure instanceof Error ? failure.message : 'Could not read reference image.',
      );
    } finally {
      setReadingImages(false);
    }
  }

  async function submit(action: VisualAction) {
    if (!adapter || !round || !writable) return;
    setActionError('');
    let links: string[];
    try {
      links = parseVisualReferences(references);
    } catch (failure) {
      setActionError(String(failure instanceof Error ? failure.message : failure));
      return;
    }
    const approving = action === 'approve' || action === 'approve_checkpoint';
    if (paletteChanged && action !== 'regenerate') {
      setActionError('Generate with the selected palette or discard the palette change first.');
      return;
    }
    if (approving && (!ready || selected.length === 0)) return;
    if (approving && selected.length > 1 && !feedback.trim()) {
      setActionError('Describe which aspects to combine before approving the direction.');
      return;
    }
    setBusy(true);
    try {
      const accepted = await submission.current.send(
        {
          workspaceId: workspace.id,
          revision: workspace.revision,
          roundId: round.id,
          action,
          ...(action === 'regenerate' ? { palette } : {}),
          conceptIds: selected,
          feedback: feedback.trim(),
          references: [...links, ...images.map((image) => image.url)],
          ...(action === 'approve_checkpoint' && workspace.checkpoint
            ? { checkpointId: workspace.checkpoint.id }
            : {}),
        },
        adapter,
      );
      if (accepted) {
        setSent(true);
        setUncertain(undefined);
      }
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'Could not save this decision.');
      setUncertain(failure instanceof VisualSubmissionRejected ? undefined : action);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={s.workspace} aria-label="Visual design workspace">
      <header className={s.heading}>
        <div>
          <span className={s.eyebrow}>DESIGN TOGETHER · REVISION {workspace.revision}</span>
          <h2>{workspace.title}</h2>
          <p>Compare directions, talk through changes, and choose what the team builds.</p>
        </div>
        <span className={s.connection} data-live={connection === 'live'}>
          {connection === 'live'
            ? 'Live workspace'
            : connection === 'replay'
              ? 'Recorded moment · read only'
              : 'Connection interrupted · read only'}
        </span>
      </header>
      {connection !== 'live' && (
        <p className={s.notice} role="status">
          {connection === 'replay'
            ? 'You are viewing history. Return to the live moment to make a decision.'
            : 'Decisions are disabled until the latest server state is available.'}
        </p>
      )}
      {error && (
        <p role="alert" className={s.notice}>
          {error}
        </p>
      )}
      {workspace.affectedTasks.length > 0 && (
        <p className={s.scope}>
          Waiting for this design: <strong>{workspace.affectedTasks.join(', ')}</strong>. Unrelated
          work can continue. Plan and merge approvals still apply.
        </p>
      )}
      {workspace.affectedTasks.length === 0 && (
        <p className={s.scope}>
          Design-dependent implementation waits for your approval. Unrelated work can continue. Plan
          and merge approvals still apply.
        </p>
      )}
      <nav className={s.rounds} aria-label="Design rounds">
        {workspace.rounds.map((item, index) => (
          <button
            key={item.id}
            type="button"
            aria-current={item.id === round?.id ? 'step' : undefined}
            onClick={() => {
              setRoundId(item.id);
              setSelected([]);
            }}
            disabled={busy || !!uncertain}
          >
            Round {index + 1} <span>{item.status}</span>
          </button>
        ))}
      </nav>
      {historical && (
        <p className={s.notice}>
          Previous round · preserved for comparison. Select the current round to continue.
        </p>
      )}
      {round ? (
        <>
          <details className={s.brief}>
            <summary>Design brief & constraints</summary>
            <p>{round.brief}</p>
          </details>
          <RoundStatus round={round} />
          {round.recommendation && (
            <aside className={s.recommendation}>
              <strong>
                Recommended direction:{' '}
                {round.concepts.find((concept) => concept.id === round.recommendation?.conceptId)
                  ?.title ?? 'Pending concept'}
              </strong>
              <p>{round.recommendation.rationale}</p>
              <span>A recommendation is not an approval. You choose the direction.</span>
            </aside>
          )}
          <div className={s.concepts}>
            {round.concepts.map((concept, index) => (
              <Concept
                key={concept.id}
                concept={concept}
                number={index + 1}
                selected={selected.includes(concept.id)}
                recommended={round.recommendation?.conceptId === concept.id}
                disabled={!actionable || !ready}
                onToggle={() =>
                  setSelected((ids) =>
                    ids.includes(concept.id)
                      ? ids.filter((id) => id !== concept.id)
                      : [...ids, concept.id],
                  )
                }
              />
            ))}
          </div>
          {round.concepts.length > 0 && (
            <p className={s.caption}>
              Concept renders communicate visual direction. Animation and interaction must be
              checked in the working preview.
            </p>
          )}
        </>
      ) : (
        <p role="alert">The current design round is missing. Refresh before making a decision.</p>
      )}

      <div className={s.collaboration}>
        <section className={s.palettePanel} aria-label="Color palette">
          <span className={s.eyebrow}>ART DIRECTION</span>
          <h3>Color palette</h3>
          <p className={s.caption}>
            Try tokens here, then generate three renders to review the result. Existing concept
            images and working previews stay unchanged.
          </p>
          <fieldset disabled={!actionable || generating} className={s.paletteChoices}>
            <legend>Palette for the next render round</legend>
            <label>
              <input
                disabled={!actionable || generating}
                type="radio"
                name="design-palette"
                checked={!(historical ? round?.palette : palette)}
                onChange={() => setPalette(null)}
              />{' '}
              Follow the brief
            </label>
            {designPalettes.map((option) => (
              <label key={option.name}>
                <input
                  disabled={!actionable || generating}
                  type="radio"
                  name="design-palette"
                  checked={samePalette(historical ? round?.palette : palette, option)}
                  onChange={() => setPalette(option)}
                />
                <span className={s.swatches} aria-hidden="true">
                  {[option.background, option.foreground, option.primary, option.accent].map(
                    (color) => (
                      <i key={color} style={{ backgroundColor: color }} />
                    ),
                  )}
                </span>
                {option.name}
              </label>
            ))}
          </fieldset>
          {(historical ? round?.palette : palette) && (
            <PaletteSample palette={(historical ? round?.palette : palette)!} />
          )}
          <p className={s.caption} role="status">
            {historical
              ? 'Recorded round palette'
              : paletteChanged
                ? 'Unsaved token preview — generate new renders before approval.'
                : 'Palette matches this round.'}
            : {(historical ? round?.palette : palette)?.name ?? 'Follow the brief'}
          </p>
          {paletteChanged && !historical && (
            <div className={s.actions}>
              <Button
                disabled={!actionable || generating}
                onClick={() => void submit('regenerate')}
              >
                Generate three with this palette
              </Button>
              <Button disabled={!actionable} onClick={() => setPalette(active?.palette ?? null)}>
                Discard palette change
              </Button>
            </div>
          )}
        </section>
        <section className={s.composer} aria-label="Refine the design">
          <h3>Make it yours</h3>
          <p>
            Choose one direction or select several and describe what to combine. You can also ask a
            question, share references, or start again.
          </p>
          <label htmlFor="visual-feedback">Feedback, questions, or combination instructions</label>
          <textarea
            id="visual-feedback"
            value={feedback}
            disabled={!actionable}
            onChange={(event) => setFeedback(event.target.value)}
            rows={4}
            placeholder="Keep the typography from direction 1, bring in the color of direction 3, and make the hero feel more playful…"
          />
          <details className={s.details}>
            <summary>References & attachments</summary>
            <label htmlFor="visual-references">
              Reference images or websites · one link per line
            </label>
            <textarea
              id="visual-references"
              value={references}
              disabled={!actionable}
              onChange={(event) => setReferences(event.target.value)}
              rows={2}
              placeholder="https://example.com/reference.png"
            />
            <label htmlFor="visual-image-files">Attach reference images · PNG, JPEG, WebP</label>
            <input
              id="visual-image-files"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={!actionable}
              onChange={(event) => {
                void attachImages(event.target.files);
                event.target.value = '';
              }}
            />
            {readingImages && <p role="status">Reading reference images…</p>}
            {images.map((image, index) => (
              <div key={`${image.name}:${index}`} className={s.attachment}>
                <img src={image.url} alt={`Reference: ${image.name}`} />
                <span>{image.name}</span>
                <Button
                  disabled={!actionable}
                  onClick={() => setImages((previous) => previous.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </div>
            ))}
          </details>
          <div className={s.actions}>
            <Button
              disabled={
                !actionable ||
                paletteChanged ||
                generating ||
                (!feedback.trim() && !references.trim() && images.length === 0)
              }
              onClick={() => void submit('feedback')}
            >
              Send feedback
            </Button>
            <Button
              variant="primary"
              disabled={!actionable || !ready || selected.length === 0 || paletteChanged}
              onClick={() => void submit('approve')}
            >
              {selected.length > 1 ? 'Approve combined direction' : 'Approve selected direction'}
            </Button>
            <Button
              disabled={!actionable || generating || !round || round.status === 'unavailable'}
              onClick={() => void submit('regenerate')}
            >
              Reject all & generate three
            </Button>
            {generating && (
              <Button disabled={!actionable} onClick={() => void submit('cancel')}>
                Cancel generation
              </Button>
            )}
            {(round?.status === 'failed' ||
              round?.status === 'cancelled' ||
              round?.status === 'unavailable') && (
              <Button disabled={!actionable || paletteChanged} onClick={() => void submit('retry')}>
                Retry generation
              </Button>
            )}
          </div>
          <p className={s.caption}>
            Rejecting all starts a fresh set of three and keeps previous rounds. Affected
            implementation waits for your approval.
          </p>
          {busy && <p role="status">Saving your request…</p>}
          {sent && <p role="status">Request saved. Waiting for the updated workspace…</p>}
          {actionError && (
            <div role="alert" className={s.notice}>
              <p>{actionError}</p>
              {uncertain && (
                <>
                  <p>
                    The response is uncertain. Retry the same request safely, or refresh to check
                    its result.
                  </p>
                  <Button disabled={busy} onClick={() => void submit(uncertain)}>
                    Retry same request
                  </Button>
                </>
              )}
            </div>
          )}
          {onRefresh && (sent || uncertain || connection !== 'live') && (
            <Button onClick={onRefresh}>Refresh latest state</Button>
          )}
        </section>
        <section className={s.history} aria-label="Design conversation and decisions">
          <h3>Conversation & decisions</h3>
          {workspace.conversation.length === 0 && workspace.decisions.length === 0 && (
            <p>Your feedback and approved direction will be kept here for the team.</p>
          )}
          {workspace.conversation.map((message) => (
            <article key={message.id}>
              <span className={s.eyebrow}>
                {message.role === 'user' ? 'YOU' : 'HELIX'} · REV {message.revision}
              </span>
              <p>{message.text}</p>
              {message.references?.map((reference, index) =>
                reference.url.startsWith('data:image/') && rasterUrl(reference.url) ? (
                  <img
                    key={index}
                    className={s.savedReference}
                    src={reference.url}
                    alt={reference.label ?? `Saved reference ${index + 1}`}
                    loading="lazy"
                  />
                ) : visualUrl(reference.url) ? (
                  <p key={index}>
                    <a href={reference.url} target="_blank" rel="noreferrer">
                      {reference.label ?? reference.url}
                    </a>
                  </p>
                ) : null,
              )}
            </article>
          ))}
          {workspace.decisions.map((decision) => (
            <article key={decision.id} className={s.decision}>
              <span className={s.eyebrow}>DECISION · REV {decision.revision}</span>
              <h4>{decision.text}</h4>
              <p>{decision.rationale}</p>
              {decision.palette && <PaletteSample palette={decision.palette} />}
            </article>
          ))}
        </section>
      </div>
      {workspace.checkpoint && (
        <PreviewCheckpoint
          checkpoint={workspace.checkpoint}
          canApprove={
            actionable &&
            !paletteChanged &&
            ready &&
            selected.length > 0 &&
            workspace.checkpoint.status === 'ready' &&
            workspace.checkpoint.revision === workspace.revision
          }
          onApprove={() => void submit('approve_checkpoint')}
        />
      )}
    </section>
  );
}

function RoundStatus({ round }: { round: VisualRoundView }) {
  const messages: Record<VisualRoundView['status'], string> = {
    pending: 'Three distinct concepts are queued. Affected implementation is waiting.',
    generating:
      'Generating three distinct raster concepts. You can cancel while other work continues.',
    ready: canChooseRound(round)
      ? 'Three directions are ready to compare.'
      : 'This round is incomplete. Three valid concept renders are required before approval.',
    failed: 'Concept generation failed. No design was approved.',
    unavailable: 'Image generation is unavailable. No concept renders have been generated.',
    cancelled: 'Generation cancelled. No design was approved.',
    approved: 'This direction was approved and shared with the affected workers.',
    superseded: 'This earlier round was replaced before a complete set of renders was available.',
  };
  return (
    <div className={s.notice} role={round.status === 'failed' ? 'alert' : 'status'}>
      <strong>{messages[round.status]}</strong>
      {round.error && <p>{round.error}</p>}
      {round.setupHint && <p>{round.setupHint}</p>}
    </div>
  );
}

function Concept({
  concept,
  number,
  selected,
  recommended,
  disabled,
  onToggle,
}: {
  concept: VisualConceptView;
  number: number;
  selected: boolean;
  recommended: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const url = rasterUrl(concept.imageUrl);
  return (
    <article className={s.concept} data-selected={selected}>
      <div className={s.image}>
        {url && !failed ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open full-size render: ${concept.title}`}
          >
            <img src={url} alt={concept.alt} loading="lazy" onError={() => setFailed(true)} />
          </a>
        ) : (
          <p role="status">Concept image unavailable. Refresh or request a new render.</p>
        )}
      </div>
      <div className={s.conceptBody}>
        <span className={s.eyebrow}>
          DIRECTION {number}
          {recommended ? ' · RECOMMENDED' : ''}
        </span>
        <h3>{concept.title}</h3>
        <p>{concept.rationale}</p>
        <details className={s.details}>
          <summary>Tradeoffs & motion</summary>
          <ul>
            {concept.tradeoffs.map((tradeoff, index) => (
              <li key={index}>{tradeoff}</li>
            ))}
          </ul>
          {concept.motionNote && <p className={s.caption}>Motion intent: {concept.motionNote}</p>}
        </details>
        <label className={s.select}>
          <input
            type="checkbox"
            checked={selected}
            disabled={disabled || failed || !url}
            onChange={onToggle}
          />
          {selected ? 'Included in your direction' : `Include ${concept.title}`}
        </label>
      </div>
    </article>
  );
}

function PreviewCheckpoint({
  checkpoint,
  canApprove,
  onApprove,
}: {
  checkpoint: NonNullable<VisualWorkspaceView['checkpoint']>;
  canApprove: boolean;
  onApprove: () => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const url = checkpoint.previewUrl ? visualUrl(checkpoint.previewUrl) : undefined;
  const embeddable =
    !!url &&
    typeof window !== 'undefined' &&
    new URL(url, window.location.href).origin !== window.location.origin;
  return (
    <section className={s.checkpoint} aria-label="Working preview checkpoint">
      <span className={s.eyebrow}>WORKING PREVIEW · REV {checkpoint.revision}</span>
      <h3>{checkpoint.title}</h3>
      <p>{checkpoint.summary}</p>
      {checkpoint.commit && (
        <p className={s.caption}>
          Code revision: <code>{checkpoint.commit}</code>
        </p>
      )}
      <p>
        <strong>Recommendation:</strong> {checkpoint.recommendation}
      </p>
      {checkpoint.reducedMotion !== undefined && (
        <p className={s.caption}>
          {checkpoint.reducedMotion
            ? 'The preview reports reduced-motion support. Verify it with your system preference.'
            : 'Reduced-motion support has not been reported for this preview.'}
        </p>
      )}
      {checkpoint.status === 'pending' && (
        <p role="status">The working preview is being prepared.</p>
      )}
      {checkpoint.status === 'failed' && (
        <p role="alert">{checkpoint.error ?? 'The working preview failed to start.'}</p>
      )}
      {checkpoint.status === 'ready' && !url && (
        <p role="status">
          No valid preview URL is available. Ask the team to publish a working preview before
          reviewing interactions.
        </p>
      )}
      {checkpoint.status === 'ready' && url && (
        <>
          <div className={s.actions}>
            <a href={url} target="_blank" rel="noreferrer">
              Open working preview
            </a>
            <Button disabled={!embeddable} onClick={() => setShowPreview((show) => !show)}>
              {showPreview ? 'Stop embedded preview' : 'Load interactive preview'}
            </Button>
          </div>
          <p className={s.caption}>
            Check responsive behavior, keyboard access, and reduced-motion behavior in the actual
            app. Embedded content runs only when you load it.
          </p>
          {!embeddable && (
            <p className={s.caption}>
              Use the separate preview link for an app hosted on Helix’s own origin.
            </p>
          )}
          {showPreview && embeddable && (
            <iframe
              className={s.preview}
              src={url}
              title={checkpoint.title}
              sandbox="allow-scripts allow-forms allow-same-origin"
              referrerPolicy="no-referrer"
            />
          )}
        </>
      )}
      <Button variant="primary" disabled={!canApprove || !url} onClick={onApprove}>
        Approve checkpoint & continue
      </Button>
      <p className={s.caption}>
        Select the direction to carry forward above, then approve this preview. Use the feedback
        conversation to request changes before continuing.
      </p>
    </section>
  );
}

function PaletteSample({ palette }: { palette: VisualPalette }) {
  return (
    <div
      className={s.paletteSample}
      style={{ backgroundColor: palette.background, color: palette.foreground }}
    >
      <span className={s.eyebrow}>TOKEN PREVIEW · {palette.name}</span>
      <strong>A considered first impression.</strong>
      <p>Surface, text, primary and accent tokens. This sample is not a generated concept.</p>
      <div className={s.swatches}>
        {[palette.background, palette.foreground, palette.primary, palette.accent].map((color) => (
          <span key={color}>
            <i style={{ backgroundColor: color }} />
            {color}
          </span>
        ))}
      </div>
      <span
        className={s.sampleAction}
        style={{ borderColor: palette.primary, color: palette.primary }}
      >
        Explore the direction
      </span>
    </div>
  );
}
