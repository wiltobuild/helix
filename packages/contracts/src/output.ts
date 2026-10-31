import { z } from 'zod';
import { sessionIdSchema } from './ids.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const head = z.string().regex(/^[a-f0-9]{40,64}$/);
export const outputFeedbackSchema = z.strictObject({
  id: z.string().min(1).max(255),
  revision: z.number().int().positive(),
  headSha: head,
  text: z.string().trim().min(1).max(4000),
  status: z.enum(['pending', 'routed', 'blocked', 'resolved', 'dismissed']),
  disposition: z.string().max(1000),
});
/** Evidence is an immutable artifact, not a claim that acceptance tests passed. */
export const outputSchema = z.strictObject({
  workerSessionId: sessionIdSchema,
  buildSessionId: sessionIdSchema,
  revision: z.number().int().positive(),
  branch: z.string().min(1),
  headSha: head,
  artifactHash: digest.optional(),
  briefHash: digest,
  designHash: digest,
  status: z.enum(['starting', 'running', 'error', 'stopped', 'unavailable']),
  message: z.string().max(1000),
  feedback: z.array(outputFeedbackSchema),
});
// No user supplied command, path, host or port is accepted.
const base = { requestId: z.string().min(1).max(255), revision: z.number().int().nonnegative() };
export const outputRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...base, action: z.literal('start') }),
  z.strictObject({ ...base, action: z.literal('stop') }),
  z.strictObject({
    ...base,
    action: z.literal('feedback'),
    headSha: head,
    text: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({
    ...base,
    action: z.literal('resolve'),
    feedbackId: z.string().min(1).max(255),
    disposition: z.string().trim().min(1).max(1000),
    status: z.enum(['resolved', 'dismissed']),
  }),
]);
export const outputResponseSchema = z.strictObject({ output: outputSchema.nullable() });
export const outputLeaseSchema = z.strictObject({
  revision: z.number().int().positive(),
  artifactHash: digest,
  // The live-only lease is never saved in events or recordings.
  url: z.string().regex(/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/[a-f0-9]{48}\/$/),
  stale: z.boolean(),
  pendingChanges: z.boolean(),
});
export const outputLeaseResponseSchema = z.strictObject({ lease: outputLeaseSchema.nullable() });
export type Output = z.infer<typeof outputSchema>;
export type OutputRequest = z.infer<typeof outputRequestSchema>;
export type OutputLease = z.infer<typeof outputLeaseSchema>;
