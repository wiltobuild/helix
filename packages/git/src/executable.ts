import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';

/** Resolve only native Git from absolute PATH entries outside the target checkout. */
export async function trustedGit(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const root = await realpath(cwd);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  for (const entry of (env[pathKey] ?? '').split(delimiter)) {
    const directory = entry.replace(/^"|"$/g, '');
    if (!isAbsolute(directory)) continue;
    for (const name of process.platform === 'win32' ? ['git.exe', 'git.com'] : ['git']) {
      try {
        const binary = await realpath(join(directory, name));
        const rel = relative(root, binary);
        if (!(isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))) continue;
        if (!(await stat(binary)).isFile()) continue;
        await access(binary, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return binary;
      } catch {
        /* Try the next trusted PATH entry. */
      }
    }
  }
  throw new Error('Native Git is unavailable outside the worker checkout');
}
