**R4 — Agent orchestration dashboard UI/UX research**  
*Live research: October 20, 2026.*

**Recommendation:** Build an attention-first workspace: a fleet board/list for supervision, a focused session view for steering, and a dedicated review workspace. Make dependency graphs and execution timelines secondary views.

Evidence below comes from public product pages and official documentation. Orchestrator’s public UI mockup was readable, but interactive browser inspection was unavailable. Authenticated applications were not tested; exact fonts, spacing, theme coverage, and undocumented empty states remain unverified. Recommendations are proposed design choices; analytical deductions are labeled **INFERRED**.

**Product findings**

| Product | Documented interface and strongest transferable pattern |
|---|---|
| **Orchestrator** | Public mockup exposes **Search, Pinned, Projects, Settings**, plus a lifecycle board: **Pending Work, Iterating, In Review, Ready to merge**, and Archive. Cards combine task, branch, agent, PR, checks, comments, and recency. Session details expose **Summary, Browser, Files**. New-task dialog selects task, agent, model. Its strongest pattern is connecting execution to delivery state. Marketing examples vary slightly in status terminology; treat them as illustrations. [Public UI](https://orchestrator.inc/), [docs](https://docs.orchestrator.inc/) |
| **Conductor** | Each task owns a workspace, branch, files, terminal, diff, and review path; completion proceeds through PR, merge, archive. Parallel work distinguishes shared-workspace sessions from independent workspaces. `⌘N` creates a workspace. **INFERRED:** isolation should be visible beside the task, not buried in settings. [Overview](https://www.conductor.build/docs), [parallel agents](https://www.conductor.build/docs/concepts/parallel-agents) |
| **Devin** | Session shell history supports inspecting commands and outputs at different points in execution. Review groups related edits logically, detects moved/copied code, offers contextual chat, and supports comments/approval/request-changes. Review entry points include categorized PR queues. This is a strong reference for explanation beside evidence. [Session tools](https://docs.devin.ai/work-with-devin/devin-session-tools), [review](https://docs.devin.ai/work-with-devin/devin-review) |
| **Cursor background/cloud agents** | A unified sidebar exposes foreground and background agents; selecting a background agent opens its remote working environment. Current release notes describe parent-agent context retained when opening subagent tabs and review sheets with Comment/Approve/Request Changes. **INFERRED:** preserve parent context when drilling into workers. [Agent sidebar](https://cursor.com/changelog/1-4), [release notes](https://prod.cursor.com/docs/release-notes) |
| **Claude Code desktop** | Sidebar sessions, optional two-session split, diff/browser/terminal panes, and Normal/Thinking/Verbose transcript modes. Permission mode sits under the composer; Manual exposes accept/reject diffs. A usage ring distinguishes session context from shared plan usage. `Ctrl+Tab` cycles sessions; `Cmd/Ctrl+/` reveals shortcuts. Coordinated CLI “agent teams” should not be mistaken for desktop sessions. [Desktop documentation](https://code.claude.com/docs/en/desktop) |
| **OpenAI Codex app** | Projects/chats support pinning, naming, search, archive. Review supports explicit scopes—Unstaged, Staged, Commit, Branch, Last turn—plus inline feedback and file/hunk staging or reverting. This avoids ambiguity about what a displayed diff represents. The former app documentation URL now redirects to ChatGPT desktop documentation, so older screenshots may differ. [Projects](https://learn.chatgpt.com/docs/projects), [review](https://learn.chatgpt.com/docs/code-review?surface=app) |
| **Factory** | Documentation organizes work around sessions, automations, and multi-agent Missions. App setup exposes working-directory and model selection; the quickstart demonstrates requesting a diff before applying changes. Exact fleet visualization and visual styling were not established. [App quickstart](https://docs.factory.com/factory-app/quickstart) |
| **Linear agents** | Agents fit existing issue ownership: delegate or mention them, retain delegated issues in My Issues, filter views by Delegate, and inspect agent contributions. **INFERRED:** human accountability should remain visible after delegation. [Agents in Linear](https://linear.app/docs/agents-in-linear) |
| **LangSmith / LangGraph Studio** | Graph mode exposes traversed nodes and intermediate state; Chat mode simplifies behavioral testing. Threads, assistants, tracing, and time travel support deeper investigation. Graph topology is not evidence of simultaneous execution; cycles also mean “DAG” is not always accurate. [Studio](https://docs.langchain.com/langsmith/studio) |
| **Temporal UI** | Filterable execution table leads to history with **Timeline, All, Compact, JSON** views. Relationships use a parent/child tree. Execution headers show duration, IDs, queue, and Cloud billable-action count. Timeline is documented as chronological events—not a Gantt chart. [Web UI](https://docs.temporal.io/web-ui) |
| **Vercel v0** | Real-time preview and action feedback support artifact-led iteration. Usage separates **Credits** from **Activity**, with daily stacked bars, member/message drill-down, model, cost, and freshness timestamps. Documentation explicitly describes light/dark chart colors. [Product](https://v0.app/docs), [usage](https://v0.app/docs/usage-dashboard) |
| **Replit Agent** | Kanban uses **Drafts, Active, Ready, Done**. Tasks run in isolated copies; Ready requires applying changes to main. Cards link to work logs, tests, preview, and diffs. Dependencies and capacity can both cause queuing. **INFERRED:** display those queue reasons separately. [Task board](https://docs.replit.com/features/agent/task-board) |
| **n8n / Zapier** | n8n combines workflow nodes with an Agent Builder, preview chat, Sessions, pending approvals, and distinct draft/published versions. Zapier uses sidebar agents/pods, All activity, status rows, and expandable run panels; usage counts activities rather than tokens. Zapier’s current docs flag migration toward AI by Zapier. [n8n builder](https://docs.n8n.io/build/build-and-manage-agents.md), [Zapier activity](https://help.zapier.com/hc/en-us/articles/33336184962573-Review-your-agent-s-activity), [usage](https://help.zapier.com/hc/en-us/articles/26559132765325-How-is-Zapier-Agents-usage-measured) |

**Recommended screen system**

Use a persistent **232px navigation rail**: Inbox, Projects, Runs, Reviews, Usage; Settings below. Show project context in the page header. Support saved filters and deep links.

| Screen | Layout and key components |
|---|---|
| **Inbox / Needs you** | Main queue grouped into approvals, questions, failures, reviews. Selected item opens a right inspector with evidence and a concrete action. Sort by urgency and waiting time. |
| **Project overview** | Header with repository/environment and New task. Board/list switch; filters above content. Columns: Queued, Running, Needs you, Review, Completed. Cards show outcome, agent, current action, elapsed time, branch, checks, and blocking reason. |
| **Run detail** | Collapsible worker tree on left; transcript/activity in center; optional artifact/preview inspector on right. Sticky header shows state, last update, budget, Pause/Stop. Tabs: Activity, Changes, Preview, Execution. |
| **Review workspace** | File/change-group navigation left, wide diff center, findings/checks right. Sticky base/head revision and review scope. Inline comments, viewed markers, request-fix action, and explicit commit/PR actions. |
| **Execution explorer** | Switch between dependency graph, measured timeline, and event table. Selecting any node/span opens inputs, outputs, retries, duration, and usage. Preserve selection across views. |
| **Usage / settings** | Date filters, actual spend, budget remaining, token breakdown, and drill-down by project/run/model. Separate credentials, environments, permissions, notifications, and appearance. |

**Interaction patterns**

- **Streaming:** summarize completed tool groups; expand for commands, outputs, timestamps, and errors. Follow live output only while the user is at the bottom; otherwise show “12 new events.” Preserve scroll position.
- **Parallelism:** board answers “What needs attention?”; tree answers “Who delegated this?”; graph answers “What depends on what?”; measured timeline answers “What overlapped?” Never imply reliable completion forecasts from elapsed time.
- **Approvals:** show exact action, target, scope, consequence, and expiration. Separate Approve once, Reject, and Request change. Keep pending approvals in the global Inbox.
- **Steering:** distinguish Queue follow-up from Interrupt/steer. Retain the original objective and record changes in direction.
- **Costs:** distinguish context occupancy, cumulative tokens, billed dollars/credits, and account allowance. Label estimates and delayed data; unavailable is not zero.
- **Empty states:** first project offers Connect repository and Try sample task; filtered emptiness offers Clear filters; missing permissions offers the precise repair; completed inbox says “Nothing needs your attention.”
- **Keyboard:** proposed `Cmd/Ctrl+K` command palette, `Cmd/Ctrl+N` new task, arrows to navigate, Enter to inspect, Escape to close overlays. Display shortcuts in menus; avoid single-key destructive actions.

**Proposed design-token direction**

| Token | Direction |
|---|---|
| Typography | Inter or system sans; mono only for code, IDs, metrics. Sizes **12 / 14 / 16 / 20 / 28px**; body 14–16px, line-height 1.5; tabular numerals. |
| Spacing/density | **4 / 8 / 12 / 16 / 24 / 32px** scale; 40px default rows, 32px compact option; 16px card padding; 8px radii. |
| Light | Background `#F7F8FA`, surface `#FFFFFF`, text `#182230`, muted `#526071`, border `#D9DEE7`. |
| Dark | Background `#111318`, surface `#191D25`, text `#F1F4F8`, muted `#A5AFBE`, border `#343C49`. |
| Status | Blue running, amber needs input, red failed, violet review, green completed, gray queued/cancelled. Always pair color with icon and label; validate contrast in both themes. |

**Anti-patterns to avoid:** terminal walls as the homepage; animated graph “spaghetti”; automatic card reordering while reading; conflating finished with merged; mixing cancelled and successful without labels; approval prompts without scope; unexplained disabled buttons; hidden spending; tiny low-contrast metadata; and treating marketing screenshots as verified production behavior.