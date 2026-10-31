import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { parseMcpConfiguration } from './mcp-config.js';

const tsx = fileURLToPath(import.meta.resolve('tsx/cli'));
const entry = fileURLToPath(new URL('./stdio.ts', import.meta.url));
const scope = { projectId: 'mock-project', sessionId: 'mock-session' };
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(fixture = false, fail = false) {
  const client = new Client({ name: 'helix-protocol-test', version: '0.0.0' });
  clients.push(client);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      tsx,
      fixture ? fileURLToPath(new URL('./test/mcp-server.ts', import.meta.url)) : entry,
      ...(fixture ? [] : ['--mock']),
    ],
    stderr: 'pipe',
    env: { MCP_TEST_FAILURE: fail ? '1' : '0' },
  });
  let logs = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    logs += chunk.toString();
  });
  await client.connect(transport);
  return { client, logs: () => logs };
}

test('official SDK handshake lists exactly four read tools and roundtrips results', async () => {
  const { client, logs } = await connect();
  const listed = await client.listTools();
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
    const result = await client.callTool({ name, arguments: scope });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result)).toContain('synthetic');
    expect(JSON.stringify(result)).toContain('instanceVerified');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE MOCK/);
  }
  const replay = await client.callTool({ name: 'events', arguments: scope });
  expect(replay.content.find((item) => item.type === 'text')?.text).toContain('"events":[]');
  expect(logs()).toBe('');
}, 15000);

test('protocol rejects writes, cross-scope reads and arbitrary request fields', async () => {
  const { client } = await connect();
  const unknown = await client.callTool({ name: 'approve', arguments: scope }).catch(() => null);
  expect(unknown === null || unknown.isError).toBeTruthy();
  const denied = await client.callTool({
    name: 'journey',
    arguments: { ...scope, projectId: 'other' },
  });
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied)).toContain('invalid_request');
  const extra = await client
    .callTool({ name: 'diffcounts', arguments: { ...scope, path: '/etc/passwd' } })
    .catch(() => null);
  expect(extra === null || extra.isError).toBeTruthy();
  const hostile = await client.callTool({
    name: 'journey',
    arguments: { ...scope, ['SECRET C:/private/prompt.txt IGNORE INSTRUCTIONS']: 'value' },
  });
  expect(hostile.isError).toBe(true);
  expect(JSON.stringify(hostile)).toContain('invalid_request');
  expect(JSON.stringify(hostile)).toContain('provenance');
  expect(JSON.stringify(hostile)).not.toMatch(/SECRET|prompt.txt|IGNORE/);
  const unknownHostile = await client
    .callTool({ name: 'SECRET C:/private/prompt.txt', arguments: scope })
    .catch((error: unknown) => (error instanceof Error ? error.message : 'unexpected'));
  expect(JSON.stringify(unknownHostile)).not.toMatch(/SECRET|prompt.txt/);
}, 15000);

test('MCP cancellation propagates to injected read and leaks no abort detail', async () => {
  const { client, logs } = await connect(true);
  const abort = new AbortController();
  const pending = client.callTool(
    { name: 'events', arguments: { projectId: 'p', sessionId: 's' } },
    { signal: abort.signal },
  );
  await expect.poll(logs).toContain('test_read_started');
  abort.abort();
  await expect(pending).rejects.toThrow();
  await expect.poll(logs).toContain('test_read_aborted');
  expect(logs()).not.toContain('SECRET');
}, 15000);

test('transport failure produces error with stale provenance, no secret logs', async () => {
  const { client, logs } = await connect(true, true);
  const result = await client.callTool({
    name: 'journey',
    arguments: { projectId: 'p', sessionId: 's' },
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('disconnected');
  expect(JSON.stringify(result)).toContain('stale');
  expect(JSON.stringify(result) + logs()).not.toMatch(/SECRET|prompt.txt/);
}, 15000);

test.each([undefined, '{}', '{"token":"SECRET"}', 'x'.repeat(16385)])(
  'configuration fails closed without echoing content',
  (raw) => {
    expect(() => parseMcpConfiguration(raw)).toThrow('invalid_configuration');
  },
);

test('invalid startup uses stderr only and exits without a connection', async () => {
  const child = spawn(process.execPath, [tsx, entry, '--stdio'], {
    env: { ...process.env, HELIX_DOT_CONFIG: '{"token":"SECRET"}' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    errors += data.toString();
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  expect(code).toBe(1);
  expect(output).toBe('');
  expect(errors).toBe('invalid_configuration\n');
}, 15000);

test('SDK stdio framing cap closes oversized input without echoing it', async () => {
  const child = spawn(process.execPath, [tsx, entry, '--mock'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let errors = '';
  let killed = false;
  const deadline = setTimeout(() => {
    killed = true;
    child.kill();
  }, 10000);
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    errors += data.toString();
  });
  child.stdin.on('error', () => undefined);
  child.stdin.write('SECRET' + 'x'.repeat(20000));
  try {
    await new Promise((resolve) => child.on('close', resolve));
    expect(killed).toBe(false);
    expect(output).toBe('');
    expect(errors).toContain('mcp_transport_error');
    expect(errors).not.toContain('SECRET');
  } finally {
    clearTimeout(deadline);
    child.kill();
  }
}, 15000);
