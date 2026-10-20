**R1 — Orchestrator.inc product teardown**  
*Live research: October 20, 2026. Public documentation and marketing review; no authenticated product test.*

**Product and audience**

Orchestrator.inc, also called Agent Orchestrator or AO, is an open-source desktop workspace for supervising multiple coding agents. It keeps each task’s agent, conversation, terminal, workspace, branch, PR, CI, and review state together. A project-level orchestrator can plan work and delegate it to workers. [GitHub](https://github.com/OrchestratorInc/agent-orchestrator)

The primary user is a developer already using coding-agent subscriptions who needs to manage concurrent work. The commercial design-partner program explicitly targets teams of **10–100 engineers**, particularly those using multiple agents and seeking evidence of their return on investment. Shared collaboration and ROI reporting are described as roadmap work, not established general-availability features. [Design partners](https://orchestrator.inc/design-partners/)

**Core nouns**

- **Project:** one repository, a multi-repository workspace, or a non-Git Scratch directory.
- **Harness:** an installed coding-agent CLI/adapter.
- **Session / worker:** a task and its execution context.
- **Orchestrator:** an agent supervising workers.
- **Reviewer:** a separate agent run examining a worker’s PR.
- **Worktree:** isolated Git working directory and branch.
- **Cue:** manually invoked reusable prompt or shell command.
- **Automation:** scheduled agent task.
- **Artifact:** an output file associated with a session. [Projects](https://docs.orchestrator.inc/configuration/projects/), [automation reference](https://docs.orchestrator.inc/configuration/lifecycle-automation/), [changelog](https://orchestrator.inc/changelog/)

**End-to-end flow**

1. Install AO and the desired external agent; authenticate the agent and GitHub tooling.
2. Add a local repository; select worker/orchestrator defaults.
3. Create a task with a name, prompt, agent, and Chat or Terminal interface.
4. AO creates the branch/worktree and starts the agent. Alternatively, give the orchestrator a larger outcome to divide into workers.
5. Follow progress, provide instructions, answer approvals, inspect files, and preview the application.
6. The worker opens or claims a PR. AO tracks CI, comments, reviews, and mergeability.
7. Run reviewer agents; route corrections to the worker; resolve comments and merge.
8. Archive/clean up the session. Ordinary cleanup preserves dirty worktrees. [Quickstart](https://docs.orchestrator.inc/quickstart/), [delegation](https://orchestrator.inc/)

**UI and user-facing feature inventory**

- **Application shell:** left sidebar containing projects and sessions; central board or session; adjacent inspector containing PR, reviews, files, and browser. Chat includes durable history, activities, plans, approvals, structured questions, attachments, and provider-dependent model, effort, permission, skill, and MCP controls. Compatible sessions switch between Chat and native Terminal UI. [Dashboard](https://docs.orchestrator.inc/dashboard/)
- **Board:** homepage mockups show search, pinned sessions, project navigation, New task, Orchestrator, and archive controls. Columns include Pending Work, Iterating, In Review, and Ready to merge. Cards show agent icon, task, branch, PR state, activity/time, checks, reviewer avatars, and comments. These are marketing representations, not independently exercised screens. [Homepage](https://orchestrator.inc/)
- **Session lifecycle:** create, rename, terminate, restore, resume, switch agents, claim PRs, send messages, report progress/artifacts, and clean up. CLI also exposes review, merge, comment-resolution, preview-server, browser, automation, and Cue operations. [CLI reference](https://docs.orchestrator.inc/cli/)
- **Feedback automation:** CI failures, unresolved reviews, and merge conflicts produce deduplicated instructions to the responsible session; readiness and attention events produce notifications. Scheduled Automations support timezone-aware cron/RRULE, run history, pause/resume, and limited missed-run recovery. [Automation reference](https://docs.orchestrator.inc/configuration/lifecycle-automation/)
- **Project configuration:** role-specific agents/models, base branch, permissions, standing rules, environment variables, symlinks, setup/cleanup commands, reviewer configuration, and opt-in issue intake. Supports multi-repository and projectless work. [Configuration](https://docs.orchestrator.inc/configuration/)
- **Browser/files:** embedded preview, session-isolated or reusable named browser profiles, imported browser state, standalone shells, parsed diffs, and IDE handoff. Browser automation is available through the daemon/Electron bridge. [Architecture](https://docs.orchestrator.inc/architecture/), [July update](https://orchestrator.inc/changelog/2026-07-26-weekly-update/)
- **Recent additions:** searchable project-grouped Artifacts page; artifact creation, inspection, deletion, card previews; Markdown editing/version history and multimedia viewing described in preview releases. Inline HTML charts/pages, selected-text/code feedback, chat suggestions, resumed turns, message recall, harness Account/Models/Health settings, manual CLI updates, command palette, keyboard shortcuts, themes, browser search, and controlled downloads. Estimated session cost/token displays were removed because they overstated spend. Availability varies between stable and preview builds. [Changelog](https://orchestrator.inc/changelog/)
- **Notifications/mobile:** durable notification feed, desktop toasts, mobile push; QR/password pairing; access to projects, workers, Chat/Terminal, PRs, and reviews. LAN access and optional managed HTTPS tunnel through `cloudflared`; Tailscale has documented platform limitations. [Notifications](https://docs.orchestrator.inc/plugins/notifiers/), [Connect Mobile](https://docs.orchestrator.inc/configuration/remote-access/)

**Integrations and model support**

AO integrates **harnesses**, rather than publishing one universal model API catalog. Local sessions reuse installed credentials/subscriptions and provider-exposed model choices.

The catalog lists Claude Code, Codex, OpenCode/v2, Grok, Cursor, Qwen, Gemini, Copilot, Kimi, Muse, Droid, Amp, Antigravity, Crush, Aider, Goose, Auggie, Continue, Devin, OMP, Cline, Kiro, Kilo Code, Mistral Vibe, Pi, Kimchi, Prime Agent, Autohand, fx, Unreal Agent, MiMo Code, DeepSeek Harness, OpenHands, and Command Code. Marketing claims 36 harnesses; recent releases add Codewhale. Chat/reviewer support differs by harness and version. [Agent catalog](https://docs.orchestrator.inc/plugins/agents/), [changelog](https://orchestrator.inc/changelog/)

Cloud documents **Claude Code, Codex, Cursor, and OpenCode**, subject to account access and connected credentials. It requires separate Cloud and GitHub repository authorization. [Cloud guide](https://docs.orchestrator.inc/guides/cloud/)

GitHub/GitLab provide PR/MR observation and read-only, opt-in issue intake. Current documentation explicitly excludes Linear and legacy npm plugins; Slack, Discord, webhook, Composio, and OpenClaw notifier configurations are also retired. Do not copy older launch integration claims into a current specification. [Capabilities](https://docs.orchestrator.inc/plugins/), [notifiers](https://docs.orchestrator.inc/plugins/notifiers/)

**Pricing and deployment**

| Offering | Verified terms |
|---|---|
| Local | Free, Apache-2.0, unlimited local agents; no account/card required. Provider usage billed separately. |
| Cloud Starter / Pro / Enterprise | Homepage says paid plans start at **$20/month**; complete prices, quotas, and tier differences unavailable. |
| Design-partner pilot | **$500–$2,000/month**, month-to-month; founder onboarding/access, early features, six months of partner pricing at GA, pilot fees credited toward year one. |

Sources: [homepage](https://orchestrator.inc/), [partner terms](https://orchestrator.inc/design-partners/).

Desktop downloads cover macOS Intel/Apple Silicon, Windows x64, and Linux AppImage/deb/RPM; stable and nightly channels. Mobile apps are free on iOS/Android. The optional CLI operates against the desktop daemon. [Downloads](https://orchestrator.inc/download/), [CLI](https://docs.orchestrator.inc/cli/)

Cloud runs hosted sandboxes with remote Chat, terminal, Files, and PR/review inspection. **Conflict:** homepage says available now; waitlist says gradual early access; docs describe gated access. The privacy page’s blanket “not hosted” language also conflicts with Cloud documentation. [Cloud](https://docs.orchestrator.inc/guides/cloud/), [waitlist](https://orchestrator.inc/waitlist/), [privacy](https://orchestrator.inc/privacy/)

**Stated architecture**

Electron/React desktop, Expo mobile, and CLI communicate with a Go daemon over HTTP, SSE, and terminal streams. SQLite stores durable facts; triggers/change-log polling generate refresh events. Display status is derived from agent and SCM facts. Local state lives under `~/.ao`. Native PTY/ConPTY handles terminals; Chat uses provider controllers, including Codex app-server and ACP adapters. Cloud has a separate control plane and sandbox persistence. [Architecture](https://docs.orchestrator.inc/architecture/), [agent transports](https://docs.orchestrator.inc/plugins/agents/)

**Coverage and unavailable evidence**

Visited the public marketing routes, linked documentation sections and guides, changelog/archive, GitHub/releases, app stores, LinkedIn, and matching [HN launch](https://news.ycombinator.com/item?id=47219229). LinkedIn announces v0.14.3; release pages distinguish nightly builds. [LinkedIn](https://www.linkedin.com/company/orchestratorinc), [releases](https://github.com/OrchestratorInc/agent-orchestrator/releases)

No matching Product Hunt launch or standalone blog was found. X launch fetch returned **403**; the company X link, pricing route, sitemap, and GitHub pricing directory fetch failed. Discord exposed no discussions. The homepage demo exposed a poster but no usable video/transcript in fetched content. This is not an exhaustive crawl of every historical release, GitHub issue/PR, or social post.

**Feature checklist to clone**

*Priorities are INFERRED: P0 essential; P1 next; P2 expansion.*

| Feature | Evidence URL | Priority guess |
|---|---|---|
| Project/task creation with isolated worktrees | [Quickstart](https://docs.orchestrator.inc/quickstart/) | P0 |
| Live board with branch/PR/CI state | [Homepage](https://orchestrator.inc/) | P0 |
| Multi-harness Chat and terminal sessions | [Catalog](https://docs.orchestrator.inc/plugins/agents/) | P0 |
| Orchestrator delegation and worker messaging | [CLI](https://docs.orchestrator.inc/cli/) | P0 |
| CI/review/conflict feedback loop | [Automation](https://docs.orchestrator.inc/configuration/lifecycle-automation/) | P0 |
| Files/diffs, reviewer runs, merge controls | [Dashboard](https://docs.orchestrator.inc/dashboard/) | P0 |
| Durable history and session recovery | [Architecture](https://docs.orchestrator.inc/architecture/) | P0 |
| Browser previews and profiles | [Architecture](https://docs.orchestrator.inc/architecture/) | P1 |
| Project rules, scripts, environment, Cues | [Projects](https://docs.orchestrator.inc/configuration/projects/) | P1 |
| Recurring tasks and notifications | [Automation](https://docs.orchestrator.inc/configuration/lifecycle-automation/) | P1 |
| Artifacts, editing, feedback, version history | [Changelog](https://orchestrator.inc/changelog/) | P1 |
| Mobile pairing and remote supervision | [Mobile](https://docs.orchestrator.inc/configuration/remote-access/) | P2 |
| Hosted execution | [Cloud](https://docs.orchestrator.inc/guides/cloud/) | P2 |
| Shared teams and ROI reporting—roadmap | [Partners](https://orchestrator.inc/design-partners/) | P2 |