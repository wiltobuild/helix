import type { HelixClient } from '@helix/api-client';
import type { Project } from '@helix/contracts';

function repositoryIdentity(repoPath: string): string {
  // Windows accepts either separator and compares repository paths without case sensitivity.
  const windows = /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(repoPath);
  const normalized = windows ? repoPath.replaceAll('\\', '/').toLowerCase() : repoPath;
  return normalized.replace(/\/+$/, '');
}

/** Reconcile only the requested repository after a response is lost, including on retry. */
export async function addProject(
  client: Pick<HelixClient, 'projects' | 'createProject'>,
  repoPath: string,
): Promise<Project> {
  const identity = repositoryIdentity(repoPath);
  const findRequested = (projects: readonly Project[]) =>
    projects.find((project) => repositoryIdentity(project.repoPath) === identity);

  const existing = findRequested(await client.projects());
  if (existing) return existing;

  try {
    return await client.createProject({ repoPath });
  } catch (error) {
    const created = await client
      .projects()
      .then(findRequested)
      .catch(() => undefined);
    if (created) return created;
    throw error;
  }
}
