export { createEventStore, openStore } from './store.js';
export type { OpenStoreOptions, RecordingInfo, StorageStore } from './store.js';
export {
  EventValidationError,
  IdempotencyConflictError,
  ProjectConflictError,
  RecordingValidationError,
  StorageError,
} from './errors.js';
