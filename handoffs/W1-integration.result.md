Implemented without commits. `pnpm check` exits 0: **427 package tests + 20 tooling tests passed**. The default end-to-end flow passes, and daemon boot, health, and Codex detection were verified.

```powershell
pnpm.cmd --filter @helix/daemon start
pnpm.cmd --silent --filter @helix/cli helix status --json
```

The real Codex variant requires authentication; this environment reports Codex signed out.

[Result handoff and full commands](C:/Users/Wil/Documents/Projects/helix-wt/w1-int/handoffs/W1-integration.result.md)

Automatic approval review rejected temporary smoke-directory cleanup as “blocked by policy.” The daemon is stopped; that directory remains.