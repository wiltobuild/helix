import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { RedactedStdioTransport } from './mcp-transport.js';
import { createReadOnlyMcpServer } from './mcp.js';
import { parseMcpConfiguration, syntheticMcpOptions } from './mcp-config.js';

// Only this executable opens stdio. Importing the read core has no side effects.
try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--mock', '--stdio'].includes(args[0] ?? ''))
    throw new Error('invalid_configuration');
  const mode = args[0] === '--mock' ? 'synthetic' : 'configured-loopback';
  const options =
    mode === 'synthetic'
      ? syntheticMcpOptions()
      : parseMcpConfiguration(process.env.HELIX_DOT_CONFIG);
  serveStdio(() => createReadOnlyMcpServer(options, mode), {
    transport: new RedactedStdioTransport(process.stdin, process.stdout, { maxBufferSize: 16384 }),
    onerror: () => {
      process.stderr.write('mcp_transport_error\n');
      process.exitCode = 1;
      process.stdin.destroy();
    },
  });
} catch {
  process.stderr.write('invalid_configuration\n');
  process.exitCode = 1;
}
