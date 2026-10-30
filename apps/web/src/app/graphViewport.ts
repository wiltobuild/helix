/** Fit the whole graph, including review nodes, without forcing it past either edge. */
export function fitGraph(width: number, height: number, graphWidth: number, graphHeight: number) {
  if (width <= 0 || height <= 0 || graphWidth <= 0 || graphHeight <= 0) return 1;
  return Math.min(width / graphWidth, height / graphHeight, 1);
}

export function zoomGraph(scale: number, factor: number) {
  return Math.min(2, Math.max(0.1, scale * factor));
}

/** Connect only visible, recorded worker anchors; never substitute an edge-of-screen target. */
export function orchestratorBranches(
  root: { x: number; y: number },
  viewport: { left: number; right: number; top: number; bottom: number },
  workers: readonly { x: number; y: number }[],
) {
  const visible = workers.filter(
    ({ x, y }) =>
      x >= viewport.left &&
      x <= viewport.right &&
      y > viewport.top &&
      y < viewport.bottom &&
      y > root.y,
  );
  if (!visible.length) return '';
  const busY = root.y + (Math.min(...visible.map(({ y }) => y)) - root.y) / 2;
  const left = Math.min(root.x, ...visible.map(({ x }) => x));
  const right = Math.max(root.x, ...visible.map(({ x }) => x));
  return `M${root.x} ${root.y} V${busY} M${left} ${busY} H${right} ${visible.map(({ x, y }) => `M${x} ${busY} V${y}`).join(' ')}`;
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
