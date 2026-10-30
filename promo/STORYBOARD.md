# Helix promo: storyboard (final cut v1)

**Timing:** there is no voice track; the words are on screen. Hold times come from a slow reading-pace model in `tools/timeline.mjs`: 0.8 s plus 0.4 s per word, plus the bracketed pauses (pause 1.2 s, longer pause 2.0 s, hold 2.8 s). If a narration recording is added later, re-time to it.

| Version                                                            | Phrases | Runtime  |
| ------------------------------------------------------------------ | ------- | -------- |
| Baseline script                                                    | 35      | **2:24** |
| Baseline + teamwork insert after "That's what Helix helps manage." | 42      | **2:56** |

**Layout:** the app sits in a fixed frame 56–854 px from the top. Some beats split it into a plan pane and an inspector pane, and the store uses three portrait panes. Captions sit in their own band at 884–1034 px, so they never cover the app. The Shaw opening and the closing beats ("You bring the idea." / "Helix brings the team together.") are set as typography in both versions, not as captions.

## Footage sources

| Source                                                   | What it is                                                                                                                                                                                                                                                                  | On-screen label                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `dc`: 18 stills from the bundled `discount-codes` replay | A real run recorded 2026-10-28 (wiltobuild/helix-demo-app). Helix (Claude Code) plans "Add discount codes to checkout". Codex builds cart pricing; Claude Code builds the receipt, which depends on the pricing task. A human approves the plan; CI passes; both PRs merge. | "Real Helix replay · recorded store build, Oct 28 2026" |
| `daybreak`: five storefront design images you supplied   | Daybreak homepage designs showing the product catalogue and "Add to bag" / cart.                                                                                                                                                                                            | "Daybreak storefront designs"                           |
| Daybreak review record (teamwork insert only)            | Facts quoted from `docs/daybreak-review-failure.md`: Claude Code's catalogue and cart approvals (events 631, 688), and the recorded fallback when the Codex reviewer could not start (events 585–624, 980–999).                                                             | Source line on the card                                 |

The cross-review example fixture is not used anywhere.

## Cut (baseline times)

| Time | Phrase(s)                                             | Picture                                                                                                                                                    |
| ---- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Shaw quote, s01–s05                                   | Kinetic typography. "Why?" is set in teal; "Why not?" is large with a teal-to-coral gradient. George Bernard Shaw is credited, then the DNA mark fades in. |
| 0:22 | Machines can create now.                              | Agents page: Codex worker (Active) and Claude Code worker (Planned).                                                                                       |
| 0:26 | Tools like Claude Code and Codex…                     | Plan approved → Codex task "In progress"; the Claude Code task waits on its dependency.                                                                    |
| 0:31 | But if you want several agents… manage that team.     | Wide plan graph, pushing in on the Helix orchestrator card.                                                                                                |
| 0:41 | Explain the goal.                                     | Build header with the original request, plus the inspector's Plan summary.                                                                                 |
| 0:44 | Divide the work.                                      | Two tasks with owners: Task 1 → Codex; Task 2 → Claude Code, after task 1.                                                                                 |
| 0:47 | Check the results.                                    | Codex card "1/1 CI passed", plus the inspector's CI history (#150 passed 0/0 → #153 running → #155 passed 1/1 → #156 merged).                              |
| 0:50 | Bring it all together.                                | Why bar #158: "Starting from fetched base … merged prerequisites: cart-discount-pricing (PR #1)", then 2/2 merged.                                         |
| 0:54 | That's what Helix helps manage.                       | Helix card: Complete · 2/2 merged · plan approved.                                                                                                         |
| 0:58 | Imagine building an online store.                     | Three Daybreak storefront designs.                                                                                                                         |
| 1:01 | One agent… catalogue… another… shopping cart.         | Daybreak product grid, with callouts "Product catalogue" and then "Shopping cart · Add to bag".                                                            |
| 1:10 | Helix organises their assignments,                    | Tasks page: each task's owner agent, status and branch.                                                                                                    |
| 1:13 | tracks what they need from each other,                | Receipt task: "Waits on Discount pricing in cart.ts".                                                                                                      |
| 1:17 | …through review and testing.                          | CI running → passed → PR #1 merged.                                                                                                                        |
| 1:22 | And while they work… see it happening.                | Plan view moving through Codex working → PR opened → CI running.                                                                                           |
| 1:29 | Who is building.                                      | Codex card "In progress" (teal frame).                                                                                                                     |
| 1:32 | Who is checking.                                      | CI running on PR #1, task "Waiting for CI" (violet frame).                                                                                                 |
| 1:35 | What is ready.                                        | Task 1 Done, CI passed, merged.                                                                                                                            |
| 1:38 | What is waiting.                                      | Claude Code task Waiting on task 1 (coral frame).                                                                                                          |
| 1:41 | And where your decision can move it forward.          | "Why this plan is blocked … needs your approval" + Approve plan → "You approved this plan at 6:01:36 PM".                                                  |
| 1:46 | You stay involved in shaping the product,             | Task selected; inspector shows its intent.                                                                                                                 |
| 1:50 | while Helix handles the coordination                  | Inspector Why: the event chain and its causes.                                                                                                             |
| 1:54 | …terminals, conversations, half-finished handoffs.    | Tasks page → Pull requests page.                                                                                                                           |
| 2:00 | As these tools get stronger… ambition…                | Finished plan, pulling back.                                                                                                                               |
| 2:08 | You bring the idea. / Helix brings the team together. | Two typographic beats, then the DNA mark.                                                                                                                  |
| 2:16 | Let me show you how it works.                         | End card: DNA mark + HELIX, held for the live demo.                                                                                                        |

The **teamwork insert** (after "That's what Helix helps manage.") runs:

| Phrase(s)                                                      | Picture                                           |
| -------------------------------------------------------------- | ------------------------------------------------- |
| "Claude Code and Codex bring different capabilities"           | The worker pair                                   |
| "one coordinated effort"                                       | The finished plan                                 |
| "One agent can build"                                          | Codex card, teal frame                            |
| "Another can examine its work…" through "independent scrutiny" | The Daybreak review-record card, one row per line |
| "shared result"                                                | The finished plan, 2/2 merged                     |
