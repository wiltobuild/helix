import type { SessionId } from '@helix/contracts';

export interface HarnessOptions {
  bin?: string;
  /** Arguments before the adapter's arguments (also useful for executable wrappers). */
  extraArgs?: string[];
  env?: Record<string, string>;
  /** Dedicated restricted roles may replace rather than inherit the daemon environment. */
  inheritEnv?: boolean;
  /** Default for detection; HarnessStartOptions.cwd takes precedence for sessions. */
  cwd?: string;
  requestTimeoutMs?: number;
  /** Receives diagnostics; request timeouts include up to 4096 bytes of child stderr. */
  log?: (message: string) => void;
  /** CONTRACT-REQUEST: HarnessEmission should support explain.note directly. */
  note?: (sessionId: SessionId, message: string) => void;
  /** Protocol logs are written here only when HELIX_DEBUG_PROTOCOL=1. */
  dataDir?: string;
  claudePermissionMode?:
    'manual' | 'acceptEdits' | 'dontAsk' | 'plan' | 'auto' | 'bypassPermissions';
  /** Approve read-only and project-script commands without asking (see safe-commands.ts). */
  autoApproveSafeCommands?: boolean;
  /** Dedicated text-only discovery: disable configured external tools and shell access. */
  codexTextOnly?: boolean;
  codexApprovalPolicy?: 'on-request' | 'never';
  codexSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}
