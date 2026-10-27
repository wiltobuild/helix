import { describe, expect, it } from 'vitest';
import { projectSchema, type Project } from '@helix/contracts';
import { redact, sanitizeForExport } from './redact.js';

describe('redaction', () => {
  const baseProject: Project = projectSchema.parse({
    id: 'p_123',
    name: 'test-project',
    repoPath: '/Users/developer/repos/secret-project',
    defaultBranch: 'main',
    defaultAgent: 'codex',
    createdAt: '2026-10-01T00:00:00.000Z',
  });

  it('redacts absolute repo paths and usernames in macOS, Linux and Windows paths', () => {
    const input = {
      pathUnix: '/Users/developer/repos/secret-project/src/index.ts',
      pathLinux: '/home/ubuntu/repos/secret-project/README.md',
      pathWin: 'C:\\Users\\admin\\repos\\secret-project\\config.json',
      msg: 'Checked out in /Users/developer/repos/secret-project',
    };

    const result = redact(input, { repoPath: baseProject.repoPath });

    expect(result.value.pathUnix).toBe('<repo>/src/index.ts');
    expect(result.value.pathLinux).toBe('/home/<user>/repos/secret-project/README.md');
    expect(result.value.pathWin).toBe('C:\\Users\\<user>\\repos\\secret-project\\config.json');
    expect(result.value.msg).toBe('Checked out in <repo>');
    expect(result.redactions).toContain('path:repo');
    expect(result.redactions).toContain('username');
  });

  it('redacts tokens from hostile URLs, headers and error messages', () => {
    const hostile = {
      remoteUrl: 'https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/org/repo.git',
      authHeader:
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature',
      fineGrained: 'Using github_pat_11AABCDEF0123456789abcdef0123456789abcdef0123456789 for push',
      openai: 'OpenAI returned 401 with sk-proj-123456789012345678901234567890',
      anthropic: 'Anthropic client initialized with sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
    };

    const result = redact(hostile);

    expect(result.value.remoteUrl).toBe('https://<token>@github.com/org/repo.git');
    expect(result.value.authHeader).toBe('Bearer <token>');
    expect(result.value.fineGrained).toBe('Using <token> for push');
    expect(result.value.openai).toBe('OpenAI returned 401 with <token>');
    expect(result.value.anthropic).toBe('Anthropic client initialized with <token>');
    expect(result.redactions).toContain('token');
  });

  it('redacts email addresses hostilely injected in commits or strings', () => {
    const payload = {
      author: 'Alice Developer <alice.smith+corp@engineering.example.co.uk>',
      committer: 'bob_99@sub.domain.org',
      nested: ['Contact support@github.com or security-team@internal.net'],
    };

    const result = redact(payload);

    expect(result.value.author).toBe('Alice Developer <<email>>');
    expect(result.value.committer).toBe('<email>');
    expect(result.value.nested[0]).toBe('Contact <email> or <email>');
    expect(result.redactions).toContain('email');
  });

  it('handles clean inputs without triggering false-positive redactions', () => {
    const clean = {
      title: 'Fix issue with login form',
      filesChanged: 3,
      branch: 'helix/feature-login',
      isClean: true,
    };

    const result = redact(clean);
    expect(result.value).toEqual(clean);
    expect(result.redactions).toEqual([]);
  });

  it('sanitizes genesis project and event payloads identically for export', () => {
    const events = [
      {
        seq: 1,
        projectId: baseProject.id,
        type: 'project.added',
        ts: '2026-10-01T00:00:00.000Z',
        v: 1,
        payload: {
          project: { ...baseProject },
          token: 'ghp_secrettoken01234567890123456789012345',
        },
      },
      {
        seq: 2,
        projectId: baseProject.id,
        type: 'explain.note',
        ts: '2026-10-01T00:01:00.000Z',
        v: 1,
        payload: {
          text: 'Committed in /Users/developer/repos/secret-project by dev@example.com',
        },
      },
    ];

    const sanitized = sanitizeForExport(baseProject, events);

    expect(sanitized.project.repoPath).toBe('<repo>');
    const firstEvent = sanitized.events[0] as { payload: { project: Project; token: string } };
    expect(firstEvent.payload.project.repoPath).toBe('<repo>');
    expect(JSON.stringify(sanitized.project)).toBe(JSON.stringify(firstEvent.payload.project));
    expect(firstEvent.payload.token).toBe('<token>');

    const secondEvent = sanitized.events[1] as { payload: { text: string } };
    expect(secondEvent.payload.text).toBe('Committed in <repo> by <email>');
    expect(sanitized.redactions).toEqual(['email', 'path:repo', 'token']);
  });
});
