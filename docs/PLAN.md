# Helix — Explainable Agent Orchestrator · Implementation Plan (v3)

> Product name: **Helix**. A local web app that runs Claude Code and Codex in parallel git worktrees,
> takes each task from prompt → PR → CI → a merge-ready PR that **you** merge, and — unlike [orchestrator.inc](https://orchestrator.inc/) —
> **records why**: a plan graph you approve before agents start, a timeline that replays the project's history,
> and a "why" panel whose every entry says where it came from.
>
> Team: 2 people · Demo: **~2 weeks** (Day 1 = Oct 20, 2026) · Then: portfolio polish, open-ended.
> Status (Oct 22): **Wave 0 and Wave 1 done** (PRs #1 and #2 open). A real Codex task has run end to end from the UI;
> the real GitHub PR → CI → fix loop has only run against a fake GitHub. **Wave 2 next.**
>
> v3 (Oct 22) folds in the Claude + Codex PRD critique: plan approval is P0, a narrow integration policy,
> P0 cut to the demo loop, labeled Why entries, "replay" not "rewind", security, spend guardrails,
> and Codex workers moved from `gpt-6-astra` to `gpt-6.1-sol` (effort high) to save usage.

---

## 1. Scope

| Tier | What | When |
|---|---|---|
| **B — Thin slice** (must) | Projects, board with derived status, session view (Chat; terminal is P1), Files/diff inspector, PR → CI → auto-fix loop, merge on a human click, Claude Code + Codex adapters | Week 1 ✅ |
| **D — Explainable orchestration** (must, the hook) | Orchestrator agent submits a structured plan → **plan graph you approve before anything runs** → live status; **timeline scrubber** that replays the whole UI's history (it does not restore files, branches or sessions); **Why panel** with labeled entries (stated in the plan · recorded by Helix · agent's own summary) | Week 2 |
| **Demo mode** (must) | Record real runs; replay them with nothing installed; hosted static demo link | Week 2 |
| **C — Bake-off** (stretch) | Same task → Claude and Codex in parallel worktrees → side-by-side compare (diff, tests, time, interventions) → merge winner | After demo |
| Polish (post-demo) | Animations, a11y audit, onboarding, more harnesses, case-study README with GIFs | After demo |

**Explicitly out:** 30+ harnesses, Cues, Automations, browser preview, mobile, cloud, Electron, TUI⇄Chat switching, cost tracking (spend is bounded by turn caps, a parallel-worker limit and stop-all instead), autonomous merging.

**P0 = the demo loop, nothing else:** add a project · approve a plan · start and watch tasks · answer an approval · see the diff · CI failure routed back and fixed · merge with a click · plan graph · timeline replay · Why panel · hosted replay. Everything else is P1 or below (see the PRD). Building is fast; **verifying** that these behaviors hold up together is the bottleneck, so test infrastructure is the top new priority.

**One idea makes D, demo mode, and C cheap:** everything is an **append-only event log**. The UI state is a pure function `project(events up to t)`. Live view = t is now. Timeline scrubber = drag t. Demo mode = load a recorded log. Bake-off comparison = two logs side by side.

---

## 2. Who does what

| Owner | Owns |
|---|---|
| **Codex** (`gpt-6.1-sol`, effort **high**, via handoffs; was `gpt-6-astra` until Oct 22 — switch back only for a brief that Sol fails twice) | Daemon, event store, harness adapters, PTY, git/worktrees, GitHub loop, orchestrator CLI + prompts, recorder, all backend tests |
| **Claude** | All UI/UX + design system; contracts; writing every Codex brief; reviewing/gating every Codex branch; integration |
| **You** | Product owner + human integrator: approve contracts, run the real-agent E2E on your machine, own the GitHub repo + PR merges, record the demo runs |
| **Teammate** (proposed — adjust) | **Demo & quality owner**: writes the demo script (Day 1), builds the sample "demo repo" the agents work on, owns the replay fixtures library, does manual QA each evening, makes the presentation. Optionally pairs on one UI screen (Why panel) to get hands-on code ownership |

> If your teammate wants more code ownership, the cleanest split is: teammate owns `apps/web/src/features/timeline` + `why-panel` under Claude's design system, Claude reviews.

---

## 3. Architecture

```
Browser (React app) ──HTTP/SSE──► helixd (Node daemon, 127.0.0.1:4317) ──► SQLite (~/.helix)
        ▲      └──WS /mux──► PTY host (node-pty/ConPTY)        │
        │                                                       ├─► harness adapters: claude-code, codex
  same React app, static,                                       ├─► git worktree manager
  fed a recorded event log  ◄── demo mode                       ├─► GitHub observer (gh token, ETag polling)
                                                                └─► `helix` CLI ← used by the orchestrator agent
```

| Decision | Choice |
|---|---|
| Language | TypeScript everywhere, Node 24, pnpm + Turborepo |
| Daemon | Fastify; serves the built web app at `localhost:4317`; loopback-only; Origin check |
| Storage | SQLite (better-sqlite3, WAL) + Drizzle; **`events` table is the source of truth**; read-model tables are projections |
| Live updates | SSE `/api/events?since=<seq>` (Last-Event-ID replay); WS only for terminals |
| Status | Never stored — `deriveStatus(facts)` pure function in contracts (shared by daemon and UI so replay works offline) |
| Harnesses | Claude Code (`-p --output-format stream-json`, resume by session id) and Codex (`codex app-server` JSON-RPC / `exec --json`) behind one `AgentHarness` interface |
| Orchestrator | A Claude Code (or Codex) session with a system prompt + the `helix` CLI: `helix plan submit plan.json`, `helix spawn`, `helix send`, `helix status`, `helix explain "<why>"`. A submitted plan waits for the user's **Approve** before any worker spawns |
| Integration policy | Each plan node declares the `files` it expects to touch; Helix rejects plans where parallel nodes overlap (serialize them, or give the file one owner). Shared interfaces get a **contract task** that merges first. Dependents start after prerequisites merge, from freshly fetched `origin/main`. After every merge, open PRs are re-checked and new conflicts routed back as merge-conflict fixes |
| Reasoning capture | Three labeled sources: **stated in the plan** (rationale from `plan submit`) · **recorded by Helix** (causedBy trigger chain, recorded when the code acts) · **agent's own summary** (harness reasoning summaries, unverified). Never shown as "what the agent was thinking" |
| Guardrails | Built: 3-attempt repair cap, stall watchdog, per-task Stop. Wave 2: turn cap per task, max parallel workers, "stop all agents" |
| Security | Built: loopback-only, Host check (DNS rebinding), Origin allowlist, `gh auth token` per call kept in memory and never logged, Codex workspace-write sandbox, only in-worktree file edits auto-approved, agent git writes refused. Open: no auth on the local port, no CSRF token beyond Origin, Claude Code worker permission mode undecided |
| Frontend | Vite + React 19, TanStack Query + Router, Zustand, Radix, Tailwind v4 w/ CSS-variable tokens, React Flow (plan graph, ELK layout), xterm.js, Shiki + diff view, cmdk, Motion |
| Hosting demo | Static build of the same app with `?demo=<recording>` → Vercel |
| Tests | Vitest; fake harness + fake GitHub; Playwright for UI incl. replay-determinism test |

### Core events (frozen in Wave 0)
`project.added` · `session.created/started/exited/archived` · `activity.changed` (active/idle/waiting/blocked) · `chat.message` · `chat.tool_call` · `chat.approval_requested/decided` · `reasoning.summary` · `plan.submitted` · `plan.node_updated` · `explain.note` · `worktree.created/diff_updated` · `pr.opened/updated` · `ci.updated` · `review.updated` · `agent_review.requested/submitted/abandoned` · `feedback.routed` · `pr.merged`
**Wave 2 contract additions (Claude, before briefs go out):** `plan.approved` (or a plan-specific approval type), per-node `files` in the plan schema, a plan-validation error for overlapping claims, a small key-value seam on `HelixStore`, recording ids + lookup.
Every event: `{seq, ts, projectId, sessionId?, planNodeId?, causedBy?: seq, type, payload}` — **`causedBy`** is what powers the Why panel ("this fix was caused by event #412 CI failure"). **`variantOf`** on sessions is reserved now so bake-off needs no migration later.

---

## 4. Schedule

### Day 1 — Wave 0, sequential ✅ (PR #1)
- **Codex W0-scaffold** — monorepo, lint/typecheck/test, CI (Windows + Linux), boundary lint.
- **Codex W0-contracts** — event types, entities, `deriveStatus` + board-column table tests, `AgentHarness`/`WorktreeManager`/`ScmObserver` interfaces, REST schemas, fixture format.
- **Claude** — reviews + freezes contracts; installs all deps; writes Wave 1 briefs; picks visual direction.
- **Teammate** — demo script v1 (the 3-minute story) + sample demo repo with a few real issues.
- **You** — create GitHub repo, approve contracts.

### Days 2–5 — Wave 1 (4 Codex agents in parallel) ✅ (PR #2, done Day 3 incl. 3 fix rounds)
| Agent | Brief | Done when |
|---|---|---|
| **A** events + daemon | SQLite event store, projections, SSE w/ replay, Fastify routes, serves web build | Route conformance + SSE reconnect tests green |
| **B** harnesses | Claude Code + Codex adapters: start, send, interrupt, resume, activity detection, reasoning summary extraction; fake harness | Contract tests on fakes; real smoke behind `HELIX_E2E=1` |
| **C** git + terminal | Worktree create/diff/safe-cleanup (never delete dirty), per-repo lock; PTY host + `/mux` WS (ConPTY) | Windows CI green; dirty-worktree test |
| **D** GitHub loop | PR facts via ETag polling, CI + review state, feedback routing (CI fail → message to owning session, deduped), merge | Fake-GitHub scenario: fail → fix → pass → merge |

**Claude in parallel:** design tokens + primitives, then Board, Session view, Diff inspector — all against a mock server driven by fixture event logs (no waiting on backend).
**End of Day 5 milestone:** one real task, end to end, in the UI: prompt → worker edits → PR → CI fails → auto-fix → green → merge.

### Days 4–10 — Wave 2 (3 Codex agents) + D in the UI
**First (Claude):** land the contract additions above, then write briefs E–G.

| Agent | Brief |
|---|---|
| **E** orchestrator | `helix` CLI; orchestrator system prompt; `plan submit` schema (nodes, deps, **files**, rationale, acceptance); **plan approval gate** (nothing spawns until `plan.approved`); reject overlapping file claims; contract-task pattern in the prompt; plan → spawn workers respecting deps; re-check open PRs after each merge; `explain` notes; escalation to "Needs you" |
| **F** recorder + replay | Export/import event logs (`.helixlog`), redaction of paths/tokens, deterministic replay API; demo build flag; **replay-determinism tests on recordings of real runs**, not hand-written fixtures |
| **G** hardening + guardrails | Daemon restart recovery (load leniently: one malformed stored event must not stop the daemon), process-tree kill on Windows (a `codex app-server` survived stopSession), error surfaces as events, Host/Origin rejection → 403, **turn cap per task, max parallel workers, stop-all**, integration test suite |

**Real GitHub loop (You + Claude, Days 4–6, highest priority):** a private test repo with a CI workflow built to fail on the first attempt. Run one real task through push → PR → failing check → `feedback.routed` → fix → green → merge-on-click, and check the causedBy links on the timeline. Fix whatever breaks before Wave 2 merges.

**Claude:** plan graph (React Flow + ELK, nodes animate with live status) with an **Approve plan** step, timeline scrubber (replays board + graph + chat together; Files tab labeled "current changes" or disabled while in the past), Why panel (three labeled sources → causal chain via `causedBy`), stop-all control, New-task dialog with "let the orchestrator plan it". Needs-you inbox drops to P1 (the board's Needs-you column covers the demo).
**Day 10 (Oct 29) milestone:** full demo script runs live and as a replay; **hosting decided** (done: static replay build on Vercel, https://helix-demo-theta.vercel.app).

**Shipped ahead of plan (Oct 29):** cross-agent reviewer (#49–#51): when a worker's PR passes CI, the other agent reviews it (Claude Code reviews Codex, Codex reviews Claude Code, never self-review); findings route back as feedback and a PR is ready to merge only after the review approves its latest head. `HELIX_REVIEWER=off` disables it. Also: Claude Code always orchestrates (#47); routine approvals are answered by Helix (`HELIX_AUTO_APPROVE`, #48, #52); every task starts from the fetched `origin/<default>` (#52).

### Days 11–14 — Demo prep
- Record 2–3 clean runs on the demo repo (you + teammate), each including a real CI failure fixed on GitHub; deploy hosted demo-mode link.
- Claude: polish pass (empty/loading/error states, motion, both themes), fix-forward from QA.
- Codex: bug-fix handoffs only. **Feature freeze Day 12 (Oct 31).**
- Teammate: presentation + rehearsal; fallback = replay mode if live agents misbehave.

### After the demo
1. **C — Bake-off** (Codex: parallel variant runner + comparison metrics; Claude: comparison view)
2. Portfolio polish: a11y audit, onboarding, README case study with GIFs, more harnesses if wanted.

---

## 5. Codex handoff mechanics

```bash
codex.cmd exec --skip-git-repo-check -s workspace-write \
  -m gpt-6.1-sol -c model_reasoning_effort=high \
  -C "<repo>/.wt/<agent>" -o "<repo>/handoffs/<wave>-<agent>.result.md" \
  - < "<repo>/handoffs/<wave>-<agent>.md"
```
- All agents in a wave launch at once in the background, each in its own worktree/branch.
- Dependencies installed once centrally; Claude is the only one editing root config, lockfile, and `packages/contracts`.
- **Brief template:** goal + numbered acceptance criteria · owned paths + do-not-touch list · contracts to implement · fakes for neighbors · exact test command that must pass · Windows gotchas · result-file format (summary, files, decisions, contract-change requests, gaps).
- Always pass `-m` and the effort explicitly: the global `~/.codex/config.toml` default is `gpt-6-astra` / `xhigh`, which any call without flags (including `codex exec review`) would use.
- Fix rounds go to the same Codex thread (`codex.cmd exec resume <id>`), max 3 before escalating to you.

## 6. Review gates (every Codex branch)
1. typecheck + lint + tests green · 2. no edits outside owned paths / no contract edits · 3. Claude reads the full diff against acceptance criteria (`/code-review high`) · 4. second-opinion `codex exec review` (read-only, `-m gpt-6.1-sol -c model_reasoning_effort=high`) · 5. Claude runs the scenario end to end · 6. invariants: status derived not stored, dirty worktrees never deleted, loopback-only, append-only migrations, **replay determinism** (live UI state at t == replayed UI state at t), no merge without a human click, nothing spawns before plan approval.
Merge via PR on GitHub — you (or teammate) click merge after Claude's sign-off.

---

## 7. UI/UX (Claude)

**Principle:** attention first, explanation one click away.

**Layout:** sidebar (Needs you · Projects → sessions · Recordings) | main area | inspector. A **timeline bar pinned to the bottom** of every project view: live by default; drag to replay history across the whole UI; event ticks colored by type; "Back to live" pill. Wording everywhere is "replay", never "rewind" or "restore".

**Screens**
1. **Board** — Pending · Working · Needs you · In review · Ready to merge (+ Archive). Cards: agent glyph, title, branch, PR #, checks `18/50`, current action, time. Cards never reorder under the cursor.
2. **Plan view** — orchestrator's plan as a graph; nodes = tasks w/ status ring + agent + claimed files; edges = dependencies; **Approve plan** bar while the plan is pending (Edit is P1); click node → its session; hover → rationale tooltip. Board ⇄ Plan toggle.
3. **Session view** — Chat (collapsed tool groups, plans as checklists, approval cards with scope, "N new events ↓") or Terminal (P1); composer with Queue vs Interrupt; inspector tabs Summary · Files (scope: workspace / PR / last turn) · PR & CI.
4. **Why panel** — for any node/event, every entry carries a source label: *Stated in the plan* (orchestrator rationale) → *Recorded by Helix* (causedBy trigger chain, clickable, scrubs timeline to that moment) → *Agent's own summary* (reasoning summary, marked unverified; "not provided by agent" when absent).
5. **Needs you inbox**, **New task dialog** ("plan it for me" toggle), **Recordings** (open a .helixlog in replay), **Settings** (harness detection, GitHub auth status).
6. *(Stretch)* **Bake-off compare** — two columns, synced scrubbing, metric strip, "Merge this one".

**Visual direction:** dark-first with a real light theme; Inter + JetBrains Mono; 4-pt spacing; 12/13/14/16/20/28 type scale; status = blue working, amber needs you, red failed, violet review, green ready/merged, gray pending — always icon + label; AA contrast; 120–180ms motion; graph edges animate only on state change. Keyboard: ⌘K palette, ⌘N new task, J/K, `[` `]` step timeline, `L` back to live, `?` shortcuts.

**Build order:** tokens → primitives → Board → Session → Diff → timeline bar → Plan graph → Why panel → Inbox → demo-mode shell → polish.

---

## 8. Risks
| Risk | Mitigation |
|---|---|
| Real GitHub differs from our fake (queued checks, required checks, credentials) | Private test repo with CI that fails once; run the full loop on Days 4–6, before Wave 2 merges |
| Plan doesn't cut work cleanly (parallel tasks collide) | File claims + overlap rejection; contract tasks; post-merge re-check routes conflicts back |
| Codex Sol misses on a hard brief | Smaller briefs; one retry; escalate that brief alone to `gpt-6-astra` |
| Live agents flaky during demo | Replay mode is the fallback; rehearse with recordings |
| Harness output formats shift | Adapters behind capability flags; recorded fixtures |
| Reasoning not exposed by a harness | Why panel still has plan rationale + trigger chain; reasoning section shows "not provided by agent" |
| Two-week squeeze | P0 cut to the demo loop; feature freeze Day 12; C is post-demo; G's restart recovery can be dropped first (keep the guardrails) |
| Windows PTY/process quirks | Windows CI from day 1, dedicated tests |

---

## 9. Open items
- Confirm teammate's role (proposed above).
- ~~GitHub repo location~~ → `wiltobuild/helix`.
- Which agent should be the orchestrator by default — Claude Code or Codex?
- Hosted demo: **decided** — static replay build on Vercel (project `helix-demo`, Pursuit team), auto-deploys from main: https://helix-demo-theta.vercel.app
- Claude Code's default permission mode for worker sessions.
- Per-launch token on the local API before the demo, or accept the risk for the MVP?
