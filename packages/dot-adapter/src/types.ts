export type Scope = { projectId: string; sessionId: string };
export type Tool = 'connectionstatus' | 'getjourney' | 'getevents' | 'getdiff';
export type ReadRequest = {
  method: 'GET';
  path: string;
  signal: AbortSignal;
  maxBytes: number;
};
/** Trusted transport boundary: must stream, honor abort, and enforce maxBytes. */
export type GetTransport = (request: ReadRequest) => Promise<string>;
export type Provenance = Scope & {
  instance: string;
  instanceVerified: false;
  revision: string | null;
  cursor: number;
  timestamp: string;
  sourceTimestamp: string | null;
  stale: boolean;
  partial: boolean;
  untrustedContent: true;
};
export type Failure =
  'invalid_request' | 'disconnected' | 'timeout' | 'cancelled' | 'oversize' | 'invalid_response';
export type Result<T = unknown> =
  | { ok: true; data: T; provenance: Provenance }
  | { ok: false; error: Failure; provenance: Provenance };
export type Event = {
  seq: number;
  ts: string;
  projectId: string;
  sessionId?: string;
  type: string;
  payload: Record<string, unknown>;
};
export type Evidence = {
  seq: number;
  stage: 'discovery' | 'design' | 'execution' | 'handoff';
  claim: string;
  assurance: 'recorded' | 'generated' | 'verified' | 'accepted';
};
export type Journey = {
  executionState: string;
  stages: Record<Evidence['stage'], Evidence[]>;
  decisionNeeded: string[];
  blockers: string[];
  limits: string[];
};
