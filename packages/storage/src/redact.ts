import type { Project } from '@helix/contracts';

export interface RedactionOptions {
  repoPath?: string;
  extraPaths?: string[];
  username?: string;
}

export interface RedactionResult<T> {
  value: T;
  redactions: string[];
}

// Token matchers for common API keys, personal access tokens, and bearer credentials
const TOKEN_PATTERNS = [
  // GitHub Personal Access Tokens (classic and fine-grained)
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  // OpenAI API Keys
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // Anthropic API Keys
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  // Bearer tokens in headers or logs
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  // JSON Web Tokens (JWT)
  /\bey[A-Za-z0-9-_=]+\.ey[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]+\b/g,
];

// Email address matcher
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Filesystem username patterns across platforms (/Users/<name>, /home/<name>, C:\Users\<name>)
const UNIX_USER_PATTERN = /(?<=\/(?:Users|home)\/)[A-Za-z0-9._-]+(?=[/\\]|$)/g;
const WIN_USER_PATTERN = /(?<=[A-Za-z]:[/\\]+Users[/\\]+)[A-Za-z0-9._-]+(?=[/\\]|$)/g;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPlaceholderPath(path: string | undefined): boolean {
  if (!path) return true;
  return path.startsWith('/demo/') || path.startsWith('<repo>') || path === '/demo';
}

/**
 * Redacts absolute local paths, usernames in paths, secret tokens, and email addresses.
 * Returns the sanitized structure and a sorted array of distinct redaction tags.
 */
export function redact<T>(input: T, options: RedactionOptions = {}): RedactionResult<T> {
  const triggered = new Set<string>();

  const shouldRedactRepo = options.repoPath && !isPlaceholderPath(options.repoPath);
  const repoPath = shouldRedactRepo ? options.repoPath?.replace(/[/\\]+$/, '') : undefined;
  const repoRegex = repoPath ? new RegExp(escapeRegex(repoPath), 'g') : undefined;

  function redactString(text: string): string {
    let result = text;

    // 1. Redact project repo path to '<repo>' if it's an actual local path
    if (repoRegex && repoRegex.test(result)) {
      result = result.replace(repoRegex, '<repo>');
      triggered.add('path:repo');
    }

    // 2. Redact extra absolute paths if provided
    if (options.extraPaths) {
      for (const extra of options.extraPaths) {
        const clean = extra.replace(/[/\\]+$/, '');
        if (!clean || isPlaceholderPath(clean)) continue;
        const reg = new RegExp(escapeRegex(clean), 'g');
        if (reg.test(result)) {
          result = result.replace(reg, '<repo>');
          triggered.add('path:repo');
        }
      }
    }

    // 3. Redact explicit username if specified
    if (options.username && options.username.length > 1) {
      const userReg = new RegExp(`\\b${escapeRegex(options.username)}\\b`, 'g');
      if (userReg.test(result)) {
        result = result.replace(userReg, '<user>');
        triggered.add('username');
      }
    }

    // 4. Redact usernames occurring in path contexts (/Users/<name>, /home/<name>, C:\Users\<name>)
    if (UNIX_USER_PATTERN.test(result)) {
      result = result.replace(UNIX_USER_PATTERN, '<user>');
      triggered.add('username');
    }
    if (WIN_USER_PATTERN.test(result)) {
      result = result.replace(WIN_USER_PATTERN, '<user>');
      triggered.add('username');
    }

    // 5. Redact secret tokens
    for (const pattern of TOKEN_PATTERNS) {
      if (pattern.test(result)) {
        result = result.replace(pattern, (match) => {
          if (match.startsWith('Bearer ')) return 'Bearer <token>';
          return '<token>';
        });
        triggered.add('token');
      }
    }

    // 6. Redact email addresses
    if (EMAIL_PATTERN.test(result)) {
      result = result.replace(EMAIL_PATTERN, '<email>');
      triggered.add('email');
    }

    return result;
  }

  function walk(value: unknown): unknown {
    if (typeof value === 'string') {
      return redactString(value);
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  }

  const redactedValue = walk(input) as T;
  return {
    value: redactedValue,
    redactions: Array.from(triggered).sort(),
  };
}

/**
 * Prepares project genesis and events for export by redacting sensitive data.
 * Ensures that header.project and the first event (project.added) remain strictly identical.
 */
export function sanitizeForExport(
  genesisProject: Project,
  events: unknown[],
): { project: Project; events: unknown[]; redactions: string[] } {
  const isDemo = isPlaceholderPath(genesisProject.repoPath);
  const result = redact({ project: genesisProject, events }, { repoPath: genesisProject.repoPath });
  const sanitized = result.value as { project: Project; events: unknown[] };

  if (!isDemo) {
    sanitized.project.repoPath = '<repo>';
    if (
      sanitized.events.length > 0 &&
      typeof sanitized.events[0] === 'object' &&
      sanitized.events[0] !== null &&
      'payload' in sanitized.events[0]
    ) {
      const payload = (sanitized.events[0] as { payload?: { project?: Project } }).payload;
      if (payload?.project) {
        payload.project.repoPath = '<repo>';
      }
    }
  }

  return {
    project: sanitized.project,
    events: sanitized.events,
    redactions: result.redactions,
  };
}
