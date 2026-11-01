import { describe, expect, it, vi } from 'vitest';
import { fixtures } from '@helix/contracts';
import { addProject } from './addProject';

const requestedPath = 'C:\\Users\\Wil\\code\\requested';
const requested = { ...fixtures.passwordResetProject, repoPath: requestedPath };
const unrelated = { ...fixtures.passwordResetProject, repoPath: 'C:\\Users\\Wil\\code\\other' };

describe('adding the requested repository', () => {
  it('preserves the real failure when only unrelated projects exist', async () => {
    const error = new Error('Install and sign in to Codex before adding a project');
    const client = {
      projects: vi.fn().mockResolvedValue([unrelated]),
      createProject: vi.fn().mockRejectedValue(error),
    };

    await expect(addProject(client, requestedPath)).rejects.toBe(error);
    expect(client.createProject).toHaveBeenCalledExactlyOnceWith({ repoPath: requestedPath });
  });

  it('recovers the exact requested project after a lost create response', async () => {
    const client = {
      projects: vi
        .fn()
        .mockResolvedValueOnce([unrelated])
        .mockResolvedValueOnce([unrelated, requested]),
      createProject: vi.fn().mockRejectedValue(new Error('Response dropped')),
    };

    await expect(addProject(client, requestedPath)).resolves.toBe(requested);
    expect(client.createProject).toHaveBeenCalledTimes(1);
  });

  it('selects the requested project on retry without creating it again', async () => {
    const client = {
      projects: vi.fn().mockResolvedValue([unrelated, requested]),
      createProject: vi.fn(),
    };

    await expect(addProject(client, 'c:/users/wil/code/requested/')).resolves.toBe(requested);
    expect(client.createProject).not.toHaveBeenCalled();
  });

  it('keeps distinct POSIX paths distinct', async () => {
    const client = {
      projects: vi.fn().mockResolvedValue([{ ...requested, repoPath: '/code/Requested' }]),
      createProject: vi.fn().mockResolvedValue({ ...requested, repoPath: '/code/requested' }),
    };

    await expect(addProject(client, '/code/requested')).resolves.toMatchObject({
      repoPath: '/code/requested',
    });
    expect(client.createProject).toHaveBeenCalledTimes(1);
  });

  it('preserves the create failure if reconciliation also fails', async () => {
    const error = new Error('Response dropped');
    const client = {
      projects: vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Offline')),
      createProject: vi.fn().mockRejectedValue(error),
    };

    await expect(addProject(client, requestedPath)).rejects.toBe(error);
  });

  it('does not risk duplicate creation when the retry lookup fails', async () => {
    const error = new Error('Offline');
    const client = {
      projects: vi.fn().mockRejectedValue(error),
      createProject: vi.fn(),
    };

    await expect(addProject(client, requestedPath)).rejects.toBe(error);
    expect(client.createProject).not.toHaveBeenCalled();
  });
});
