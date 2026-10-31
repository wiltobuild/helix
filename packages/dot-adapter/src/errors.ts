import type { Failure } from './types.js';

export class ReadError extends Error {
  constructor(readonly code: Failure) {
    super(code);
  }
}
