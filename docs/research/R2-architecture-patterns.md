**R2 — Multi-agent orchestration architecture, verified 20 October 2026**

**Recommendation — INFERRED:** Build an orchestrator.inc-style product around a persistent task scheduler, agent adapters, isolated workspaces, and a review loop. Use an LLM supervisor to propose and revise plans; let explicit dependencies, permissions, budgets, and lifecycle rules govern execution.

The surveyed systems address three distinct concerns: coordinating agents, recovering execution, and isolating code. Combining them deliberately matters more than choosing one “multi-agent framework.”

**Framework comparison**

| System | Coordination and decomposition | State, recovery, approvals, and practical limits |
|---|---|---|
| **OpenAI Agents SDK** | Manager-style agents-as-tools retain central control; handoffs transfer the active conversation to a specialist. Application code can orchestrate parallel runs. | Sessions maintain conversation history; resumable run state supports approval interruptions; streaming exposes agent activity. These primitives do not alone establish durable recovery of external processes. [Official runtime documentation](https://developers.openai.com/api/docs/guides/agents/running-agents), [handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/), [approvals](https://openai.github.io/openai-agents-python/human_in_the_loop/). |
| **Claude Agent SDK / Claude Code** | A parent delegates focused tasks to subagents with separate contexts, prompts, tools, and models; concurrent subagents return results to the parent. | SDK definitions support delegation controls and resumption. Claude Code offers permission modes, persistent subagent memory, foreground/background execution, and optional `isolation: worktree`. Separate context does not automatically mean separate filesystem. [SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents), [Code subagents](https://code.claude.com/docs/en/sub-agents). |
| **LangGraph** | Explicit state graphs support routing, parallel branches, loops, and orchestrator–worker decomposition through dynamic `Send` operations. It is broader than a DAG because cycles are supported. | Checkpointers retain thread execution state; stores hold cross-thread memory. Interrupts pause for human input; node retry policies distinguish transient failures from repair loops. [Patterns](https://docs.langchain.com/oss/python/langgraph/workflows-agents), [persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [error handling](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph). |
| **CrewAI** | Crews organize role-based agents into sequential or hierarchical processes; a manager delegates and validates. Flows supply explicit event-driven routing around crews. | Structured flow state and `@persist` support restoration, with SQLite as the default persistence backend. Asynchronous human-feedback state can be saved and resumed. Persistence should not be assumed to make arbitrary external side effects exactly-once. [Processes](https://docs.crewai.com/en/concepts/processes), [Flows](https://docs.crewai.com/en/concepts/flows), [feedback persistence implementation](https://github.com/crewAIInc/crewAI/blob/main/lib/crewai/src/crewai/flow/persistence/sqlite.py). |
| **Microsoft AutoGen** | Selector/round-robin teams centralize speaker selection; Swarm uses local handoff decisions over shared message context. Swarm turns are sequential, despite the multi-agent terminology. | Agent/team state can be saved and loaded; `run_stream` exposes messages and usage. Handoff termination can return control to a human. Saving state requires application persistence and is not itself a durable scheduler. [Swarm](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/swarm.html), [state](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html). |
| **AG2** | Current `ag2.network`/`WorkflowAdapter` documentation describes transition graphs, coordinator handoffs, pipelines, and feedback loops. AG2 Classic separately documents automatic, manual, round-robin, and explicit-handoff patterns. | Version distinctions matter: the current migration cookbook explicitly lists missing parallel dispatch in its redundant-worker pattern and gaps in nested orchestration. Do not infer current capabilities from Classic examples. [Current cookbook](https://docs.ag2.ai/docs/user-guide/network/pattern_cookbook/pattern_cookbook/), [Classic patterns](https://classic.docs.ag2.ai/0.14.1/docs/user-guide/advanced-concepts/orchestration/group-chat/patterns/). |
| **Mastra** | TypeScript workflows provide schema-checked steps, branching, parallel fan-out/fan-in, and bounded `foreach` concurrency; agents can supervise workflows. | Suspend/resume supports human input. Durable-agent behavior is configuration-dependent: default recovery settings do not persist every running step. Parallel blocks wait for all branches and fail if an uncaught branch error occurs. [Control flow](https://mastra.ai/docs/workflows/control-flow), [durable agents](https://mastra.ai/docs/harness/durable-agents), [approvals](https://mastra.ai/docs/agents/human-in-the-loop). |
| **Temporal-based runners** | A deterministic workflow coordinates agents, activities, and dependencies; model/tool operations execute outside deterministic workflow logic. | The OpenAI integration turns model calls into Activities and propagates tracing context. Persisted Activity results enable replay and recovery. The integration became GA in March 2026. **INFERRED:** retries still require idempotency or reconciliation for side effects such as creating PRs. [Integration](https://docs.temporal.io/develop/python/integrations/openai-agents), [GA announcement](https://temporal.io/blog/announcing-openai-agents-sdk-integration). |

**Coding-agent orchestrators and isolation**

These products primarily supervise existing coding harnesses and their workspaces:

- **Orchestrator.inc:** one worker associates a task, coding agent, branch/worktree, conversation or terminal, changes, preview, PR, and CI/review state. Its documented desktop architecture includes a local Go service and metadata under `~/.ao`. [Repository](https://github.com/OrchestratorInc/agent-orchestrator), [documentation](https://docs.orchestrator.inc/).
- **Conductor:** current public material advertises cloud microVMs with repositories/dependencies prepared, first-party coding agents, shared workspaces, and desktop/mobile/API control. Its current architecture should not be characterized solely from older local-worktree descriptions. [Product page](https://www.conductor.build/).
- **Vibe Kanban:** emphasizes issue/sub-issue decomposition, parallel sessions, code review, browser QA, and PR worktrees. [Product page](https://www.vibekanban.com/).
- **Sculptor:** each agent runs in a container; Pairing Mode synchronizes an agent’s changes with the local repository for testing and interactive editing. [Imbue announcement](https://imbue.com/blog/sculptor-announce).
- **Claude Squad / terminal multiplexers:** Claude Squad explicitly combines tmux sessions, Git worktrees, and a TUI, with review and resume controls. [Repository](https://github.com/smtg-ai/claude-squad).

**INFERRED:** Worktrees separate checkout contents and branches but leave host resources shared. They do not eliminate integration conflicts. Containers or microVMs add execution boundaries; ports, credentials, databases, and dependency caches still need explicit allocation policies.

**Streaming, accounting, and evaluation**

LangGraph streams tokens, state updates, custom progress, task events, and checkpoints with subgraph namespaces. AutoGen exposes streamed team events; Mastra emits suspension events and supports resuming streams. **INFERRED:** normalize these into a product event schema rather than coupling the UI to one provider’s transcript. Keep terminal byte streams separate from structured lifecycle events. [LangGraph streaming](https://docs.langchain.com/oss/python/langgraph/streaming), [Mastra approvals](https://mastra.ai/docs/agents/human-in-the-loop).

Claude’s accounting illustrates a critical adapter issue: result `usage` excludes subagents, while `modelUsage` and estimated `total_cost_usd` include them. Resumed-session totals can include earlier spending; summing them double-counts. [Cost documentation](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

OpenAI provides workflow/trace evaluation; Mastra provides dataset, judge, and experiment guidance. **INFERRED:** evaluate orchestrators on accepted-task rate, regression failures, human intervention, conflict frequency, recovery success, latency, and cost per accepted change—not merely agent-generated completion claims. [OpenAI evaluations](https://developers.openai.com/api/docs/guides/agent-evals), [Mastra guides](https://mastra.ai/docs/guides/overview).

**Recommended reference architecture — INFERRED**

| Component | Responsibility |
|---|---|
| **Desktop/web control surface** | Task board, dependency view, live chat/terminal, diff review, previews, approvals, cancellation. |
| **Planner and plan validator** | Produce bounded tasks with acceptance criteria, dependencies, expected files/interfaces, model choice, and budget. Validate before dispatch. |
| **Persistent scheduler** | Own lifecycle state, concurrency limits, leases, heartbeats, retries, cancellation, and dependency release. |
| **Agent adapters** | Normalize launch, attach, resume, interrupt, approval, streaming, and usage capabilities for Claude, Codex, and other harnesses. |
| **Workspace service** | Allocate branch/worktree plus optional container/microVM; assign ports, credentials, base revision, and cleanup policy. |
| **State and event store** | Store task state, append-only events, approval decisions, usage ledger, artifact references, and session IDs. Keep transcripts separate from curated shared knowledge. |
| **Verification and integration service** | Run tests and independent review; associate results with commit hashes; route fixes to owners; serialize conflicting merges. |

**Data flow:** request → planner → validated dependency graph → scheduler → workspace/adapter → streamed events and artifacts → tests/review → scoped approval → merge. CI failures reopen the owning task with evidence and a bounded repair budget.

Start a local MVP with SQLite and a reconnectable daemon. Add Temporal when cloud workers, prolonged approvals, and crash recovery justify its operational cost. Use LangGraph or Mastra inside planning/review components if useful; avoid two competing owners of task lifecycle state.

A supervisor plus explicit dependencies offers predictable scheduling and auditability. Swarm handoffs suit exploratory specialist routing but make budgets and completion harder to govern. Local worktrees offer low overhead; microVMs improve remote isolation at higher infrastructure cost.

**Evidence limits:** No cited site blocked retrieval. Public pages did not establish complete retry, checkpoint, cost-ledger, or evaluation implementations for every coding-agent product; those capabilities remain unverified.