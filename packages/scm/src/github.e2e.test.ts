import { expect, test } from 'vitest';
import {
  projectSchema,
  pullRequestNumberSchema,
  type PullRequestFacts,
  type Unsubscribe,
} from '@helix/contracts';
import { createGitHubScm } from './index.js';
import { resolveGitHubToken } from './auth.js';

test.runIf(process.env.HELIX_E2E === '1')(
  'read-only public closed PR facts',
  async () => {
    const token = await resolveGitHubToken();
    const owner = process.env.HELIX_E2E_OWNER ?? 'cli';
    const repo = process.env.HELIX_E2E_REPO ?? 'cli';
    let number = Number(process.env.HELIX_E2E_PR);
    if (!Number.isSafeInteger(number) || number < 1) {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=closed&per_page=1`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(15_000),
        },
      );
      expect(response.ok).toBe(true);
      const rows = (await response.json()) as { number: number }[];
      number = rows[0]!.number;
    }
    const project = projectSchema.parse({
      id: 'smoke',
      name: 'Smoke',
      repoPath: '.',
      defaultBranch: 'main',
      github: { owner, repo },
      defaultAgent: 'codex',
      createdAt: '2026-01-01T00:00:00Z',
    });
    let stop: Unsubscribe | undefined;
    try {
      const facts = await new Promise<PullRequestFacts>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out reading public PR facts')),
          45_000,
        );
        const scm = createGitHubScm({
          token,
          onError: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        stop = scm.watch(project, pullRequestNumberSchema.parse(number), (event) => {
          if (event.type === 'pr.updated') {
            clearTimeout(timeout);
            resolve(event.payload.pr);
          }
        });
      });
      expect(['closed', 'merged']).toContain(facts.state);
      expect(facts.number).toBe(number);
    } finally {
      stop?.();
    }
  },
  60_000,
);
