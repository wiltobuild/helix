import { HelixError } from '@helix/contracts';
import { createSetupChecks, type SetupCore } from './setup.js';
import { backfill, routes, type RouteName } from '@helix/contracts';
import type { z } from 'zod';

type Routes = typeof routes;
type HttpName = {
  [K in RouteName]: Routes[K] extends { transport: string } ? never : K;
}[RouteName];
type Field<R, K extends PropertyKey> = K extends keyof R
  ? R[K] extends z.ZodType
    ? z.output<R[K]>
    : never
  : Record<string, never>;
type Input<K extends HttpName> = {
  params: Field<Routes[K], 'params'>;
  query: Field<Routes[K], 'query'>;
  headers: Field<Routes[K], 'headers'>;
  body: z.output<Routes[K]['request']>;
};
type Handlers = { [K in HttpName]: (input: Input<K>) => Promise<z.output<Routes[K]['response']>> };

export function createDispatch(core: SetupCore) {
  const handlers: Handlers = {
    discoveryIntake: () => {
      if (!core.discoveryIntake)
        throw new HelixError('HARNESS_UNAVAILABLE', 'Repository-free discovery is unavailable');
      return core.discoveryIntake();
    },
    changeDiscovery: ({ body }) => {
      if (!core.changeDiscovery)
        throw new HelixError('HARNESS_UNAVAILABLE', 'Repository-free discovery is unavailable');
      return core.changeDiscovery(body);
    },
    projectIntake: ({ params }) =>
      core.projectIntake ? core.projectIntake(params.id) : Promise.resolve({ draft: null }),
    changeIntake: ({ params, body }) => {
      if (!core.changeIntake)
        throw new HelixError('HARNESS_UNAVAILABLE', 'Guided intake is unavailable');
      return core.changeIntake(params.id, body);
    },
    sessionDesign: ({ params }) =>
      core.sessionDesign ? core.sessionDesign(params.id) : Promise.resolve({ design: null }),
    changeDesign: ({ params, body }) => {
      if (!core.changeDesign)
        throw new HelixError('HARNESS_UNAVAILABLE', 'Visual design is unavailable');
      return core.changeDesign(params.id, body);
    },
    setup: core.setup ?? createSetupChecks(),
    health: () => core.health(),
    harnesses: () => core.harnesses(),
    projects: () => core.listProjects(),
    createProject: ({ body }) => core.addProject(body),
    projectEvents: ({ params, query }) =>
      core.projectEvents(
        params.id,
        Number(query.since ?? backfill.defaultSince),
        Number(query.limit ?? backfill.defaultLimit),
      ),
    createSession: ({ params, body, headers }) =>
      core.createSession(params.id, body, headers['idempotency-key']),
    sendMessage: async ({ params, body }) => {
      await core.sendMessage(params.id, body);
      return { accepted: true };
    },
    stopSession: async ({ params }) => {
      await core.stopSession(params.id);
      return { accepted: true };
    },
    archiveSession: ({ params }) => core.archiveSession(params.id),
    stopProjectAgents: ({ params }) => core.stopAll(params.id),
    decideApproval: ({ params, body }) => core.decideApproval(params.id, body),
    sessionDiff: ({ params, query }) => core.diff(params.id, query.scope),
    mergeSession: ({ params }) => core.merge(params.id),
    submitPlan: ({ body }) => core.submitPlan(body),
    decidePlan: ({ params, body }) => core.decidePlan(params.id, body),
    explain: ({ body }) => core.explain(body),
    submitReview: ({ body }) => core.submitReview(body),
    exportRecording: ({ params }) => core.exportRecording(params.projectId),
    importRecording: ({ body }) => core.importRecording(body),
  };
  return <K extends HttpName>(name: K, input: Input<K>) => handlers[name](input);
}
