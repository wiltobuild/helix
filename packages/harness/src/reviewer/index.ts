import { readFileSync } from 'node:fs';
import type { PlanNode, Project, PullRequestFacts, Session } from '@helix/contracts';

export const REVIEWER_PROMPT = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');

export function reviewerPrompt(ctx: {
  project: Project;
  worker: Session;
  reviewer: Session;
  pr: PullRequestFacts;
  node?: PlanNode;
}): string {
  const exactFiles = ctx.node?.exactFiles?.length
    ? `\nExact UTF-8 file requirements (JSON escapes preserve punctuation and final newlines):\n${ctx.node.exactFiles.map((file) => `${file.path}: ${JSON.stringify(file.content)}`).join('\n')}`
    : '';
  return `${REVIEWER_PROMPT}\n\nProject: ${ctx.project.name}\nBase branch: ${ctx.project.defaultBranch}\nPR: #${ctx.pr.number} ${ctx.pr.url}\nRequested head: ${ctx.pr.headSha}\nWorker agent: ${ctx.worker.agent}\nWorktree (read only): ${ctx.worker.worktreePath}\nScratch cwd: ${ctx.reviewer.worktreePath}\nReviewer session: ${ctx.reviewer.id}\nTask: ${ctx.worker.prompt}\nAcceptance criteria:\n${ctx.node?.acceptance.map((a) => `- ${a}`).join('\n') ?? 'Use the task requirements.'}${exactFiles}`;
}
