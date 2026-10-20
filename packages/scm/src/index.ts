export const PACKAGE_NAME = '@helix/scm';
export { createGitHubScm, type GitHubScmOptions } from './github.js';
export { buildFeedbackMessage } from './feedback.js';
export {
  normalizeChecks,
  normalizeReviews,
  normalizeMergeable,
  type GitHubCheck,
  type GitHubStatus,
  type GitHubReview,
} from './normalize.js';
