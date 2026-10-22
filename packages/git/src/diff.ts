import { HelixError, type DiffFile } from '@helix/contracts';

/** NUL-delimited Git records preserve tabs, newlines and Unicode in filenames. */
export function parseDiffFiles(raw: string, numstat: string): DiffFile[] {
  const stats = new Map<string, Pick<DiffFile, 'insertions' | 'deletions' | 'binary'>>();
  const counts = numstat.split('\0');
  for (let i = 0; i < counts.length; i++) {
    const record = counts[i];
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(record);
    if (!match) throw new HelixError('INTERNAL_ERROR', 'Malformed Git numstat output.');
    let path = match[3]!;
    if (!path) {
      i++;
      path = counts[++i]!;
    }
    stats.set(path, {
      insertions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
      binary: match[1] === '-',
    });
  }
  const records = raw.split('\0');
  const files: DiffFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const header = records[i];
    if (!header) continue;
    const status = header.trim().split(/\s+/).at(-1)?.[0];
    const first = records[++i]!;
    const renamed = status === 'R' || status === 'C';
    const path = renamed ? records[++i]! : first;
    const stat = stats.get(path);
    if (!stat) throw new HelixError('INTERNAL_ERROR', 'Missing Git diff statistics.', { path });
    files.push({
      path,
      ...(renamed ? { oldPath: first } : {}),
      status:
        status === 'A'
          ? 'added'
          : status === 'D'
            ? 'deleted'
            : status === 'R'
              ? 'renamed'
              : status === 'C'
                ? 'copied'
                : 'modified',
      ...stat,
    });
  }
  return files;
}
