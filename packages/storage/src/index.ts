export { createEventStore, openStore } from './store.js';
export type { OpenStoreOptions, RecordingInfo, StorageStore } from './store.js';
export { redact, sanitizeForExport } from './redact.js';
export type { RedactionOptions, RedactionResult } from './redact.js';
export {
  EventValidationError,
  IdempotencyConflictError,
  ProjectConflictError,
  RecordingValidationError,
  StorageError,
} from './errors.js';
