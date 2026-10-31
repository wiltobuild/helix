# Read-only MCP stdio wrapper

This is a local MCP server implementation, not an installed Dot connector. The
official TypeScript SDK owns negotiation, framing, tool discovery, validation and
cancellation. The wrapper exposes only `connectionstatus`, `journey`, `events` and
`diffcounts`, calling the existing read core. All tools declare read-only hints;
the core's enforced route and scope allowlists are the actual permission boundary.

## Installation

The issue's original scope explicitly excluded an SDK. The later user request
authorizes implementing the MCP wrapper, but no issue text was published or edited.
The authorized follow-up adds these exact package pins and the generated workspace
lockfile entries. The coordinator retains final integration and publication:

```json
{
  "dependencies": {
    "@modelcontextprotocol/server": "2.3.1",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "2.3.1"
  }
}
```

The package includes `mcp:stdio`, `mcp:mock` and `mcp:proof` scripts. From a fresh
checkout with Node 24 and the repository's pnpm 10.34.7, install using
`pnpm install --frozen-lockfile`. For adapter-only verification with no install
scripts, use `pnpm --filter helix --filter @helix/dot-adapter install --frozen-lockfile --ignore-scripts`.
SDK 2.3.1 is the supported v2 line, published October 5, 2026; version 2.4.0 was
only eight days old at selection and did not meet this repository's 14-day rule.
Zod 4.6.5 matches the repository's established pin. The dependency integration was
checked in a clean temporary source snapshot using a frozen filtered install of
root tools and this package, with lifecycle scripts disabled. That verification
does not rely on the earlier temporary npm installation or dependency junctions.
The workspace override `@modelcontextprotocol/client@2.3.1>jose: 6.2.12` selects
the September 5 release within the client's supported `^6.1.3` range. Without it,
pnpm selected 6.2.14 (October 29), younger than the repository's 14-day policy.
The override applies only to this newly added client dependency edge. Official
registry publication dates were checked for every new locked package; all final
selections exceed 14 days. No existing package pin changed.

## Synthetic local proof

After installation, from the repository root:

```sh
pnpm --filter @helix/dot-adapter mcp:proof
```

The proof launches `stdio.ts --mock` as a child through the official SDK client,
negotiates MCP, lists the four tools, calls each with mock IDs and closes the child.
It never contacts Helix. Every tool result carries `mode: "synthetic"` and the
captured proof banner explicitly says there is no live Helix or Dot connection.
See `mcp-proof-output.txt` for the captured exchange summary.

Protocol tests are included in the package's focused Vitest suite. The server's
stdout is exclusively MCP traffic; diagnostics use fixed codes on stderr. No input
payloads, transport error details, tokens or local prompt paths are logged.
Invalid tool arguments become a fail-closed core error with provenance instead of
an SDK validation message that echoes input. JSON-RPC errors retain their protocol
code and correlation ID but replace message/details with a fixed code. Event
timestamps must be bounded UTC ISO datetimes, preventing permissive date parsing
from returning arbitrary text in metadata.

## Operator configuration for a future local host

The executable requires one explicit mode: `--mock` or `--stdio`. Real read mode
requires `HELIX_DOT_CONFIG`, a JSON object supplied by the operator, for example:

```json
{
  "instance": "local-helix",
  "allow": [{ "projectId": "approved-project-id", "sessionId": "approved-session-id" }],
  "port": 4317
}
```

There is no default project/session grant. Unknown configuration keys, malformed
IDs, missing configuration and configuration above 16 KiB fail closed without
echoing the content. The only network origin supported by real read mode is
`http://127.0.0.1:<port>`. The server accepts no URL, path, shell, approval, plan,
merge, deployment or grant argument. Configuring a different port does not confer
permission to bypass a denied read.

A compatible local MCP host would launch the absolute Node executable with the
installed tsx CLI, this package's absolute `src/stdio.ts` path, and `--stdio`, and
supply the scoped environment above. This document does not install that host
configuration. Starting the executable alone waits on stdin; it is not proof of
an MCP client connection. A live tool call is needed to verify actual read access.

Input framing is capped at 16 KiB by the SDK transport. Tool result text is capped
at 512 KiB; the existing 256 KiB default upstream allowance, event/page limits and
three-second deadline still apply. MCP cancellation is forwarded into the core.
The SDK closes stdio on EOF and aborts outstanding requests. There is no watcher,
public listener, credential storage, background polling or persistent capture.

## Hosted Dot remains a separate connection step

Hosted Dot does not consume local Codex MCP configuration. A local stdio exchange
therefore proves protocol compatibility, not connectivity from hosted Dot. The
official Secure MCP Tunnel can forward a local stdio server, but account/workspace
eligibility and permission remain unverified. Its setup involves OpenAI Platform
tunnel permissions, a target workspace and permission to add a custom MCP server.
No tunnel, key, credential, grant, connector registration or persistent access was
created here. Those steps require explicit operator authorization and account setup.

The earlier read to `http://127.0.0.1:4317/api/health` was denied socket access.
This work did not retry it, switch ports, use a different route or bypass that
denial. Live Helix access and a real Dot tool call remain unverified.

Official references consulted:

- [TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [Stdio serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html)
- [Cancellation](https://ts.sdk.modelcontextprotocol.io/v2/servers/logging-progress-cancellation.html)
- [Stdio transport buffer limits](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/stdio.html)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
