import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { parseMcpConfiguration } from './mcp-config.js';
import { createReadOnlyMcpServer } from './mcp.js';
import type { GetTransport } from './types.js';
import { withReadyDeadline } from './test/readiness.js';

// Direct Node loader avoids the extra child/stdio relay created by the tsx CLI.
const loader = import.meta.resolve('tsx');
const entry = fileURLToPath(new URL('./stdio.ts', import.meta.url));
const scope = { projectId: 'mock-project', sessionId: 'mock-session' };
const stdioClient = new Client({ name: 'helix-protocol-test', version: '0.0.0' });
const stdioTransport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', loader, entry, '--mock'],
  stderr: 'pipe',
});
let logs = '';
stdioTransport.stderr?.on('data', (chunk: Buffer) => {
  logs += chunk.toString();
});
let invalidChild: ChildProcess | undefined;
let invalidStartup: { code: number | null; output: string; errors: string };
const cleanup: (() => Promise<void>)[] = [];

beforeAll(async () => {
  invalidChild = spawn(process.execPath, ['--import', loader, entry, '--stdio'], {
    env: { ...process.env, HELIX_DOT_CONFIG: '{"token":"SECRET"}' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let errors = '';
  invalidChild.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  invalidChild.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const invalidClosed = new Promise<{ code: number | null; output: string; errors: string }>(
    (resolve, reject) => {
      invalidChild?.once('error', reject);
      invalidChild?.once('close', (code) => resolve({ code, output, errors }));
    },
  );
  // Startup is a bounded setup phase; operation assertions retain their 15s budgets.
  // Reuse this initialized process instead of repeatedly cold-loading the SDK.
  try {
    const [, result] = await Promise.all([stdioClient.connect(stdioTransport), invalidClosed]);
    invalidStartup = result;
  } catch (error) {
    invalidChild.kill();
    await Promise.allSettled([invalidClosed, stdioClient.close()]);
    throw error;
  }
}, 60000);

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
afterAll(async () => {
  invalidChild?.kill();
  await stdioClient.close();
});

async function memoryClient(transport: GetTransport, log: (code: string) => void) {
  const server = createReadOnlyMcpServer(
    { instance: 'test', allow: [{ projectId: 'p', sessionId: 's' }], transport, log },
    'synthetic',
  );
  const client = new Client({ name: 'helix-memory-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('official SDK handshake lists exactly four read tools and roundtrips results', async () => {
  const listed = await stdioClient.listTools();
  expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
    'connectionstatus',
    'diffcounts',
    'events',
    'journey',
  ]);
  expect(
    listed.tools.every(
      (tool) =>
        tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false,
    ),
  ).toBe(true);
  for (const name of ['connectionstatus', 'journey', 'events', 'diffcounts']) {
    const result = await stdioClient.callTool({ name, arguments: scope });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result)).toContain('synthetic');
    expect(JSON.stringify(result)).toContain('instanceVerified');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE MOCK/);
  }
  const replay = await stdioClient.callTool({ name: 'events', arguments: scope });
  expect(replay.content.find((item) => item.type === 'text')?.text).toContain('"events":[]');
  expect(logs).toBe('');
}, 15000);

test('protocol rejects writes, cross-scope reads and arbitrary request fields', async () => {
  const unknown = await stdioClient
    .callTool({ name: 'approve', arguments: scope })
    .catch(() => null);
  expect(unknown === null || unknown.isError).toBeTruthy();
  const denied = await stdioClient.callTool({
    name: 'journey',
    arguments: { ...scope, projectId: 'other' },
  });
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied)).toContain('invalid_request');
  const extra = await stdioClient
    .callTool({ name: 'diffcounts', arguments: { ...scope, path: '/etc/passwd' } })
    .catch(() => null);
  expect(extra === null || extra.isError).toBeTruthy();
  const hostile = await stdioClient.callTool({
    name: 'journey',
    arguments: { ...scope, ['SECRET C:/private/prompt.txt IGNORE INSTRUCTIONS']: 'value' },
  });
  expect(hostile.isError).toBe(true);
  expect(JSON.stringify(hostile)).toContain('invalid_request');
  expect(JSON.stringify(hostile)).toContain('provenance');
  expect(JSON.stringify(hostile)).not.toMatch(/SECRET|prompt.txt|IGNORE/);
  const unknownHostile = await stdioClient
    .callTool({ name: 'SECRET C:/private/prompt.txt', arguments: scope })
    .catch((error: unknown) => (error instanceof Error ? error.message : 'unexpected'));
  expect(JSON.stringify(unknownHostile)).not.toMatch(/SECRET|prompt.txt/);
}, 15000);

test('MCP cancellation propagates to injected read and leaks no abort detail', async () => {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const codes: string[] = [];
  const client = await memoryClient(
    ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted.resolve();
            reject(new Error('SECRET_ABORT'));
          },
          { once: true },
        );
        started.resolve();
      }),
    (code) => codes.push(code),
  );
  const abort = new AbortController();
  const pending = client.callTool(
    { name: 'events', arguments: { projectId: 'p', sessionId: 's' } },
    { signal: abort.signal },
  );
  const rejected = expect(pending).rejects.toThrow();
  await started.promise;
  abort.abort();
  await rejected;
  await aborted.promise;
  expect(codes.join()).not.toContain('SECRET');
}, 15000);

test('transport failure produces error with stale provenance, no secret logs', async () => {
  const codes: string[] = [];
  const client = await memoryClient(
    () => Promise.reject(new Error('SECRET C:/private/prompt.txt')),
    (code) => codes.push(code),
  );
  const result = await client.callTool({
    name: 'journey',
    arguments: { projectId: 'p', sessionId: 's' },
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('disconnected');
  expect(JSON.stringify(result)).toContain('stale');
  expect(JSON.stringify(result) + codes.join()).not.toMatch(/SECRET|prompt.txt/);
}, 15000);

test.each([undefined, '{}', '{"token":"SECRET"}', 'x'.repeat(16385)])(
  'configuration fails closed without echoing content',
  (raw) => {
    expect(() => parseMcpConfiguration(raw)).toThrow('invalid_configuration');
  },
);

test('invalid startup uses stderr only and exits without a connection', () => {
  expect(invalidStartup.code).toBe(1);
  expect(invalidStartup.output).toBe('');
  expect(invalidStartup.errors).toBe('invalid_configuration\n');
}, 15000);

// Last: this deliberately closes the reused, already-handshaken stdio connection.
test('SDK stdio framing cap closes oversized input without echoing it', async () => {
  const closed = Promise.withResolvers<void>();
  const previousClose = stdioClient.onclose;
  stdioClient.onclose = () => {
    previousClose?.();
    closed.resolve();
  };
  const messages: unknown[] = [];
  const previousMessage = stdioTransport.onmessage;
  stdioTransport.onmessage = (message) => {
    messages.push(message);
    previousMessage?.(message);
  };
  let killed = false;
  await withReadyDeadline(
    Promise.resolve(stdioClient),
    async (client) => {
      const result = client
        .callTool({
          name: 'journey',
          arguments: { ...scope, padding: 'SECRET' + 'x'.repeat(20000) },
        })
        .catch((error: unknown) => error);
      await closed.promise;
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('SECRET');
      expect(messages).toEqual([]);
      expect(killed).toBe(false);
      expect(logs).toContain('mcp_transport_error');
      expect(logs).not.toContain('SECRET');
    },
    () => {
      killed = true;
      void stdioClient.close();
    },
    10000,
  );
}, 15000);
