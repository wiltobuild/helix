import type { SetupResponse } from '@helix/contracts';
export const setupResponse: SetupResponse = {
  agents: {
    codex: {
      ok: true,
      detail: 'Installed and signed in',
      installed: true,
      signedIn: true,
      version: '1.0',
    },
    'claude-code': {
      ok: true,
      detail: 'Installed and signed in',
      installed: true,
      signedIn: true,
      version: '2.0',
    },
  },
  github: {
    ok: true,
    detail: 'GitHub token resolved',
    tokenResolved: true,
    status: 'on',
    login: 'demo',
  },
  tools: {
    git: { ok: true, detail: 'git version 2.50', version: 'git version 2.50' },
    node: { ok: true, detail: 'v24.0.0', version: 'v24.0.0' },
    pnpm: { ok: true, detail: '10.34.7', version: '10.34.7' },
  },
  config: {
    ok: true,
    detail: 'Effective daemon settings',
    reviewer: true,
    autoApprove: true,
    maxWorkers: 3,
    maxTurns: 20,
    codexModel: null,
    codexEffort: null,
  },
};
