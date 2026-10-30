import { intakeRequestSchema, intakeResponseSchema } from './intake.js';
import { reviewedBriefSchema } from './intake.js';
import { z } from 'zod';
import { visualDesignRequestSchema, visualDesignResponseSchema } from './visual-design.js';
import {
  agentKindSchema,
  agentReviewSchema,
  approvalDecisionSchema,
  approvalSchema,
  countSchema,
  planNodesSchema,
  planSchema,
  projectSchema,
  sessionInterfaceSchema,
  sessionSchema,
} from './entities.js';
import {
  approvalIdSchema,
  eventSeqSchema,
  planIdSchema,
  planNodeIdSchema,
  projectIdSchema,
  sessionIdSchema,
} from './ids.js';
import { eventSchemas, helixEventSchema } from './events.js';

export const harnessInfoSchema = z.strictObject({
  agent: agentKindSchema,
  installed: z.boolean(),
  version: z.string().optional(),
  signedIn: z.union([z.boolean(), z.literal('unknown')]).optional(),
});
export type HarnessInfo = z.infer<typeof harnessInfoSchema>;
export const healthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  version: z.string().min(1),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export const harnessesResponseSchema = z.array(harnessInfoSchema);
export type HarnessesResponse = z.infer<typeof harnessesResponseSchema>;
export const setupRequestSchema = z.strictObject({});
export const setupCheckSchema = z.strictObject({
  ok: z.boolean(),
  detail: z.string(),
  fix: z.string().optional(),
});
export const setupAgentSchema = setupCheckSchema.extend({
  installed: z.boolean(),
  version: z.string().optional(),
  signedIn: z.union([z.boolean(), z.literal('unknown')]),
});
export const setupToolSchema = setupCheckSchema.extend({ version: z.string().optional() });
export const setupResponseSchema = z.strictObject({
  agents: z.strictObject({ codex: setupAgentSchema, 'claude-code': setupAgentSchema }),
  github: setupCheckSchema.extend({
    status: z.enum(['on', 'off', 'unavailable']),
    tokenResolved: z.boolean(),
    login: z.string().optional(),
  }),
  tools: z.strictObject({ git: setupToolSchema, node: setupToolSchema, pnpm: setupToolSchema }),
  config: setupCheckSchema.extend({
    reviewer: z.boolean().optional(),
    autoApprove: z.boolean().optional(),
    maxWorkers: z.number().int().positive().optional(),
    maxTurns: z.number().int().positive().optional(),
    codexModel: z.string().nullable().optional(),
    codexEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  }),
});
export type SetupResponse = z.infer<typeof setupResponseSchema>;
export type SetupRequest = z.infer<typeof setupRequestSchema>;
export const projectsResponseSchema = z.array(projectSchema);
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;
export const createProjectRequestSchema = z.strictObject({
  repoPath: z.string().min(1),
  name: z.string().min(1).optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export const createSessionRequestSchema = z.strictObject({
  title: z.string().min(1),
  reviewedBrief: reviewedBriefSchema.optional(),
  prompt: z.string().min(1),
  agent: agentKindSchema,
  model: z.string().min(1).optional(),
  interface: sessionInterfaceSchema,
  planWithOrchestrator: z.boolean().optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export const messageModeSchema = z.enum(['queue', 'interrupt']);
export type MessageMode = z.infer<typeof messageModeSchema>;
export const sendMessageRequestSchema = z.strictObject({
  text: z.string().min(1),
  mode: messageModeSchema,
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
export const approvalDecisionRequestSchema = z.strictObject({ decision: approvalDecisionSchema });
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionRequestSchema>;
export const submitPlanRequestSchema = z.strictObject({
  projectId: projectIdSchema,
  orchestratorSessionId: sessionIdSchema,
  goal: z.string().min(1),
  nodes: planNodesSchema,
});
export type SubmitPlanRequest = z.infer<typeof submitPlanRequestSchema>;
export const planDecisionRequestSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(1).optional(),
});
export type PlanDecisionRequest = z.infer<typeof planDecisionRequestSchema>;
export const planDecisionResponseSchema = z.strictObject({
  planId: planIdSchema,
  status: z.enum(['approved', 'rejected']),
});
export type PlanDecisionResponse = z.infer<typeof planDecisionResponseSchema>;
export const explainRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  planNodeId: planNodeIdSchema.optional(),
  text: z.string().min(1),
  causedBy: eventSeqSchema.optional(),
});
export type ExplainRequest = z.infer<typeof explainRequestSchema>;
/** `helix review submit`: a reviewer session's verdict on the PR head it was asked to review. */
export const submitReviewRequestSchema = z.strictObject({
  reviewerSessionId: sessionIdSchema,
  headSha: z.string().min(1),
  review: agentReviewSchema,
});
export type SubmitReviewRequest = z.infer<typeof submitReviewRequestSchema>;
export const acceptedResponseSchema = z.strictObject({ accepted: z.literal(true) });
export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;
export const stopProjectAgentsResponseSchema = z.strictObject({
  stopped: z.array(sessionIdSchema),
});
export const mergeResponseSchema = z.strictObject({ mergeSha: z.string().min(1) });
export type MergeResponse = z.infer<typeof mergeResponseSchema>;
export const diffScopeSchema = z.enum(['workspace', 'pr', 'last_turn']);
export type DiffScope = z.infer<typeof diffScopeSchema>;
export const diffFileSchema = z.strictObject({
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'untracked']),
  insertions: countSchema,
  deletions: countSchema,
  binary: z.boolean(),
});
export type DiffFile = z.infer<typeof diffFileSchema>;
export const diffResponseSchema = z.strictObject({
  unifiedDiff: z.string(),
  files: z.array(diffFileSchema),
});
export type DiffResponse = z.infer<typeof diffResponseSchema>;
export const eventsResponseSchema = z.strictObject({
  events: z.array(helixEventSchema),
  lastSeq: countSchema,
});
export type EventsResponse = z.infer<typeof eventsResponseSchema>;

