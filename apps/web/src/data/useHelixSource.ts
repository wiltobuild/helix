import { useCallback, useEffect, useMemo, useState } from 'react';
import { createHelixClient, type EventStreamStatus, type HelixClient } from '@helix/api-client';
import type { HelixEvent, Project } from '@helix/contracts';
import { useDemoStream } from './useDemoStream';

export type SourceMode = 'connecting' | 'demo' | 'empty' | 'live';

export interface HelixSource {
  mode: SourceMode;
  events: readonly HelixEvent[];
  /** Live mode only. */
  client?: HelixClient;
  project?: Project;
  stream: EventStreamStatus | 'demo';
  addProject: (repoPath: string) => Promise<void>;
  error?: string;
}

/** Same origin: Vite proxies /api and /mux to helixd in dev; helixd serves the built app in prod. */
const client = createHelixClient({ baseUrl: window.location.origin });
const forceDemo = new URLSearchParams(window.location.search).has('demo');

/**
 * Picks the data source. If a Helix daemon answers, show the real project (live events over SSE,
 * replayed from seq 0 so backfill and live share one path). Otherwise fall back to demo mode,
 * which replays a recorded run, so the app always shows something real.
 */
export function useHelixSource(): HelixSource {
  const [mode, setMode] = useState<SourceMode>(forceDemo ? 'demo' : 'connecting');
  const [project, setProject] = useState<Project>();
  const [liveEvents, setLiveEvents] = useState<HelixEvent[]>([]);
  const [stream, setStream] = useState<EventStreamStatus>('connecting');
  const [error, setError] = useState<string>();
  const demoEvents = useDemoStream();

  const loadProjects = useCallback(async () => {
    const projects = await client.projects();
    if (projects.length === 0) {
      setMode('empty');
      return;
    }
    setProject(projects[0]);
    setMode('live');
  }, []);

  useEffect(() => {
    if (forceDemo) return;
    let cancelled = false;
    client
      .health()
      .then(async () => {
        if (!cancelled) await loadProjects();
      })
      .catch(() => !cancelled && setMode('demo'));
    return () => {
      cancelled = true;
    };
  }, [loadProjects]);

  useEffect(() => {
    if (mode !== 'live' || !project) return;
    setLiveEvents([]);
    const sub = client.events({
      since: 0,
      projectId: project.id,
      onEvent: (e) =>
        setLiveEvents((prev) =>
          prev.length && prev[prev.length - 1]!.seq >= e.seq ? prev : [...prev, e],
        ),
      onStatus: setStream,
    });
    return () => sub.close();
  }, [mode, project]);

  const addProject = useCallback(
    async (repoPath: string) => {
      setError(undefined);
      try {
        await client.createProject({ repoPath });
        await loadProjects();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [loadProjects],
  );

  return useMemo<HelixSource>(() => {
    if (mode === 'demo' || mode === 'connecting')
      return { mode, events: demoEvents, stream: 'demo', addProject, ...(error ? { error } : {}) };
    return {
      mode,
      events: liveEvents,
      client,
      ...(project ? { project } : {}),
      stream,
      addProject,
      ...(error ? { error } : {}),
    };
  }, [mode, demoEvents, liveEvents, project, stream, addProject, error]);
}
