import { z } from 'zod';
import { planNodeIdSchema } from './ids.js';
export const planReviewResultSchema = z
  .strictObject({
    verdict: z.enum(['passed', 'changes_requested']),
    summary: z.string().trim().min(1).max(4000),
    findings: z
      .array(
        z.strictObject({
          nodeIds: z.array(planNodeIdSchema).min(1).max(100),
          severity: z.enum(['blocking', 'important']),
          evidence: z.string().trim().min(1).max(2000),
          change: z.string().trim().min(1).max(2000),
        }),
      )
      .max(30),
  })
  .refine(
    (r) => (r.verdict === 'passed' ? r.findings.length === 0 : r.findings.length > 0),
    'Verdict must match findings',
  );
export type PlanReviewResult = z.infer<typeof planReviewResultSchema>;
export const planReviewSchema = z
  .strictObject({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    attempt: z.number().int().min(1).max(3),
    status: z.enum(['reviewing', 'passed', 'changes_requested', 'failed', 'cancelled']),
    reviewer: z.literal('codex'),
    message: z.string().max(4000),
    result: planReviewResultSchema.optional(),
  })
  .refine(
    (review) => review.status !== 'passed' || review.result?.verdict === 'passed',
    'Passing status requires a passing result',
  );
export type PlanReview = z.infer<typeof planReviewSchema>;
