/** Fit the whole graph, including review nodes, without forcing it past either edge. */
export function fitGraph(width: number, height: number, graphWidth: number, graphHeight: number) {
  if (width <= 0 || height <= 0 || graphWidth <= 0 || graphHeight <= 0) return 1;
  return Math.min(width / graphWidth, height / graphHeight, 1);
}

export function zoomGraph(scale: number, factor: number) {
  return Math.min(2, Math.max(0.1, scale * factor));
}

/** Keep attention on blocked or active work before moving to the next queued task. */
export function workingGroupIndex(
  groups: readonly { active: boolean; statuses: readonly string[] }[],
) {
  const needs = groups.findIndex((group) =>
    group.statuses.some((status) => status === 'needs_you' || status === 'ci_failed'),
  );
  if (needs >= 0) return needs;
  const active = groups.findIndex((group) => group.active);
  if (active >= 0) return active;
  const queued = groups.findIndex((group) =>
    group.statuses.some((status) => status === 'pending' || status === 'queued'),
  );
  return queued >= 0 ? queued : Math.max(0, groups.length - 1);
}
