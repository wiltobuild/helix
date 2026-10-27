# @helix/cli

The Helix command-line interface used by orchestrator agents. A pure HTTP client,
depending only on contracts and the typed API client.

Run from this workspace (use `pnpm.cmd` in Windows PowerShell):

```sh
pnpm --filter @helix/cli helix status
pnpm --filter @helix/cli helix status --json
pnpm --filter @helix/cli helix project add /absolute/path/to/repo
pnpm --filter @helix/cli helix task "Implement feature" --agent codex --prompt "Add the feature" --project project_id
pnpm --filter @helix/cli helix send session_id "Fix the edge case" --interrupt
pnpm --filter @helix/cli helix plan submit /absolute/path/to/plan.json
pnpm --filter @helix/cli helix plan show plan_id
pnpm --filter @helix/cli helix plan show plan_id --json
pnpm --filter @helix/cli helix explain "This worker unblocks the UI" --node node_id
pnpm --filter @helix/cli helix explain "A session-level note" --session session_id
```

Environment variables:

| Variable           | Purpose                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `HELIX_URL`        | Daemon HTTP(S) URL; overrides discovery from `run.json`.                                 |
| `HELIX_DATA_DIR`   | Discovery directory containing `run.json`; defaults to `~/.helix`.                       |
| `HELIX_SESSION_ID` | Default session for `explain`, and fallback `orchestratorSessionId` for plan submission. |
| `HELIX_PROJECT_ID` | Fallback `projectId` for plan submission.                                                |

Paths resolve against the invoking directory (`INIT_CWD` when launched by pnpm).
Task selection prefers the registered project containing that directory, then the
sole registered project. Otherwise supply `--project <id>`. Agent and prompt are
required. Each task submission generates an Idempotency-Key; send defaults to
queue and `--interrupt` selects interrupt.

`plan submit` reads the `SubmitPlanRequest` JSON shape (`projectId`,
`orchestratorSessionId`, `goal`, `nodes`). Omitted ids use the environment; explicit
values take precedence and invalid explicit values are rejected. Each node needs
`id`, `title`, `description`, `acceptance`, `files`, `dependsOn`, `agent`, and
`rationale`. Use non-empty repository-relative file globs and an acyclic dependency
graph. The CLI validates the schema and rejects empty file claims before daemon
discovery, printing each problem with its JSON path, for example:

```text
nodes[1].files: must not be empty
```

Architecture rules prohibit CLI imports from core, so parallel file-overlap
validation stays in the daemon. Order overlapping tasks with `dependsOn` or give
files one owner. A live orchestrator session must already exist; the minimal
`task` command creates workers. Successful submission waits for human approval
in Helix before workers start. The orchestrator must stop after submitting and
must never approve its own plan.

`status` and `plan show` replay every page of project history using the contracts
projector. `plan show` searches registered projects by plan id and prints the goal,
approval status, and each task's id, title, agent, dependencies, file claims, and
derived node status. `--json` returns the full `PlanState`, including `status` and
`nodeStatus`. An unknown plan returns `NOT_FOUND` with exit 2. The CLI never stores
status. `explain` accepts an optional `--node`; `--session` overrides
`HELIX_SESSION_ID`, and missing session configuration is an explicit error.

Human output is the default. `--json` prints one JSON value to stdout on success
and an `{error: {code, message}}` value to stderr on failure (multiple validation
problems are newline-separated inside `message`). When scripting with pnpm, add
`--silent` before `--filter` to suppress pnpm's command banner.
Exit codes: 0 success, 1 usage/configuration/local validation, 2 API/transport
failure; errors include the contract ErrorCode (transport failures use
INTERNAL_ERROR).

The self-contained real orchestrator smoke test lives in
`apps/daemon/src/orchestrator-real.e2e.test.ts`. With Codex installed and signed in,
run `pnpm test:e2e --filter=@helix/daemon`. It is gated only by `HELIX_E2E=1`,
creates its own temporary git repository and daemon, verifies plan submission
through the per-session CLI launcher and the approval gate, then stops the
orchestrator. Diagnostic artifacts are retained and their path is printed.

Exports: `runCli(args: string[], options?: CliOptions): Promise<0 | 1 | 2>` and
`resolveBaseUrl(env: NodeJS.ProcessEnv): Promise<string>`. Options allow an injected
typed client, environment, working directory and output sinks.
