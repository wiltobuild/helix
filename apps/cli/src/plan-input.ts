import { submitPlanRequestSchema, type SubmitPlanRequest } from '@helix/contracts';

function jsonPath(path: readonly PropertyKey[]): string {
  return (
    path.reduce<string>(
      (result, part) =>
        typeof part === 'number'
          ? `${result}[${part}]`
          : `${result}${result ? '.' : ''}${String(part)}`,
      '',
    ) || '$'
  );
}

/** Validate before daemon discovery, preserving every actionable JSON path. */
export function parsePlanInput(input: unknown, env: NodeJS.ProcessEnv): SubmitPlanRequest {
  const candidate =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? {
          ...input,
          ...(!Object.hasOwn(input, 'projectId') ? { projectId: env.HELIX_PROJECT_ID } : {}),
          ...(!Object.hasOwn(input, 'orchestratorSessionId')
            ? { orchestratorSessionId: env.HELIX_SESSION_ID }
            : {}),
        }
      : input;
  const parsed = submitPlanRequestSchema.safeParse(candidate);
  const problems = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${jsonPath(issue.path)}: ${issue.message}`);
  // Persisted plans permit [] for legacy replay; new submissions must claim files.
  if (typeof candidate === 'object' && candidate !== null && 'nodes' in candidate) {
    if (Array.isArray(candidate.nodes))
      candidate.nodes.forEach((node: unknown, index) => {
        if (
          typeof node === 'object' &&
          node !== null &&
          'files' in node &&
          Array.isArray(node.files) &&
          node.files.length === 0
        )
          problems.push(`nodes[${index}].files: must not be empty`);
      });
  }
  // CLI -> core is forbidden by .dependency-cruiser.mjs. The daemon owns overlap checks.
  if (problems.length) throw new Error(problems.join('\n'));
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}
