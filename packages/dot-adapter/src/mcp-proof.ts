import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

// Explicit offline proof executable: launches only the package's synthetic stdio server.
const client = new Client({ name: 'helix-synthetic-proof', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    fileURLToPath(import.meta.resolve('tsx/cli')),
    fileURLToPath(new URL('./stdio.ts', import.meta.url)),
    '--mock',
  ],
  stderr: 'pipe',
});
const deadline = setTimeout(() => {
  void client.close();
}, 10000);
try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log('SYNTHETIC MCP STDIO PROOF — no live Helix, Dot, tunnel or registration');
  console.log(
    JSON.stringify(
      {
        handshake: 'completed with official SDK client',
        tools: tools.tools.map(({ name, annotations }) => ({ name, annotations })),
      },
      null,
      2,
    ),
  );
  for (const name of ['connectionstatus', 'journey', 'events', 'diffcounts']) {
    const result = await client.callTool({
      name,
      arguments: { projectId: 'mock-project', sessionId: 'mock-session' },
    });
    if (result.isError) throw new Error('proof_failed');
    console.log(JSON.stringify({ tool: name, result }, null, 2));
  }
} catch {
  console.error('synthetic_proof_failed');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await client.close();
}