// Query/header schemas describe decoded HTTP strings; handlers convert after validation.
export const cursorStringSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((s) => Number.isSafeInteger(Number(s)), 'Cursor must be a safe integer');
export const eventsQuerySchema = z.strictObject({
  since: cursorStringSchema.optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d*$/)
    .refine((s) => Number(s) <= 1000, 'Maximum page size is 1000')
    .optional(),
});
export type EventsQuery = z.infer<typeof eventsQuerySchema>;
export const sseQuerySchema = z.strictObject({
  since: cursorStringSchema.optional(),
  projectId: projectIdSchema.optional(),
});
export type SseQuery = z.infer<typeof sseQuerySchema>;
// Header keys are normalized to lowercase by the HTTP adapter. Other HTTP headers are allowed.
export const idempotencyHeadersSchema = z.looseObject({
  'idempotency-key': z.string().min(1).max(255),
});
export const sseHeadersSchema = z.looseObject({ 'last-event-id': cursorStringSchema.optional() });
export const sseMessageSchema = z
  .strictObject({
    id: z.string().regex(/^[1-9]\d*$/),
    event: z.literal('helix'),
    data: helixEventSchema,
  })
  .refine((m) => m.id === String(m.data.seq), 'SSE id must match event seq');
export type SseMessage = z.infer<typeof sseMessageSchema>;
export const sse = {
  contentType: 'text/event-stream',
  event: 'helix',
  heartbeatMs: 15_000,
  heartbeat: ': heartbeat\n\n',
  resumeHeader: 'Last-Event-ID',
  cursorPrecedence: 'header-over-query',
  defaultSince: 0,
} as const;
export const backfill = {
  defaultSince: 0,
  defaultLimit: 100,
  maxLimit: 1000,
  sinceExclusive: true,
  lastSeqMeaning: 'last-returned-seq-or-requested-since',
} as const;

