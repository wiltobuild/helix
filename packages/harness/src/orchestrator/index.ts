import { readFileSync } from 'node:fs';
import type { Project, Session } from '@helix/contracts';

export const ORCHESTRATOR_PROMPT: string = readFileSync(
  new URL('./prompt.md', import.meta.url),
  'utf8',
);

export function orchestratorPrompt(ctx: { project: Project; session: Session }): string {
  return `Project: ${ctx.project.name}\nDefault branch: ${ctx.project.defaultBranch}\nProject id: ${ctx.project.id}\nSession id: ${ctx.session.id}\n\n${ORCHESTRATOR_PROMPT}`;
}
