import type { BoardColumn, SessionCardProps } from '@helix/ui';

/** Example board for the design-system gallery. Mirrors the "Add password reset" golden run. */
export const boardSample: { id: string; column: BoardColumn; card: SessionCardProps }[] = [
  {
    id: 'e2e',
    column: 'pending',
    card: {
      title: 'E2E tests for the password reset flow',
      agent: 'claude-code',
      status: 'pending',
      statusLabel: 'Waiting on 2 tasks',
      branch: 'helix/reset-e2e',
      updated: '41m',
    },
  },
  {
    id: 'api',
    column: 'working',
    card: {
      title: 'Reset-token API with 15-minute expiry',
      agent: 'codex',
      status: 'working',
      statusLabel: 'Fixing token expiry',
      branch: 'helix/reset-api',
      pr: { number: 12 },
      checks: { passed: 18, total: 19 },
      updated: '2m',
    },
  },
  {
    id: 'docs',
    column: 'working',
    card: {
      title: 'Document the reset endpoints in the API reference',
      agent: 'claude-code',
      status: 'working',
      statusLabel: 'Editing docs/api.md',
      branch: 'helix/reset-docs',
      updated: 'now',
    },
  },
  {
    id: 'ui',
    column: 'needs_you',
    card: {
      title: 'Reset form UI and email template',
      agent: 'claude-code',
      status: 'needs_you',
      statusLabel: 'Approve migration?',
      branch: 'helix/reset-ui',
      pr: { number: 13 },
      updated: '1m',
    },
  },
  {
    id: 'rate',
    column: 'in_review',
    card: {
      title: 'Rate-limit reset requests per email',
      agent: 'codex',
      status: 'ci_failed',
      statusLabel: 'CI failed · lint',
      branch: 'helix/reset-rate-limit',
      pr: { number: 14, comments: 2 },
      checks: { passed: 11, total: 12 },
      updated: '6m',
    },
  },
  {
    id: 'copy',
    column: 'in_review',
    card: {
      title: 'Update login copy for the reset link',
      agent: 'claude-code',
      status: 'in_review',
      statusLabel: 'Awaiting review',
      branch: 'helix/reset-copy',
      pr: { number: 11, comments: 1 },
      checks: { passed: 12, total: 12 },
      updated: '18m',
    },
  },
  {
    id: 'audit',
    column: 'ready_to_merge',
    card: {
      title: 'Audit log entry when a password changes',
      agent: 'codex',
      status: 'ready_to_merge',
      branch: 'helix/reset-audit',
      pr: { number: 10 },
      checks: { passed: 19, total: 19 },
      updated: '24m',
    },
  },
];
