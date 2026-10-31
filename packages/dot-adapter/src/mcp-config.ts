import { z } from 'zod/v4';
import { createLoopbackTransport } from './transport.js';
import type { AdapterOptions } from './index.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const schema = z.strictObject({
  instance: id,
  allow: z
    .array(z.strictObject({ projectId: id, sessionId: id }))
    .min(1)
    .max(100),
  port: z.number().int().min(1).max(65535).optional(),
});

/** Configuration is operator-supplied, never an MCP argument or repository file. */
export function parseMcpConfiguration(raw: string | undefined): AdapterOptions {
  try {
    if (!raw || Buffer.byteLength(raw, 'utf8') > 16384) throw new Error();
    const config = schema.parse(JSON.parse(raw) as unknown);
    return {
      instance: config.instance,
      allow: config.allow,
      transport: createLoopbackTransport(config.port),
    };
  } catch {
    throw new Error('invalid_configuration');
  }
}

export function syntheticMcpOptions(): AdapterOptions {
  const scope = { projectId: 'mock-project', sessionId: 'mock-session' };
  return {
    instance: 'synthetic-mcp',
    allow: [scope],
    now: () => Date.parse('2026-10-31T00:00:00Z'),
    transport: ({ path }) => {
      const payload =
        path === '/api/health'
          ? { status: 'ok', version: 'synthetic' }
          : path.endsWith('/intake')
            ? { draft: null }
            : path.endsWith('/design')
              ? { design: null }
              : path.includes('/diff?')
                ? { unifiedDiff: 'PRIVATE MOCK TEXT', files: [{ path: 'PRIVATE MOCK PATH' }] }
                : path.includes('since=0&')
                  ? {
                      events: [
                        {
                          ...scope,
                          seq: 7,
                          v: 1,
                          ts: '2026-10-31T00:00:00Z',
                          type: 'session.started',
                          payload: {},
                        },
                      ],
                      lastSeq: 7,
                    }
                  : { events: [], lastSeq: 7 };
      return Promise.resolve(JSON.stringify(payload));
    },
  };
}
