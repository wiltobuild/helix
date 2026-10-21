import type { SessionId } from '@helix/contracts';

export interface HarnessOptions {
  bin?: string;
  /** Arguments before the adapter's arguments (also useful for executable wrappers). */
  extraArgs?: string[];
  env?: Record<string, string>;
  /** Default for detection; HarnessStartOptions.cwd takes precedence for sessions. */
  cwd?: string;
  requestTimeoutMs?: number;
  /** Receives diagnostics, never raw stdout/stderr or tool contents. */
  log?: (message: string) => void;
  /** CONTRACT-REQUEST: HarnessEmission should support explain.note directly. */
  note?: (sessionId: SessionId, message: string) => void;
  /** Protocol logs are written here only when HELIX_DEBUG_PROTOCOL=1. */
  dataDir?: string;
  claudePermissionMode?:
    'manual' | 'acceptEdits' | 'dontAsk' | 'plan' | 'auto' | 'bypassPermissions';
  codexApprovalPolicy?: 'on-request' | 'never';
  codexSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}