export const terminalInputSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('in'), data: z.string() }),
  z.strictObject({
    t: z.literal('resize'),
    cols: z.number().int().min(1).max(65535),
    rows: z.number().int().min(1).max(65535),
  }),
]);
export type TerminalInput = z.infer<typeof terminalInputSchema>;
export const terminalOutputSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('out'), data: z.string() }),
  z.strictObject({ t: z.literal('exit'), code: z.number().int().nullable() }),
]);
export type TerminalOutput = z.infer<typeof terminalOutputSchema>;
export const terminalMessageSchema = z.union([terminalInputSchema, terminalOutputSchema]);
export type TerminalMessage = z.infer<typeof terminalMessageSchema>;
export const errorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'NOT_FOUND',
  'CONFLICT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'HARNESS_UNAVAILABLE',
  'DIRTY_WORKTREE',
  'MERGE_BLOCKED',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string(),
    details: z.json().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
export const recordingImportRequestSchema = z.string().min(1);
export type RecordingImportRequest = z.infer<typeof recordingImportRequestSchema>;
export const recordingImportResponseSchema = z.strictObject({
  project: projectSchema,
  eventCount: countSchema,
  lastSeq: countSchema,
});
export type RecordingImportResponse = z.infer<typeof recordingImportResponseSchema>;
const empty = z.strictObject({});
const projectParams = z.strictObject({ id: projectIdSchema });
const sessionParams = z.strictObject({ id: sessionIdSchema });

/** Request bodies/params/query are decoded objects; no-body routes normalize to {}.
 * Error responses on every route use apiErrorSchema. SSE/WS response denotes each message.
 * Import/export use raw UTF-8 JSON Lines, application/x-helixlog (not a JSON wrapper).
 */
