import type { ErrorCode } from './api.js';

/** Typed domain error. The daemon maps `code` to an HTTP status and the apiErrorSchema body. */
export class HelixError extends Error {
  override readonly name = 'HelixError';
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const isHelixError = (e: unknown): e is HelixError => e instanceof HelixError;
