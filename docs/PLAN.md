# Helix — Explainable Agent Orchestrator · Implementation Plan (v2)

> Product name: **Helix**. A local web app that runs Claude Code and Codex in parallel git worktrees,
> takes each task from prompt → PR → CI → merge, and — unlike [orchestrator.inc](https://orchestrator.inc/) —
> **shows its reasoning**: a live plan graph, a scrubbable timeline, and a "why" panel for every decision.
>
> Team: 2 people · Demo: **~2 weeks** · Then: portfolio polish, open-ended.
> Status: **plan only — no code yet.**

---

## 1. Scope

| Tier | What | When |
|---|---|---|
| **B — Thin slice** (must) | Projects, board with derived status, session view (Chat + read/write terminal), Files/diff inspector, PR → CI → auto-fix loop, Claude Code + Codex adapters | Week 1 |
| **D — Explainable orchestration** (must, the hook) | Orchestrator agent submits a structured plan → **live plan graph**; **timeline scrubber** that rewinds the whole UI; **Why panel** (rationale, reasoning summary, trigger) | Week 2 |
| **Demo mode** (must) | Record real runs; replay them with nothing installed; hosted static demo link | Week 2 |
| **C — Bake-off** (stretch) | Same task → Claude and Codex in parallel worktrees → side-by-side compare (diff, tests, time, interventions) → merge winner | After demo |
| Polish (post-demo) | Animations, a11y audit, onboarding, more harnesses, case-study README with GIFs | After demo |

**Explicitly out:** 30+ harnesses, Cues, Automations, browser preview, mobile, cloud, Electron, TUI⇄Chat switching, cost tracking.

**One idea makes D, demo mode, and C cheap:** everything is an **append-only event log**. The UI state is a pure function `project(events up to t)`. Live view = t is now. Timeline scrubber = drag t. Demo mode = load a recorded log. Bake-off comparison = two logs side by side.

---

## 2. Who does what

| Owner | Owns |
|---|---|
| **Codex** (`gpt-6-astra`, effort **high**, via handoffs) | Daemon, event store, harness adapters, PTY, git/worktrees, GitHub loop, orchestrator CLI + prompts, recorder, all backend tests |
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
| Orchestrator | A Claude Code (or Codex) session with a system prompt + the `helix` CLI: `helix plan submit plan.json`, `helix spawn`, `helix send`, `helix status`, `helix explain "<why>"` |
| Reasoning capture | Plan rationale (structured, from `plan submit`) + harness reasoning summaries where emitted + system-generated triggers ("CI failed: auth.test.ts") |
| Frontend | Vite + React 19, TanStack Query + Router, Zustand, Radix, Tailwind v4 w/ CSS-variable tokens, React Flow (plan graph, ELK layout), xterm.js, Shiki + diff view, cmdk, Motion |
| Hosting demo | Static build of the same app with `?demo=<recording>` → Vercel |
| Tests | Vitest; fake harness + fake GitHub; Playwright for UI incl. replay-determinism test |

### Core events (frozen in Wave 0)
`project.added` · `session.created/started/exited/archived` · `activity.changed` (active/idle/waiting/blocked) · `chat.message` · `chat.tool_call` · `chat.approval_requested/decided` · `reasoning.summary` · `plan.submitted` · `plan.node_updated` · `explain.note` · `worktree.created/diff_updated` · `pr.opened/updated` · `ci.updated` · `review.updated` · `feedback.routed` · `pr.merged`
Every event: `{seq, ts, projectId, sessionId?, planNodeId?, causedBy?: seq, type, payload}` — **`causedBy`** is what powers the Why panel ("this fix was caused by event #412 CI failure"). **`variantOf`** on sessions is reserved now so bake-off needs no migration later.

---

## 4. Schedule

### Day 1 — Wave 0, sequential
- **Codex W0-scaffold** — monorepo, lint/typecheck/test, CI (Windows + Linux), boundary lint.
- **Codex W0-contracts** — event types, entities, `deriveStatus` + board-column table tests, `AgentHarness`/`WorktreeManager`/`ScmObserver` interfaces, REST schemas, fixture format.
- **Claude** — reviews + freezes contracts; installs all deps; writes Wave 1 briefs; picks visual direction.
- **Teammate** — demo script v1 (the 3-minute story) + sample demo repo with a few real issues.
- **You** — create GitHub repo, approve contracts.

### Days 2–5 — Wave 1 (4 Codex agents in parallel)
| Agent | Brief | Done when |
|---|---|---|
| **A** events + daemon | SQLite event store, projections, SSE w/ replay, Fastify routes, serves web build | Route conformance + SSE reconnect tests green |
| **B** harnesses | Claude Code + Codex adapters: start, send, interrupt, resume, activity detection, reasoning summary extraction; fake harness | Contract tests on fakes; real smoke behind `HELIX_E2E=1` |
| **C** git + terminal | Worktree create/diff/safe-cleanup (never delete dirty), per-repo lock; PTY host + `/mux` WS (ConPTY) | Windows CI green; dirty-worktree test |
| **D** GitHub loop | PR facts via ETag polling, CI + review state, feedback routing (CI fail → message to owning session, deduped), merge | Fake-GitHub scenario: fail → fix → pass → merge |

**Claude in parallel:** design tokens + primitives, then Board, Session view, Diff inspector — all against a mock server driven by fixture event logs (no waiting on backend).
**End of Day 5 milestone:** one real task, end to end, in the UI: prompt → worker edits → PR → CI fails → auto-fix → green → merge.

### Days 6–10 — Wave 2 (3 Codex agents) + D in the UI
| Agent | Brief |
|---|---|
| **E** orchestrator | `helix` CLI; orchestrator system prompt; `plan submit` schema (nodes, deps, rationale, acceptance); plan → spawn workers respecting deps; `explain` notes; escalation to "Needs you" |
| **F** recorder + replay | Export/import event logs (`.helixlog`), redaction of paths/tokens, deterministic replay API; demo build flag |
| **G** hardening | Daemon restart recovery, process-tree kill on Windows, error surfaces as events, integration test suite |

**Claude:** plan graph (React Flow + ELK, nodes animate with live status), timeline scrubber (rewinds board + graph + chat together), Why panel (rationale → reasoning → causal chain via `causedBy`), Needs-you inbox, New-task dialog with "let the orchestrator plan it".
**Day 10 milestone:** full demo script runs live and as a replay.

### Days 11–14 — Demo prep
- Record 2–3 clean runs on the demo repo (you + teammate); deploy hosted demo-mode link.
- Claude: polish pass (empty/loading/error states, motion, both themes), fix-forward from QA.
- Codex: bug-fix handoffs only. **Feature freeze Day 12.**
- Teammate: presentation + rehearsal; fallback = replay mode if live agents misbehave.

### After the demo
1. **C — Bake-off** (Codex: parallel variant runner + comparison metrics; Claude: comparison view)
2. Portfolio polish: a11y audit, onboarding, README case study with GIFs, more harnesses if wanted.

---

## 5. Codex handoff mechanics

```bash
codex.cmd exec --skip-git-repo-check -s workspace-write \
  -m gpt-6-astra -c model_reasoning_effort=high \
  -C "<repo>/.wt/<agent>" -o "<repo>/handoffs/<wave>-<agent>.result.md" \
  - < "<repo>/handoffs/<wave>-<agent>.md"
```
- All agents in a wave launch at once in the background, each in its own worktree/branch.
- Dependencies installed once centrally; Claude is the only one editing root config, lockfile, and `packages/contracts`.
- **Brief template:** goal + numbered acceptance criteria · owned paths + do-not-touch list · contracts to implement · fakes for neighbors · exact test command that must pass · Windows gotchas · result-file format (summary, files, decisions, contract-change requests, gaps).
- Fix rounds go to the same Codex thread (`codex.cmd exec resume <id>`), max 3 before escalating to you.

## 6. Review gates (every Codex branch)
1. typecheck + lint + tests green · 2. no edits outside owned paths / no contract edits · 3. Claude reads the full diff against acceptance criteria (`/code-review high`) · 4. second-opinion `codex exec review` (read-only) · 5. Claude runs the scenario end to end · 6. invariants: status derived not stored, dirty worktrees never deleted, loopback-only, append-only migrations, **replay determinism** (live UI state at t == replayed UI state at t).
Merge via PR on GitHub — you (or teammate) click merge after Claude's sign-off.

---

## 7. UI/UX (Claude)

**Principle:** attention first, explanation one click away.

**Layout:** sidebar (Needs you · Projects → sessions · Recordings) | main area | inspector. A **timeline bar pinned to the bottom** of every project view: live by default; drag to rewind everything; event ticks colored by type; "Back to live" pill.

**Screens**
1. **Board** — Pending · Working · Needs you · In review · Ready to merge (+ Archive). Cards: agent glyph, title, branch, PR #, checks `18/50`, current action, time. Cards never reorder under the cursor.
2. **Plan view** — orchestrator's plan as a graph; nodes = tasks w/ status ring + agent; edges = dependencies; click node → its session; hover → rationale tooltip. Board ⇄ Plan toggle.
3. **Session view** — Chat (collapsed tool groups, plans as checklists, approval cards with scope, "N new events ↓") or Terminal; composer with Queue vs Interrupt; inspector tabs Summary · Files (scope: workspace / PR / last turn) · PR & CI.
4. **Why panel** — for any node/event: *Intent* (plan rationale) → *Reasoning* (agent summary) → *Trigger chain* (causedBy links, clickable, scrubs timeline to that moment).
5. **Needs you inbox**, **New task dialog** ("plan it for me" toggle), **Recordings** (open a .helixlog in replay), **Settings** (harness detection, GitHub auth status).
6. *(Stretch)* **Bake-off compare** — two columns, synced scrubbing, metric strip, "Merge this one".

**Visual direction:** dark-first with a real light theme; Inter + JetBrains Mono; 4-pt spacing; 12/13/14/16/20/28 type scale; status = blue working, amber needs you, red failed, violet review, green ready/merged, gray pending — always icon + label; AA contrast; 120–180ms motion; graph edges animate only on state change. Keyboard: ⌘K palette, ⌘N new task, J/K, `[` `]` step timeline, `L` back to live, `?` shortcuts.

**Build order:** tokens → primitives → Board → Session → Diff → timeline bar → Plan graph → Why panel → Inbox → demo-mode shell → polish.

---

## 8. Risks
| Risk | Mitigation |
|---|---|
| Live agents flaky during demo | Replay mode is the fallback; rehearse with recordings |
| Harness output formats shift | Adapters behind capability flags; recorded fixtures |
| Reasoning not exposed by a harness | Why panel still has plan rationale + trigger chain; reasoning section shows "not provided by agent" |
| Two-week squeeze | Feature freeze Day 12; C is post-demo; Wave 2 agent G can be dropped first |
| Windows PTY/process quirks | Windows CI from day 1, dedicated tests |

---

## 9. Open items
- Confirm teammate's role (proposed above).
- GitHub repo location.
- Which agent should be the orchestrator by default — Claude Code or Codex?
