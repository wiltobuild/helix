# @helix/cli

The helix command-line interface used by orchestrator agents.
A pure HTTP client, depending only on contracts and the typed API client.

Run from this workspace (use `pnpm.cmd` in Windows PowerShell):

```sh
pnpm --filter @helix/cli helix status
pnpm --filter @helix/cli helix status --json
pnpm --filter @helix/cli helix project add /absolute/path/to/repo
pnpm --filter @helix/cli helix task "Implement feature" --agent codex --prompt "Add the feature" --project project_id
pnpm --filter @helix/cli helix send session_id "Fix the edge case" --interrupt
pnpm --filter @helix/cli helix plan submit /absolute/path/to/plan.json
pnpm --filter @helix/cli helix explain "This worker unblocks the UI" --session session_id --node node_id
```

`HELIX_URL` overrides discovery from `<HELIX_DATA_DIR>/run.json`; the default
data directory is `~/.helix`. Paths resolve against the invoking directory
(`INIT_CWD` when launched by pnpm). Task selection prefers the registered project
containing that directory, then the sole registered project. Otherwise supply
`--project <id>`. Agent and prompt are required. Each task submission generates
an Idempotency-Key; send defaults to queue and `--interrupt` selects interrupt.

Status replays every page of project history and derives session status/column.
The CLI never stores status. Plans use the frozen `SubmitPlanRequest` JSON shape
(`projectId`, `orchestratorSessionId`, `goal`, `nodes`). A live orchestrator session
must already exist; the minimal task command creates workers.

Human output is the default. `--json` prints one JSON value to stdout on success
and an `{error: {code, message}}` value to stderr on failure. When scripting with
pnpm, add `--silent` before `--filter` to suppress pnpm's command banner.
Exit codes: 0 success, 1 usage/configuration, 2 API/transport failure; errors include
the contract ErrorCode (transport failures use INTERNAL_ERROR).

Exports: `runCli(args: string[], options?: CliOptions): Promise<0 | 1 | 2>` and
`resolveBaseUrl(env: NodeJS.ProcessEnv): Promise<string>`. Options allow an injected
typed client, environment, working directory and output sinks.
