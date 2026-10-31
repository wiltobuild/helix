import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { createDotAdapter } from './index.js';
import type { AdapterOptions } from './index.js';
import type { Result, Tool } from './types.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const scope = z.strictObject({ projectId: id, sessionId: id });
const events = scope.extend({
  cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
const definitions = [
  [
    'connectionstatus',
    'connectionstatus',
    'Read configured Helix health. Does not attest instance identity or session existence.',
  ],
  [
    'journey',
    'getjourney',
    'Read bounded journey evidence and current scoped intake/design. Preserve stale, partial and acceptance labels.',
  ],
  [
    'events',
    'getevents',
    'Read bounded session event metadata with a resumable cursor. Global sequence gaps are normal.',
  ],
  [
    'diffcounts',
    'getdiff',
    'Read workspace diff file count only. No paths or raw diff content; changes are not verified or accepted.',
  ],
] as const satisfies readonly (readonly [string, Tool, string])[];

/** One scoped adapter per MCP connection; no HTTP listener, registration or grants. */
export function createReadOnlyMcpServer(
  options: AdapterOptions,
  mode: 'synthetic' | 'configured-loopback',
) {
  const adapter = createDotAdapter(options);
  const server = new McpServer({ name: 'helix-readonly', version: '0.0.0' });
  for (const [name, operation, description] of definitions) {
    server.registerTool(
      name,
      {
        description,
        // Preserve the advertised strict schema, but convert SDK validation failures
        // to a fail-closed sentinel so raw Zod messages never echo hostile input keys.
        inputSchema: (name === 'events' ? events : scope).catch({ projectId: '', sessionId: '' }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: name !== 'events',
          openWorldHint: false,
        },
      },
      async (args, context) => {
        let result: Result = await adapter.invoke(operation, args, context.mcpReq.signal);
        let text = JSON.stringify({ mode, ...result });
        if (Buffer.byteLength(text, 'utf8') > 524288) {
          result = {
            ok: false,
            error: 'oversize',
            provenance: { ...result.provenance, stale: true, partial: true },
          };
          text = JSON.stringify({ mode, ...result });
        }
        return { isError: !result.ok, content: [{ type: 'text' as const, text }] };
      },
    );
  }
  return server;
}
