import type { HelixCore } from '@helix/contracts';
import '@helix/core';

// INTEGRATION: Remove this temporary augmentation when the real factory is merged.
// The daemon brief assumes an options factory; the core brief describes injected CoreDeps.
declare module '@helix/core' {
  export function createHelixCore(options: { dataDir: string }): Promise<HelixCore>;
}
