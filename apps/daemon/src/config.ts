/**
 * Optional Codex overrides from the environment: HELIX_CODEX_MODEL (e.g. gpt-6.1-sol) and
 * HELIX_CODEX_EFFORT (low|medium|high|xhigh|max). Unset means Codex's own configured default.
 */
export function codexOverrides(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  const model = env.HELIX_CODEX_MODEL?.trim();
  const effort = env.HELIX_CODEX_EFFORT?.trim();
  if (model) {
    if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error('HELIX_CODEX_MODEL is not a model id');
    args.push('-c', `model=${model}`);
  }
  if (effort) {
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
      throw new Error('HELIX_CODEX_EFFORT must be low, medium, high, xhigh or max');
    args.push('-c', `model_reasoning_effort=${effort}`);
  }
  return args;
}

/** Optional #9 limits from HELIX_MAX_TURNS and HELIX_MAX_WORKERS (positive integers). */
export function limitsFromEnv(env: NodeJS.ProcessEnv): {
  maxTurnsPerTask?: number;
  maxParallelWorkers?: number;
} {
  const read = (name: string) => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const maxTurnsPerTask = read('HELIX_MAX_TURNS');
  const maxParallelWorkers = read('HELIX_MAX_WORKERS');
  return {
    ...(maxTurnsPerTask ? { maxTurnsPerTask } : {}),
    ...(maxParallelWorkers ? { maxParallelWorkers } : {}),
  };
}

/**
 * Approval policy. By default Helix answers routine requests itself: Claude Code edits inside its
 * worktree (as Codex already may), read-only commands there, and the project's own scripts.
 * HELIX_AUTO_APPROVE=off sends every request to the user.
 */
export function approvalPolicyFromEnv(env: NodeJS.ProcessEnv): {
  autoApproveSafeCommands: boolean;
  claudePermissionMode: 'manual' | 'acceptEdits';
} {
  const raw = env.HELIX_AUTO_APPROVE?.trim().toLowerCase();
  if (raw && raw !== 'on' && raw !== 'off') throw new Error('HELIX_AUTO_APPROVE must be on or off');
  const on = raw !== 'off';
  return { autoApproveSafeCommands: on, claudePermissionMode: on ? 'acceptEdits' : 'manual' };
}

export function crossReviewFromEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HELIX_REVIEWER?.trim().toLowerCase();
  if (raw && raw !== 'on' && raw !== 'off') throw new Error('HELIX_REVIEWER must be on or off');
  return raw !== 'off';
}
