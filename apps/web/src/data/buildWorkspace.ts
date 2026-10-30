import { projectBuilds, type BuildView, type ProjectState } from '@helix/contracts';

/** Explicit build selection wins; a selected agent resolves to its owning build.
 * A root not yet present at the replay cursor cannot leak future data. */
export function buildWorkspace(
  project: ProjectState,
  selected?: string,
): { builds: BuildView[]; build?: BuildView; state: ProjectState } {
  const builds = projectBuilds(project);
  const build =
    builds.find(
      (b) => b.rootSessionId === selected || b.sessionIds.some((id) => id === selected),
    ) ?? builds.at(-1);
  if (!build) return { builds, state: project };
  const ids = new Set(build.sessionIds);
  return {
    builds,
    build,
    state: {
      ...project,
      sessions: Object.fromEntries(
        Object.entries(project.sessions).filter(([, s]) => ids.has(s.session.id)),
      ),
      plans: Object.fromEntries(
        Object.entries(project.plans).filter(
          ([, p]) => p.orchestratorSessionId === build.rootSessionId,
        ),
      ),
      approvals: Object.fromEntries(
        Object.entries(project.approvals).filter(([, a]) => ids.has(a.sessionId)),
      ),
    },
  };
}
