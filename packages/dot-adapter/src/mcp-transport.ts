import { isJSONRPCErrorResponse } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/** Keep SDK error codes and correlation IDs, never its echoed request/error details. */
export class RedactedStdioTransport extends StdioServerTransport {
  override send(message: Parameters<StdioServerTransport['send']>[0]): Promise<void> {
    if (isJSONRPCErrorResponse(message)) {
      return super.send({
        ...message,
        error: { code: message.error.code, message: 'mcp_request_error' },
      });
    }
    return super.send(message);
  }
}
