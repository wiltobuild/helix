import { HelixError, type PlanNode } from '@helix/contracts';

/** Conservative intersection of slash-separated repository-relative globs. */
export function globsMayOverlap(a: string, b: string): boolean {
  const left = a.toLowerCase().split('/');
  const right = b.toLowerCase().split('/');
  const memo = new Map<string, boolean>();
  function overlaps(i: number, j: number): boolean {
    const key = `${i}:${j}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const x = left[i];
    const y = right[j];
    let result: boolean;
    if (x === undefined) result = right.slice(j).every((s) => s === '**');
    else if (y === undefined) result = left.slice(i).every((s) => s === '**');
    else if (x === '**') result = overlaps(i + 1, j) || overlaps(i, j + 1);
    else if (y === '**') result = overlaps(i, j + 1) || overlaps(i + 1, j);
    else result = (x === y || /[*?[{]/.test(x + y)) && overlaps(i + 1, j + 1);
    memo.set(key, result);
    return result;
  }
  return overlaps(0, 0);
}

/** Graph integrity is validated by the submission schema before this runs. */
export function validateFileOwnership(nodes: PlanNode[]): string[] {
  const graph = new Map(nodes.map((node) => [node.id, node]));
  const ancestors = new Map<PlanNode['id'], Set<PlanNode['id']>>();
  function dependencies(node: PlanNode): Set<PlanNode['id']> {
    const cached = ancestors.get(node.id);
    if (cached) return cached;
    const result = new Set(node.dependsOn);
    for (const id of node.dependsOn)
      for (const ancestor of dependencies(graph.get(id)!)) result.add(ancestor);
    ancestors.set(node.id, result);
    return result;
  }
  const warnings: string[] = [];
  const conflicts: string[] = [];
  const mentionsInterface = (text: string) =>
    /\b(interface|contract|shared type|schema|api shape)s?\b/i.test(text);
  for (const [i, a] of nodes.entries()) {
    if (!a.files.length)
      throw new HelixError('INVALID_REQUEST', `Task "${a.id}" must declare non-empty files`);
    for (const b of nodes.slice(i + 1)) {
      const aDeps = dependencies(a);
      const bDeps = dependencies(b);
      if (aDeps.has(b.id) || bDeps.has(a.id)) continue;
      const pairs = a.files.flatMap((x) =>
        b.files.filter((y) => globsMayOverlap(x, y)).map((y) => `${x} ↔ ${y}`),
      );
      if (pairs.length)
        conflicts.push(
          `Parallel tasks "${a.id}" and "${b.id}" both claim files: ${pairs.join(', ')}`,
        );
      if (
        mentionsInterface(a.description) &&
        mentionsInterface(b.description) &&
        ![...aDeps].some((id) => bDeps.has(id))
      )
        warnings.push(
          `Parallel tasks "${a.id}" and "${b.id}" mention a shared interface without a common dependency. Add a contract task that both depend on.`,
        );
    }
  }
  if (conflicts.length) throw new HelixError('INVALID_REQUEST', conflicts.join('; '));
  return warnings;
}
