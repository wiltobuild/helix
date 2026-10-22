import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { HarnessOptions } from './options.js';

/** Preserve frame structure and IDs while stripping credential values, including embedded text. */
export function redactProtocol(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value
      .replace(/\bBearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]')
      .replace(
        /\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g,
        '[REDACTED]',
      )
      .replace(
        /((?:["']?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|password)["']?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
        '$1"[REDACTED]"',
      );
    for (const secret of secrets)
      if (secret.length >= 4) text = text.replaceAll(secret, '[REDACTED]');
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redactProtocol(item, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|authorization|api[_-]?key|password|secret|cookie|^answers$/i.test(key)
          ? '[REDACTED]'
          : redactProtocol(item, secrets),
      ]),
    );
  return value;
}

export function protocolLogger(
  options: HarnessOptions,
  sessionId: string,
  log: (text: string) => void,
) {
  const env = { ...process.env, ...options.env };
  if (env.HELIX_DEBUG_PROTOCOL !== '1' || !options.dataDir) return () => undefined;
  const filename = path.join(options.dataDir, 'logs', `${sessionId}.protocol.jsonl`);
  const secrets = Object.entries(env).flatMap(([key, value]) =>
    value && /token|api[_-]?key|password|secret/i.test(key) ? [value] : [],
  );
  let failed = false;
  return (direction: 'in' | 'out', frame: unknown): void => {
    try {
      mkdirSync(path.dirname(filename), { recursive: true });
      appendFileSync(
        filename,
        `${JSON.stringify({ ts: new Date().toISOString(), direction, frame: redactProtocol(frame, secrets) })}\n`,
        { mode: 0o600 },
      );
    } catch {
      if (!failed) log('Could not append protocol debug log');
      failed = true;
    }
  };
}
