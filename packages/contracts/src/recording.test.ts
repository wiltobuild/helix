import { expect, it } from 'vitest';
import {
  fixtures,
  helixEventSchema,
  helixlogHeaderSchema,
  parseHelixlog,
  serializeHelixlog,
  type Helixlog,
} from './index.js';

const log: Helixlog = {
  header: helixlogHeaderSchema.parse({
    format: 'helixlog',
    version: 1,
    project: fixtures.passwordResetProject,
    recordedAt: '2026-10-01T09:40:00.000Z',
    redactions: ['Paths replaced with /demo placeholders'],
  }),
  events: [...fixtures.passwordResetRun],
};
it('round-trips the golden recording exactly and deterministically', () => {
  const text = serializeHelixlog(log);
  expect(text.split('\n')).toHaveLength(46);
  expect(parseHelixlog(text)).toEqual({ success: true, data: log });
  expect(serializeHelixlog(log)).toBe(text);
});
it('round-trips structured guardrails and project scheduling events in v1 recordings', () => {
  const events = [
    ['explain.note', { text: 'Limit', code: 'turn_limit_reached' }, fixtures.passwordResetIds.api],
    [
      'explain.note',
      { text: 'Extended', code: 'turn_limit_extended' },
      fixtures.passwordResetIds.api,
    ],
    ['plan.node_updated', { nodeId: fixtures.passwordResetIds.apiNode, waiting: 'worker_slot' }],
    ['scheduling.changed', { paused: true }],
    ['scheduling.changed', { paused: false }],
  ].map(([type, payload, sessionId], index) =>
    helixEventSchema.parse({
      v: 1,
      seq: 45 + index,
      ts: log.header.recordedAt,
      projectId: log.header.project.id,
      type,
      payload,
      ...(sessionId ? { sessionId } : {}),
    }),
  );
  const structured = { ...log, events: [...log.events, ...events] };
  expect(parseHelixlog(serializeHelixlog(structured))).toEqual({ success: true, data: structured });
});
it('accepts CRLF, a BOM, and no final newline', () => {
  expect(
    parseHelixlog('\uFEFF' + serializeHelixlog(log).trimEnd().replaceAll('\n', '\r\n')),
  ).toEqual({ success: true, data: log });
});
it.each(['', '{}\n', '{bad json}', JSON.stringify({ ...log.header, version: 2 })])(
  'reports invalid headers without throwing %#',
  (text) => {
    const result = parseHelixlog(text);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.line).toBe(1);
  },
);
it('reports the exact invalid event line', () => {
  const lines = serializeHelixlog(log).trimEnd().split('\n');
  lines[5] = '{bad';
  const result = parseHelixlog(lines.join('\n'));
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.line).toBe(6);
});
it('rejects blank interior lines, foreign projects, duplicate seq and missing genesis', () => {
  const lines = serializeHelixlog(log).trimEnd().split('\n');
  expect(parseHelixlog([lines[0], '', ...lines.slice(1)].join('\n')).success).toBe(false);
  expect(parseHelixlog([lines[0], lines[1], lines[1]].join('\n')).success).toBe(false);
  expect(parseHelixlog([lines[0], ...lines.slice(2)].join('\n')).success).toBe(false);
  const foreign = JSON.stringify({ ...log.events[1], projectId: 'foreign' });
  expect(parseHelixlog([lines[0], lines[1], foreign].join('\n')).success).toBe(false);
  expect(() => serializeHelixlog({ ...log, events: [] })).toThrow();
});
