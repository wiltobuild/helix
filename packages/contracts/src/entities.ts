import { z } from 'zod';
import { approvalIdSchema, planIdSchema, planNodeIdSchema, projectIdSchema, pullRequestNumberSchema, sessionIdSchema } from './ids.js';

export const timestampSchema = z.iso.datetime({ offset: false });
export const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const knownAgentKindSchema = z.enum(['claude-code', 'codex']);
/** Open enum: readers must render unknown agents by name and detect capabilities. */
export const agentKindSchema = z.union([knownAgentKindSchema, z.string().min(1).max(64)]);
export type KnownAgentKind = z.infer<typeof knownAgentKindSchema>;
export type AgentKind = z.infer<typeof agentKindSchema>;
export const sessionRoleSchema = z.enum(['worker', 'orchestrator', 'reviewer']);
export type SessionRole = z.infer<typeof sessionRoleSchema>;
export const sessionInterfaceSchema = z.enum(['chat', 'terminal']);
export type SessionInterface = z.infer<typeof sessionInterfaceSchema>;
export const agentActivitySchema = z.enum(['starting', 'active', 'idle', 'waiting_input', 'blocked', 'exited', 'unknown']);
export type AgentActivity = z.infer<typeof agentActivitySchema>;

export const projectSchema = z.strictObject({
  id: projectIdSchema, name: z.string().min(1), repoPath: z.string().min(1),
  defaultBranch: z.string().min(1), github: z.strictObject({ owner: z.string().min(1), repo: z.string().min(1) }).optional(),
  defaultAgent: agentKindSchema, createdAt: timestampSchema,
});
export type Project = z.infer<typeof projectSchema>;
export const sessionSchema = z.strictObject({
  id: sessionIdSchema, projectId: projectIdSchema, role: sessionRoleSchema, agent: agentKindSchema,
  model: z.string().min(1).optional(), title: z.string().min(1), prompt: z.string(),
  branch: z.string().min(1).optional(), worktreePath: z.string().min(1).optional(),
  planNodeId: planNodeIdSchema.optional(), parentSessionId: sessionIdSchema.optional(),
  variantOf: sessionIdSchema.optional(), interface: sessionInterfaceSchema,
  createdAt: timestampSchema, archivedAt: timestampSchema.optional(),
});
export type Session = z.infer<typeof sessionSchema>;
export const checkSummarySchema = z.strictObject({
  total: countSchema, passed: countSchema, failed: countSchema, pending: countSchema, failingNames: z.array(z.string().min(1)),
}).refine((c) => c.passed + c.failed + c.pending === c.total, 'Check counts must partition total');
export type CheckSummary = z.infer<typeof checkSummarySchema>;
export const reviewSummarySchema = z.strictObject({
  decision: z.enum(['approved', 'changes_requested', 'review_required', 'none']), unresolvedThreads: countSchema,
});
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;
export const pullRequestFactsSchema = z.strictObject({
  number: pullRequestNumberSchema, url: z.url({ protocol: /^https?$/ }), state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(), headSha: z.string().min(1), mergeable: z.enum(['mergeable', 'conflicting', 'unknown']),
  checks: checkSummarySchema, review: reviewSummarySchema, updatedAt: timestampSchema,
});
export type PullRequestFacts = z.infer<typeof pullRequestFactsSchema>;
export const planNodeSchema = z.strictObject({
  id: planNodeIdSchema, title: z.string().min(1), description: z.string(), acceptance: z.array(z.string().min(1)),
  dependsOn: z.array(planNodeIdSchema), agent: agentKindSchema, rationale: z.string(), sessionId: sessionIdSchema.optional(),
});
export type PlanNode = z.infer<typeof planNodeSchema>;
/** Graph integrity (unique IDs, known dependencies and DAG) is validated at submission. */
export const planNodesSchema = z.array(planNodeSchema).superRefine((nodes, ctx) => {
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) ctx.addIssue({ code: 'custom', message: 'Duplicate plan node ID' });
  const graph = new Map(nodes.map((n) => [n.id, n.dependsOn]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: PlanNode['id']): boolean => {
    if (visiting.has(id)) return false;
    if (done.has(id)) return true;
    visiting.add(id);
    for (const dep of graph.get(id) ?? []) if (!ids.has(dep) || !visit(dep)) return false;
    visiting.delete(id);
    done.add(id);
    return true;
  };
  for (const node of nodes) {
    if (new Set(node.dependsOn).size !== node.dependsOn.length || !visit(node.id)) {
      ctx.addIssue({ code: 'custom', message: 'Plan dependencies must be unique, known and acyclic' });
      break;
    }
  }
});
export const planSchema = z.strictObject({
  id: planIdSchema, projectId: projectIdSchema, orchestratorSessionId: sessionIdSchema,
  goal: z.string().min(1), nodes: planNodesSchema, createdAt: timestampSchema,
});
export type Plan = z.infer<typeof planSchema>;
export const approvalDecisionSchema = z.enum(['approved', 'rejected', 'changes_requested']);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export const approvalSchema = z.strictObject({
  id: approvalIdSchema, sessionId: sessionIdSchema, kind: z.enum(['command', 'file_write', 'migration', 'network', 'other']),
  summary: z.string().min(1), detail: z.string(), scope: z.enum(['once', 'session']), requestedAt: timestampSchema,
  decision: approvalDecisionSchema.optional(), decidedAt: timestampSchema.optional(),
});
export type Approval = z.infer<typeof approvalSchema>;
export const chatItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), role: z.enum(['user', 'assistant', 'system']), text: z.string() }),
  z.strictObject({ kind: z.literal('tool_call'), tool: z.string().min(1), inputSummary: z.string(), outputSummary: z.string().optional(), status: z.enum(['pending', 'running', 'succeeded', 'failed']) }),
  z.strictObject({ kind: z.literal('plan_update'), planId: planIdSchema, nodeId: planNodeIdSchema.optional(), text: z.string() }),
  z.strictObject({ kind: z.literal('approval'), approvalId: approvalIdSchema }),
  z.strictObject({ kind: z.literal('question'), prompt: z.string().min(1), options: z.array(z.string().min(1)).optional() }),
  z.strictObject({ kind: z.literal('reasoning_summary'), text: z.string() }),
]);
export type ChatItem = z.infer<typeof chatItemSchema>;
