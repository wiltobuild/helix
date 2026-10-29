import { readFileSync } from 'node:fs';
import type { Project, Session } from '@helix/contracts';

export const ORCHESTRATOR_PROMPT: string = readFileSync(
  new URL('./prompt.md', import.meta.url),
  'utf8',
);

export function orchestratorPrompt(ctx: {
  project: Project;
  session: Session;
  /** Absolute folder the orchestrator may write its plan artifact to. */
  scratchDir?: string;
}): string {
  const scratch = ctx.scratchDir ? `\nScratch folder: ${ctx.scratchDir}` : '';
  return `Project: ${ctx.project.name}\nDefault branch: ${ctx.project.defaultBranch}\nProject id: ${ctx.project.id}\nSession id: ${ctx.session.id}${scratch}\n\n${ORCHESTRATOR_PROMPT}`;
}
