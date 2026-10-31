import { projectIdSchema } from './ids.js';
import { z } from 'zod';

const text = z.string().trim().min(1).max(60000);
export const intakeAnswerSchema = z.strictObject({
  id: text,
  question: text,
  answer: text,
  offeredChoices: z
    .array(z.strictObject({ label: text, tradeoff: text }))
    .max(4)
    .optional(),
  assistantMessage: z.string().max(6000).optional(),
  source: z.enum(['user', 'recommendation-accepted']),
});
export const intakeSynthesisSchema = z.strictObject({
  message: z.string().trim().max(6000).optional(),
  brief: text,
  question: z.string().max(2000),
  choices: z.array(z.strictObject({ label: text, tradeoff: text })).max(4),
  unknowns: z.array(text).max(12),
  assumptions: z.array(text).max(20),
  confirmed: z.array(z.strictObject({ statement: text, answerIds: z.array(text) })).max(30),
});
export const reviewedBriefSchema = z.strictObject({
  intakeId: text,
  revision: z.number().int().positive(),
  text,
  approvedAt: z.string(),
  answers: z.array(intakeAnswerSchema),
  assumptions: z.array(text),
});
export const intakeDraftSchema = z.strictObject({
  destinationProjectId: projectIdSchema.optional(),
  id: text,
  revision: z.number().int().positive(),
  title: z.string().max(300),
  originalGoal: z.string().max(60000),
  mode: z.enum(['direct', 'interview']),
  answers: z.array(intakeAnswerSchema).max(100),
  synthesis: intakeSynthesisSchema.nullable(),
  versions: z.array(
    z.strictObject({ revision: z.number(), text, source: z.enum(['agent', 'user']) }),
  ),
  status: z.enum(['editing', 'generating', 'review', 'failed', 'launching', 'launched']),
  error: z.string().optional(),
  sessionId: z.string().optional(),
  approved: reviewedBriefSchema.optional(),
});
const base = { id: text, revision: z.number().int().nonnegative(), requestId: text };
export const intakeRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...base, action: z.literal('new'), mode: z.enum(['direct', 'interview']) }),
  z.strictObject({
    ...base,
    action: z.literal('edit'),
    title: z.string().max(300),
    originalGoal: z.string().max(60000),
    answers: z.array(intakeAnswerSchema).max(100),
  }),
  z.strictObject({ ...base, action: z.literal('bind'), projectId: projectIdSchema }),
  z.strictObject({ ...base, action: z.literal('generate') }),
  z.strictObject({ ...base, action: z.literal('cancel') }),
  z.strictObject({ ...base, action: z.literal('brief'), text }),
  z.strictObject({ ...base, action: z.literal('approve') }),
]);
export const intakeResponseSchema = z.strictObject({ draft: intakeDraftSchema.nullable() });
export type IntakeDraft = z.infer<typeof intakeDraftSchema>;
export type IntakeRequest = z.infer<typeof intakeRequestSchema>;
export type IntakeSynthesis = z.infer<typeof intakeSynthesisSchema>;
export type ReviewedBrief = z.infer<typeof reviewedBriefSchema>;
