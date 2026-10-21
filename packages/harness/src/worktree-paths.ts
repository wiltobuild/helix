import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Resolve existing ancestors too: a symlink/junction inside cwd may lead outside it. */
function physicalPath(filename: string): string {
  try {
    lstatSync(filename); // A dangling link must fail closed, not become a missing leaf.
    return realpathSync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      if (lstatSync(filename).isSymbolicLink()) throw new Error('Dangling link');
    } catch (second) {
      if ((second as NodeJS.ErrnoException).code !== 'ENOENT') throw second;
    }
    const parent = path.dirname(filename);
    if (parent === filename) throw error;
    return path.join(physicalPath(parent), path.basename(filename));
  }
}

export function insideWorktree(cwd: string, paths: string[]): boolean {
  if (!paths.length) return false;
  try {
    const root = realpathSync(cwd);
    return paths.every((entry) => {
      if (!entry || entry.includes('\0')) return false;
      // Win32 alternate streams/device paths and foreign-platform paths fail closed.
      if (process.platform !== 'win32' && (path.win32.isAbsolute(entry) || entry.includes('\\')))
        return false;
      if (
        process.platform === 'win32' &&
        (entry.startsWith('\\\\') || entry.slice(2).includes(':'))
      )
        return false;
      const target = path.resolve(cwd, entry);
      const relative = path.relative(root, physicalPath(target));
      return (
        relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    });
  } catch {
    return false;
  }
}
