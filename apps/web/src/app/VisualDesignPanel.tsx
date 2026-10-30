import { useState } from 'react';
import type { HelixClient } from '@helix/api-client';
import type { HelixEvent, ProjectState, SessionId, VisualDesign } from '@helix/contracts';
import { visualDesignRequest, visualDesignView } from '../data/visualDesignAdapter';
import { VisualWorkspace } from './VisualWorkspace';

interface Props {
  state: ProjectState;
  events: readonly HelixEvent[];
  selected: string | null;
  isLive: boolean;
  connected: boolean;
  client?: HelixClient;
}

export function VisualDesignPanel(props: Props) {
  const { state, selected } = props;
  const designs = Object.values(state.sessions).filter((session) => session.design);
  const [chosenSession, setChosenSession] = useState<string>();
  const selectedSession = selected ? state.sessions[selected as SessionId] : undefined;
  const parentDesign = selectedSession?.session.parentSessionId;
  const session =
    designs.find((item) => item.session.id === chosenSession) ??
    designs.find((item) => item.session.id === selected || item.session.id === parentDesign) ??
    designs.at(-1);
  return (
    <>
      {designs.length > 1 && (
        <label>
          Design task{' '}
          <select
            aria-label="Design task"
            value={session?.session.id ?? ''}
            onChange={(event) => setChosenSession(event.target.value)}
          >
            {designs.map((item) => (
              <option key={item.session.id} value={item.session.id}>
                {item.session.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <ConnectedWorkspace
        key={`${state.project.id}:${session?.session.id ?? 'empty'}`}
        {...props}
        sessionId={session?.session.id}
      />
    </>
  );
}

function ConnectedWorkspace({
  state,
  events,
  sessionId,
  client,
  connected,
  isLive,
}: Props & { sessionId?: SessionId }) {
  const [fetched, setFetched] = useState<{ seq: number; design: VisualDesign | null }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const session = sessionId ? state.sessions[sessionId] : undefined;
  const design = isLive && fetched?.seq === state.lastSeq ? fetched.design : session?.design;
  const writable = isLive && connected && !!client;

  async function refresh() {
    if (!client || !sessionId || !writable) return;
    setLoading(true);
    setError('');
    try {
      const response = await client.sessionDesign(sessionId);
      setFetched({ seq: state.lastSeq, design: response.design });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not refresh visual workspace.');
    } finally {
      setLoading(false);
    }
  }

  const view = design
    ? visualDesignView(design, session?.session.title ?? 'Visual direction', [])
    : undefined;
  if (view) {
    // A later refinement must not erase previously approved decisions from the visible history.
    const decisions = new Map(view.decisions.map((decision) => [decision.revision, decision]));
    for (const event of events) {
      if (
        event.seq > state.lastSeq ||
        event.type !== 'design.updated' ||
        event.payload.design.sessionId !== sessionId
      )
        continue;
      const previous = visualDesignView(event.payload.design, '', []).decisions[0];
      if (previous) decisions.set(previous.revision, previous);
    }
    view.decisions = [...decisions.values()].sort((a, b) => a.revision - b.revision);
  }
  return (
    <VisualWorkspace
      {...(view ? { workspace: view } : {})}
      connection={
        !isLive
          ? 'replay'
          : !connected
            ? 'disconnected'
            : loading
              ? 'loading'
              : error
                ? 'error'
                : 'live'
      }
      {...(error ? { error } : {})}
      {...(writable && sessionId
        ? {
            onRefresh: () => void refresh(),
            adapter: {
              send: async (command) => {
                if (
                  !client ||
                  !isLive ||
                  !connected ||
                  command.workspaceId !== sessionId ||
                  command.revision !== design?.revision
                )
                  throw new Error('This design changed. Refresh before making a decision.');
                const request = visualDesignRequest(command);
                if (request.references) {
                  request.references = [
                    ...new Map(
                      [...(design?.references ?? []), ...request.references].map((reference) => [
                        reference.url,
                        reference,
                      ]),
                    ).values(),
                  ];
                  if (request.references.length > 20)
                    throw new Error(
                      'This design has reached its reference limit of 20 images and links.',
                    );
                }
                const result = await client.changeDesign(sessionId, request);
                setFetched({ seq: state.lastSeq, design: result.design });
              },
            },
          }
        : {})}
    />
  );
}
