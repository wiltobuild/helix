import { describe, expect, it } from 'vitest';
import { fitGraph, zoomGraph, workingGroupIndex, orchestratorBranches } from './graphViewport';

describe('pinned orchestrator connectors', () => {
  const root = { x: 500, y: 100 };
  const viewport = { left: 0, right: 1000, top: 108, bottom: 700 };
  it('shares one branch and attaches to actual visible agent heads', () => {
    expect(
      orchestratorBranches(root, viewport, [
        { x: 200, y: 140 },
        { x: 700, y: 140 },
      ]),
    ).toBe('M500 100 V120 M200 120 H700 M200 120 V140 M700 120 V140');
  });
  it('does not invent boundary endpoints for horizontally or vertically clipped workers', () => {
    expect(
      orchestratorBranches(root, viewport, [
        { x: -20, y: 140 },
        { x: 1200, y: 140 },
        { x: 200, y: 90 },
        { x: 200, y: 800 },
      ]),
    ).toBe('');
  });
  it('tracks pan/zoom anchors without moving the pinned root', () => {
    const before = orchestratorBranches(root, viewport, [{ x: 700, y: 140 }]);
    const after = orchestratorBranches(root, viewport, [{ x: 216, y: 128 }]);
    expect(before).toContain('M500 100');
    expect(after).toBe('M500 100 V114 M216 114 H500 M216 114 V128');
  });
});

describe('laptop graph fitting', () => {
  it('prioritizes blockers, then active work, then the next queued task', () => {
    const done = { active: false, statuses: ['merged'] };
    const active = { active: true, statuses: ['working'] };
    const queued = { active: false, statuses: ['pending'] };
    const blocked = { active: false, statuses: ['needs_you'] };
    expect(workingGroupIndex([done, active, queued, blocked])).toBe(3);
    expect(workingGroupIndex([done, active, queued])).toBe(1);
    expect(workingGroupIndex([done, done, queued])).toBe(2);
    expect(workingGroupIndex([done, done])).toBe(1);
  });
  it.each([
    [1366, 768, 760, 758],
    [1440, 900, 760, 758],
    [1366 - 196, 768 - 56 - 160 - 220 - 80, 760, 758],
    [1440 - 196 - 420, 900 - 56 - 160 - 400 - 80, 4000, 1300],
    [1366, 768, 8000, 1500],
  ])('keeps every edge within %ix%i for a %ix%i graph', (width, height, gw, gh) => {
    const scale = fitGraph(width - 32, height - 32, gw, gh);
    expect(gw * scale).toBeLessThanOrEqual(width - 32 + 0.001);
    expect(gh * scale).toBeLessThanOrEqual(height - 32 + 0.001);
    expect(scale).toBeLessThanOrEqual(1);
  });

  it('uses height even when width would permit full size', () => {
    expect(fitGraph(1200, 300, 760, 758)).toBeCloseTo(300 / 758);
  });

  it('refits after expanding or collapsing a panel', () => {
    const collapsed = fitGraph(1300, 680, 1000, 758);
    const expanded = fitGraph(1300, 280, 1000, 758);
    expect(expanded).toBeLessThan(collapsed);
    expect(758 * expanded).toBeCloseTo(280);
  });

  it('allows readable manual zoom while bounding repeated zoom operations', () => {
    expect(zoomGraph(1, 1.2)).toBe(1.2);
    expect(zoomGraph(1.9, 1.2)).toBe(2);
    expect(zoomGraph(0.1, 1 / 1.2)).toBe(0.1);
    expect(fitGraph(20, 20, 8000, 1500)).toBeLessThan(0.1);
  });
});
