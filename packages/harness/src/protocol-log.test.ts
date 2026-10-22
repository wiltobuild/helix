import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { protocolLogger } from './protocol-log.js';

test('protocol log is opt-in, append-only, bidirectional, timestamped and redacts tokens', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'helix-protocol-'));
  const filename = path.join(dataDir, 'logs', 'session.protocol.jsonl');
  try {
    protocolLogger(
      { dataDir, env: { HELIX_DEBUG_PROTOCOL: '0' } },
      'session',
      vi.fn(),
    )('in', { id: 1 });
    expect(existsSync(filename)).toBe(false);
    const options = { dataDir, env: { HELIX_DEBUG_PROTOCOL: '1', PRIVATE_TOKEN: 'private-value' } };
    const write = protocolLogger(options, 'session', vi.fn());
    write('in', {
      id: 1,
      method: 'refresh',
      params: {
        accessToken: 'hidden',
        nested: { authorization: 'hidden' },
        text: 'Bearer hidden sk-secret-value private-value access_token=hidden {"accessToken":"hidden"} apiKey: \'hidden\'',
        answers: { credential: { answers: ['hidden'] } },
      },
    });
    protocolLogger(options, 'session', vi.fn())('out', { id: 1, result: { token: 'hidden' } });
    const text = readFileSync(filename, 'utf8');
    expect(text).not.toMatch(/hidden|sk-secret-value|private-value/);
    const frames = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { ts: string; direction: string; frame: { id: number } });
    expect(frames.map((row) => row.direction)).toEqual(['in', 'out']);
    expect(frames.map((row) => row.frame.id)).toEqual([1, 1]);
    expect(frames.every((row) => Number.isFinite(Date.parse(row.ts)))).toBe(true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
