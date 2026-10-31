import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createReadOnlyMcpServer } from '../mcp.js';

// Test-only child: never contacts Helix. A fixed marker confirms cancellation reached I/O.
serveStdio(() =>
  createReadOnlyMcpServer(
    {
      instance: 'test',
      allow: [{ projectId: 'p', sessionId: 's' }],
      timeoutMs: 5000,
      transport: ({ signal }) => {
        if (process.env.MCP_TEST_FAILURE === '1')
          return Promise.reject(new Error('SECRET C:\\private\\prompt.txt'));
        return new Promise((_, reject) => {
          process.stderr.write('test_read_started\n');
          signal.addEventListener(
            'abort',
            () => {
              process.stderr.write('test_read_aborted\n');
              reject(new Error('SECRET_ABORT'));
            },
            { once: true },
          );
        });
      },
    },
    'synthetic',
  ),
);
