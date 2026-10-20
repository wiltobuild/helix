import { z } from 'zod';

const id = z.string().min(1).max(64);
export const projectIdSchema = id.brand<'ProjectId'>();
export const sessionIdSchema = id.brand<'SessionId'>();
export const planIdSchema = id.brand<'PlanId'>();
export const planNodeIdSchema = id.brand<'PlanNodeId'>();
export const approvalIdSchema = id.brand<'ApprovalId'>();
export const eventSeqSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).brand<'EventSeq'>();
export const pullRequestNumberSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).brand<'PullRequestNumber'>();

export type ProjectId = z.infer<typeof projectIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type PlanId = z.infer<typeof planIdSchema>;
export type PlanNodeId = z.infer<typeof planNodeIdSchema>;
export type ApprovalId = z.infer<typeof approvalIdSchema>;
export type EventSeq = z.infer<typeof eventSeqSchema>;
export type PullRequestNumber = z.infer<typeof pullRequestNumberSchema>;
