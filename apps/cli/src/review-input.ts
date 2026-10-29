import { submitReviewRequestSchema, type SubmitReviewRequest } from '@helix/contracts';

export function parseReviewInput(
  review: unknown,
  env: NodeJS.ProcessEnv,
  headSha?: string,
): SubmitReviewRequest {
  const parsed = submitReviewRequestSchema.safeParse({
    reviewerSessionId: env.HELIX_SESSION_ID,
    headSha,
    review,
  });
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`)
        .join('\n'),
    );
  return parsed.data;
}
