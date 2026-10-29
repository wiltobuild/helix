import { useCallback, useEffect, useMemo, useState } from 'react';
import { createHelixClient, type EventStreamStatus, type HelixClient } from '@helix/api-client';
import type { HelixEvent, Project } from '@helix/contracts';
import {
  builtInRun,
  demoSelection,
  presetRecording,
  type BuiltInPreset,
  type DemoPreset,
} from './demoScenarios';
import { useDemoStream, type ReplaySpeed } from './useDemoStream';
import { fetchRecording, openRecordingFile, replayStart, type Recording } from './recordings';

export type SourceMode = 'connecting' | 'demo' | 'empty' | 'live';
export type { DemoPreset } from './demoScenarios';

export interface HelixSource {
  mode: SourceMode;
  events: readonly HelixEvent[];
  /** Connected projects (live mode; empty in demo/connecting). */
  projects: readonly Project[];
  /** Live mode only. */
  client?: HelixClient;
  project?: Project;
  stream: EventStreamStatus | 'demo';
  selectProject: (projectId: string) => void;
  addProject: (repoPath: string) => Promise<void>;
  /** Demo mode: the recording being replayed (undefined while playing the built-in example). */
  recording?: Pick<Recording, 'name' | 'header'>;
  /** Active demo scenario, or a custom uploaded .helixlog. */
  demoPreset?: DemoPreset;
  /** Switch between bundled recordings and the built-in cross-review run. */
  selectDemoPreset?: (preset: BuiltInPreset) => void;
  /** Why a requested recording could not be played (the built-in example plays instead). */
  recordingError?: string;
  /** Replays a local .helixlog file in the browser; works in any mode, no daemon needed. */
  openRecording: (file: File) => Promise<void>;
  /** Demo mode: how fast the replay plays. */
  speed: ReplaySpeed;
  setSpeed: (speed: ReplaySpeed) => void;
  /** True in the static demo build: no daemon, no live-only controls. */
  staticBuild: boolean;
  error?: string;
}

/** Same origin: Vite proxies /api and /mux to helixd in dev; helixd serves the built app in prod. */
const client = createHelixClient({ baseUrl: window.location.origin });
const params = new URLSearchParams(window.location.search);
/** `build:demo` builds with `--mode demo`: the static site never calls /api and always replays. */
const staticBuild = import.meta.env.MODE === 'demo';
const forceDemo = staticBuild || params.has('demo');
/**
 * `?demo` (or the static build) replays the real multi-agent run; the GitHub CI loop is one click
 * away in RecordingControl. `?demo=<name>` plays another bundled recording, and `?demo=example`
 * the built-in example run.
 */
const {
  preset: initialPreset,
  requestedRecording,
  example: playExample,
} = demoSelection(params.get('demo'));

/**
 * Picks the data source. If a Helix daemon answers, show the real project (live events over SSE,
 * replayed from seq 0 so backfill and live share one path). Otherwise fall back to demo mode,
 * which replays a recorded run, so the app always shows something real.
 */
export function useHelixSource(): HelixSource {
  const [mode, setMode] = useState<SourceMode>(forceDemo ? 'demo' : 'connecting');
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [project, setProject] = useState<Project>();
  const [liveEvents, setLiveEvents] = useState<HelixEvent[]>([]);
  const [stream, setStream] = useState<EventStreamStatus>('connecting');
  const [error, setError] = useState<string>();
  const [recording, setRecording] = useState<Recording>();
  const [demoPreset, setDemoPreset] = useState<DemoPreset>(initialPreset);
  const [recordingError, setRecordingError] = useState<string>();
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const demoRun = recording?.events ?? builtInRun(demoPreset);
  const demoEvents = useDemoStream(
    demoRun,
    recording || demoPreset === 'cross-review'
      ? { startAt: replayStart(demoRun), speed }
      : { speed },
  );

  // Demo mode loads the scenario's recording; a missing one leaves the built-in example playing.
  useEffect(() => {
    if (mode !== 'demo' || recording || (playExample && demoPreset === 'multi-agent')) return;
    const targetName = demoPreset === 'custom' ? requestedRecording : presetRecording(demoPreset);
    if (!targetName) return;
    let cancelled = false;
    fetchRecording(targetName)
      .then((r) => !cancelled && setRecording(r))
      .catch((e: unknown) => {
        if (!cancelled) setRecordingError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, demoPreset, recording]);

  const selectDemoPreset = useCallback((preset: BuiltInPreset) => {
    setRecordingError(undefined);
    setRecording(undefined);
    setDemoPreset(preset);
  }, []);

  const openRecording = useCallback(async (file: File) => {
    try {
      const r = await openRecordingFile(file);
      setRecordingError(undefined);
      setRecording(r);
      setDemoPreset('custom');
      setMode('demo');
    } catch (e) {
      setRecordingError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadProjects = useCallback(async (preferredId?: string) => {
    const list = await client.projects();
    setProjects(list);
    if (list.length === 0) {
      setMode('empty');
      return;
    }
    setProject((prev) => {
      if (preferredId) {
        const match = list.find((p) => p.id === preferredId);
        if (match) return match;
      }
      if (prev) {
        const current = list.find((p) => p.id === prev.id);
        if (current) return current;
      }
      return list[0];
    });
    setMode('live');
  }, []);

  const selectProject = useCallback(
    (projectId: string) => {
      const next = projects.find((p) => p.id === projectId);
      if (next) setProject(next);
    },
    [projects],
  );

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
        const created = await client.createProject({ repoPath });
        await loadProjects(created.id);
      } catch (e) {
        // The project may exist even if this request failed (a dropped response, a retry of an
        // earlier add). Move on to the board whenever the daemon has a project.
        const exists = await client
          .projects()
          .then((list) => list.length > 0)
          .catch(() => false);
        if (exists) {
          await loadProjects();
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [loadProjects],
  );

  return useMemo<HelixSource>(() => {
    if (mode === 'demo' || mode === 'connecting')
      return {
        mode,
        events: demoEvents,
        projects: [],
        stream: 'demo',
        selectProject,
        addProject,
        openRecording,
        speed,
        setSpeed,
        demoPreset,
        selectDemoPreset,
        staticBuild,
        ...(recording ? { recording: { name: recording.name, header: recording.header } } : {}),
        ...(recordingError ? { recordingError } : {}),
        ...(error ? { error } : {}),
      };
    return {
      mode,
      events: liveEvents,
      projects,
      client,
      ...(project ? { project } : {}),
      stream,
      selectProject,
      addProject,
      openRecording,
      speed,
      setSpeed,
      staticBuild,
      ...(error ? { error } : {}),
    };
  }, [
    mode,
    demoEvents,
    liveEvents,
    projects,
    project,
    stream,
    selectProject,
    addProject,
    openRecording,
    speed,
    demoPreset,
    selectDemoPreset,
    recording,
    recordingError,
    error,
  ]);
}
