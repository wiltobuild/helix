import { createProjector, type ProjectState } from '@helix/contracts';
import type { TimeAccounting } from './activeTime';
import { indexIdentities, withIdentityIndex } from './identity';

export type SafeProjection = { ok: true; state: ProjectState } | { ok: false; error: string };

/** No synthetic genesis or last-good state: neither can authorize actions on invalid history.
 * Strict projection also catches missing causal references that late backfill may repair.
 * Conflicting variants remain in the source; even a projectable representative is uncertain.
 */
export function createSafeProjector(timing: TimeAccounting): { at(seq: number): SafeProjection } {
  const conflict = timing.conflicts.length
    ? `Conflicting event identities #${timing.conflicts.join(', #')}. `
    : '';
  const failure = (error: unknown): SafeProjection => ({
    ok: false,
    error: conflict + (error instanceof Error ? error.message : 'History validation failed'),
  });
  try {
    const projector = createProjector(timing.events, { strict: true });
    const identities = indexIdentities(timing.events);
    return {
      at(seq) {
        try {
          if (conflict) return failure(new Error('No authoritative projection can be selected.'));
          return { ok: true, state: withIdentityIndex(projector.at(seq), identities) };
        } catch (error) {
          return failure(error);
        }
      },
    };
  } catch (error) {
    const result = failure(error);
    return { at: () => result };
  }
}
