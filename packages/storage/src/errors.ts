import { HelixError } from '@helix/contracts';

export class EventValidationError extends HelixError {
  constructor(
    readonly index: number,
    details: unknown,
  ) {
    super('INVALID_REQUEST', `Invalid event at batch index ${index}`, details);
  }
}

export class RecordingValidationError extends HelixError {
  constructor(message: string, details?: unknown) {
    super('INVALID_REQUEST', message, details);
  }
}

export class IdempotencyConflictError extends HelixError {
  constructor(scope: string, key: string) {
    super('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request', {
      scope,
      key,
    });
  }
}

export class ProjectConflictError extends HelixError {
  constructor(repoPath: string) {
    super('CONFLICT', 'Repository path is already registered to another project', { repoPath });
  }
}

export class StorageError extends HelixError {
  constructor(message: string, cause?: unknown) {
    super('INTERNAL_ERROR', message);
    this.cause = cause;
  }
}