export const routes = {
  discoveryIntake: {
    method: 'GET',
    path: '/api/discovery',
    request: empty,
    response: intakeResponseSchema,
    status: 200,
  },
  changeDiscovery: {
    method: 'POST',
    path: '/api/discovery',
    request: intakeRequestSchema,
    response: intakeResponseSchema,
    status: 200,
  },
  projectIntake: {
    method: 'GET',
    path: '/api/projects/:id/intake',
    params: projectParams,
    request: empty,
    response: intakeResponseSchema,
    status: 200,
  },
  changeIntake: {
    method: 'POST',
    path: '/api/projects/:id/intake',
    params: projectParams,
    request: intakeRequestSchema,
    response: intakeResponseSchema,
    status: 200,
  },
  sessionDesign: {
    method: 'GET',
    path: '/api/sessions/:id/design',
    params: sessionParams,
    request: empty,
    response: visualDesignResponseSchema,
    status: 200,
  },
  changeDesign: {
    method: 'POST',
    path: '/api/sessions/:id/design',
    params: sessionParams,
    request: visualDesignRequestSchema,
    response: visualDesignResponseSchema,
    status: 200,
  },
  health: {
    method: 'GET',
    path: '/api/health',
    request: empty,
    response: healthResponseSchema,
    status: 200,
  },
  harnesses: {
    method: 'GET',
    path: '/api/harnesses',
    request: empty,
    response: harnessesResponseSchema,
    status: 200,
  },
  setup: {
    method: 'GET',
    path: '/api/setup',
    request: setupRequestSchema,
    response: setupResponseSchema,
    status: 200,
  },
  projects: {
    method: 'GET',
    path: '/api/projects',
    request: empty,
    response: projectsResponseSchema,
    status: 200,
  },
  createProject: {
    method: 'POST',
    path: '/api/projects',
    request: createProjectRequestSchema,
    response: projectSchema,
    status: 201,
  },
  projectEvents: {
    method: 'GET',
    path: '/api/projects/:id/events',
    params: projectParams,
    query: eventsQuerySchema,
    request: empty,
    response: eventsResponseSchema,
    status: 200,
  },
  events: {
    method: 'GET',
    path: '/api/events',
    query: sseQuerySchema,
    headers: sseHeadersSchema,
    request: empty,
    response: sseMessageSchema,
    status: 200,
    transport: 'sse',
  },
  createSession: {
    method: 'POST',
    path: '/api/projects/:id/sessions',
    params: projectParams,
    headers: idempotencyHeadersSchema,
    request: createSessionRequestSchema,
    response: sessionSchema,
    status: 201,
  },
  sendMessage: {
    method: 'POST',
    path: '/api/sessions/:id/messages',
    params: sessionParams,
    request: sendMessageRequestSchema,
    response: acceptedResponseSchema,
    status: 202,
  },
  stopSession: {
    method: 'POST',
    path: '/api/sessions/:id/stop',
    params: sessionParams,
    request: empty,
    response: acceptedResponseSchema,
    status: 202,
  },
  stopProjectAgents: {
    method: 'POST',
    path: '/api/projects/:id/stop-all',
    params: projectParams,
    request: empty,
    response: stopProjectAgentsResponseSchema,
    status: 200,
  },
  archiveSession: {
    method: 'POST',
    path: '/api/sessions/:id/archive',
    params: sessionParams,
    request: empty,
    response: sessionSchema,
    status: 200,
  },
  decideApproval: {
    method: 'POST',
    path: '/api/approvals/:id/decision',
    params: z.strictObject({ id: approvalIdSchema }),
    request: approvalDecisionRequestSchema,
    response: approvalSchema,
    status: 200,
  },
  sessionDiff: {
    method: 'GET',
    path: '/api/sessions/:id/diff',
    params: sessionParams,
    query: z.strictObject({ scope: diffScopeSchema }),
    request: empty,
    response: diffResponseSchema,
    status: 200,
  },
  mergeSession: {
    method: 'POST',
    path: '/api/sessions/:id/merge',
    params: sessionParams,
    request: empty,
    response: mergeResponseSchema,
    status: 200,
  },
  submitPlan: {
    method: 'POST',
    path: '/api/plans',
    request: submitPlanRequestSchema,
    response: planSchema,
    status: 201,
  },
  decidePlan: {
    method: 'POST',
    path: '/api/plans/:id/decision',
    params: z.strictObject({ id: planIdSchema }),
    request: planDecisionRequestSchema,
    response: planDecisionResponseSchema,
    status: 200,
  },
  explain: {
    method: 'POST',
    path: '/api/explain',
    request: explainRequestSchema,
    response: eventSchemas['explain.note'],
    status: 201,
  },
  submitReview: {
    method: 'POST',
    path: '/api/reviews',
    request: submitReviewRequestSchema,
    response: eventSchemas['agent_review.submitted'],
    status: 201,
  },
  exportRecording: {
    method: 'GET',
    path: '/api/recordings/:projectId/export',
    params: z.strictObject({ projectId: projectIdSchema }),
    request: empty,
    response: z.string(),
    status: 200,
    contentType: 'application/x-helixlog',
  },
  importRecording: {
    method: 'POST',
    path: '/api/recordings/import',
    request: recordingImportRequestSchema,
    response: recordingImportResponseSchema,
    status: 201,
    contentType: 'application/x-helixlog',
  },
  terminal: {
    method: 'GET',
    path: '/mux',
    query: z.strictObject({ sessionId: sessionIdSchema }),
    request: terminalInputSchema,
    response: terminalOutputSchema,
    status: 101,
    transport: 'websocket',
  },
} as const;
export type RouteName = keyof typeof routes;

/** JSON Schema draft 2020-12. Semantic cross-field refinements still require Zod. */
export function toJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, { target: 'draft-2020-12' });
}
export function routeJsonSchemas() {
  return Object.fromEntries(
    Object.entries(routes).map(([name, route]) => [
      name,
      {
        method: route.method,
        path: route.path,
        status: route.status,
        request: toJsonSchema(route.request),
        response: toJsonSchema(route.response),
        error: toJsonSchema(apiErrorSchema),
        ...('params' in route ? { params: toJsonSchema(route.params) } : {}),
        ...('query' in route ? { query: toJsonSchema(route.query) } : {}),
        ...('headers' in route ? { headers: toJsonSchema(route.headers) } : {}),
      },
    ]),
  );
}
