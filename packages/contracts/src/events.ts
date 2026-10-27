import { z } from 'zod';
import {
  approvalIdSchema,
  eventSeqSchema,
  planIdSchema,
  planNodeIdSchema,
  projectIdSchema,
  pullRequestNumberSchema,
  sessionIdSchema,
} from './ids.js';
import {
  agentActivitySchema,
  approvalDecisionSchema,
  approvalSchema,
  chatItemSchema,
  checkSummarySchema,
  countSchema,
  planSchema,
  projectSchema,
  pullRequestFactsSchema,
  reviewSummarySchema,
  sessionSchema,
  timestampSchema,
} from './entities.js';

const envelope = {
  seq: eventSeqSchema,
  ts: timestampSchema,
  projectId: projectIdSchema,
  sessionId: sessionIdSchema.optional(),
  planNodeId: planNodeIdSchema.optional(),
  causedBy: eventSeqSchema.optional(),
  v: z.literal(1),
};
function event<const T extends string, S extends z.ZodType>(type: T, payload: S) {
  return z.strictObject({ ...envelope, type: z.literal(type), payload });
}

/** Full envelope schemas keyed by type; payload schemas are available via .shape.payload. */
export const eventSchemas = {
  'project.added': event('project.added', z.strictObject({ project: projectSchema })),
  'session.created': event('session.created', z.strictObject({ session: sessionSchema })),
  'session.started': event('session.started', z.strictObject({})),
  'session.exited': event(
    'session.exited',
    z.strictObject({ code: z.number().int().nullable(), signal: z.string().min(1).optional() }),
  ),
  'session.archived': event('session.archived', z.strictObject({})),
  'activity.changed': event('activity.changed', z.strictObject({ activity: agentActivitySchema })),
  'chat.item': event('chat.item', z.strictObject({ item: chatItemSchema })),
  'approval.requested': event('approval.requested', z.strictObject({ approval: approvalSchema })),
  'approval.decided': event(
    'approval.decided',
    z.strictObject({ approvalId: approvalIdSchema, decision: approvalDecisionSchema }),
  ),
  'reasoning.summary': event(
    'reasoning.summary',
    z.strictObject({ text: z.string(), source: z.enum(['agent', 'orchestrator']) }),
  ),
  'plan.submitted': event('plan.submitted', z.strictObject({ plan: planSchema })),
  'plan.approved': event(
    'plan.approved',
    z.strictObject({ planId: planIdSchema, approvedBy: z.literal('human') }),
  ),
  'plan.rejected': event(
    'plan.rejected',
    z.strictObject({ planId: planIdSchema, reason: z.string().trim().min(1) }),
  ),
  'plan.node_updated': event(
    'plan.node_updated',
    z.strictObject({
      nodeId: planNodeIdSchema,
      sessionId: sessionIdSchema.optional(),
      note: z.string().optional(),
    }),
  ),
  'explain.note': event(
    'explain.note',
    z.strictObject({
      text: z.string(),
      /** Who is making the claim: Helix itself (a recorded fact), the orchestrator (plan
       * rationale) or an agent (its own unverified summary). Absent on legacy events. */
      source: z.enum(['helix', 'orchestrator', 'agent']).optional(),
    }),
  ),
  'worktree.created': event(
    'worktree.created',
    z.strictObject({
      branch: z.string().min(1),
      path: z.string().min(1),
      baseSha: z.string().min(1),
    }),
  ),
  'worktree.diff_updated': event(
    'worktree.diff_updated',
    z.strictObject({ filesChanged: countSchema, insertions: countSchema, deletions: countSchema }),
  ),
  'pr.opened': event('pr.opened', z.strictObject({ pr: pullRequestFactsSchema })),
  'pr.updated': event('pr.updated', z.strictObject({ pr: pullRequestFactsSchema })),
  'ci.updated': event(
    'ci.updated',
    z.strictObject({ prNumber: pullRequestNumberSchema, checks: checkSummarySchema }),
  ),
  'review.updated': event(
    'review.updated',
    z.strictObject({ prNumber: pullRequestNumberSchema, review: reviewSummarySchema }),
  ),
  'feedback.routed': event(
    'feedback.routed',
    z.strictObject({
      prNumber: pullRequestNumberSchema,
      reason: z.enum(['ci_failed', 'changes_requested', 'merge_conflict']),
      summary: z.string(),
      toSessionId: sessionIdSchema,
    }),
  ),
  'pr.merged': event(
    'pr.merged',
    z.strictObject({ prNumber: pullRequestNumberSchema, mergeSha: z.string().min(1) }),
  ),
  'terminal.output_marker': event(
    'terminal.output_marker',
    z.strictObject({ bytesOffset: countSchema }),
  ),
} as const;
export type EventType = keyof typeof eventSchemas;
/** Distributive mapping preserves type/payload correlation even with the default union. */
export type HelixEvent<T extends EventType = EventType> = {
  [K in T]: z.infer<(typeof eventSchemas)[K]>;
}[T];
export type PayloadFor<T extends EventType> = HelixEvent<T>['payload'];
export type UnsequencedEvent = { [K in EventType]: Omit<HelixEvent<K>, 'seq'> }[EventType];
export const eventTypeSchema = z.enum(Object.keys(eventSchemas) as [EventType, ...EventType[]]);
const schemas = Object.values(eventSchemas);
export const helixEventSchema = z.discriminatedUnion(
  'type',
  schemas as [(typeof schemas)[number], ...(typeof schemas)[number][]],
);
export type ParseEventResult = z.ZodSafeParseResult<HelixEvent>;
export function parseEvent(value: unknown): ParseEventResult {
  return helixEventSchema.safeParse(value);
}
export function isEventOf<T extends EventType>(type: T): (e: HelixEvent) => e is HelixEvent<T> {
  return (e): e is HelixEvent<T> => e.type === type;
}
