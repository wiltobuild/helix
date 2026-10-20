import { createHash } from 'node:crypto';
import path from 'node:path';
import { HelixError, type Project } from '@helix/contracts';

export function validate<T>(
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: { message: string } };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HelixError('INVALID_REQUEST', result.error.message);
  return result.data;
}

export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, canonical(x)]),
      );
    return v;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)) ?? 'undefined')
    .digest('hex');
}

export function repoPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function githubRemote(remote: string | undefined): Project['github'] {
  if (!remote) return undefined;
  const text = remote.trim();
  const scp = /^(?:git@)?github\.com:([^/]+)\/([^/]+?)\/?$/i.exec(text);
  let owner: string | undefined;
  let repo: string | undefined;
  if (scp) [, owner, repo] = scp;
  else {
    try {
      const url = new URL(text);
      if (
        !['https:', 'http:', 'ssh:'].includes(url.protocol) ||
        url.hostname.toLowerCase() !== 'github.com'
      )
        return undefined;
      const parts = url.pathname.replace(/^\/|\/$/g, '').split('/');
      if (parts.length !== 2) return undefined;
      [owner, repo] = parts;
    } catch {
      return undefined;
    }
  }
  repo = repo?.replace(/\.git$/i, '');
  return owner && repo ? { owner, repo } : undefined;
}

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'task'
  );
}
