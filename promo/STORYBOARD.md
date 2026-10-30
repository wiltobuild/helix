# Helix promo: timed storyboard (v0, provisional)

**Timing status: PROVISIONAL.** No narration recording has been supplied, and there is no voice track: the words appear on screen only. Hold times come from a slow reading-pace model (`tools/timeline.mjs`: 0.8 s + 0.4 s per word, plus the bracketed pauses: pause 1.2 s, longer pause 2.0 s, hold 2.8 s). If a narration recording is supplied, it becomes the master timing track and every time below gets re-cut to it.

| Version                                                            | Phrases | Runtime (provisional) |
| ------------------------------------------------------------------ | ------- | --------------------- |
| Baseline script                                                    | 35      | **2:24**              |
| Baseline + teamwork insert after "That's what Helix helps manage." | 42      | **2:56** (+31 s)      |

The baseline edit stays the default until you approve the insert version.

Frame layout: the app sits in a fixed 1728×798 frame (top 56 px). Captions sit in a separate band beneath it (y 884–1034), so they never cover the app. The Shaw opening is set as full-screen typography, not captions.

## Footage sources (verified in this container)

| Source                                        | Real?                                                                                | What it contains                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discount-codes` recording (bundled, `?demo`) | **Real run**, recorded 2026-10-28, wiltobuild/helix-demo-app                         | Helix orchestrator (Claude Code) plans "Add discount codes to checkout"; 2 tasks: **Codex** "Discount pricing in cart.ts" and **Claude Code** "Discount line on the receipt" (depends on cart). A human approves the plan (#79, `approvedBy: human`). Codex builds; the receipt task **waits on its dependency**; CI passes 1/1; PR #1 merges; the receipt starts "from fetched base … merged prerequisites: cart-discount-pricing (PR #1)" (#158); PR #2 passes CI and merges. 19 human tool approvals. **No AI cross-review happened in this run**: review decision is `none`, and the reviewer cards only say "Standing by / review slot". |
| `github-ci-repair` recording                  | **Real run** (single Codex worker, sandbox repo)                                     | A CI failure is routed back to the agent and fixed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cross-review` scenario                       | **Synthetic fixture** (`packages/contracts/src/fixtures/cross-review.ts`, acme-demo) | Codex worker, Claude Code reviewer requests changes, fix, re-review approves. The UI labels it "Example run". The video must label it **SIMULATED**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `laptop` scenario                             | Synthetic, already labelled "Simulated" in the UI                                    | Dense 12-agent graph. Not planned for use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Daybreak storefront history                   | **Not available here**                                                               | Per `docs/daybreak-review-failure.md`, it holds real Claude Code catalogue and cart **review approvals** (events 631, 688). It lives in the local Helix database on the machine that ran it.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Scenes

Times are provisional starts in the baseline cut.

### 1. Shaw opening (0:00–0:22), built

Dark navy (`--bg #080b11`) with a faint teal/coral glow. Bricolage Grotesque, light weight.

- 0:01.5 "You see things…" → 0:05.1 "and you say, '**Why?**'" (Why? in Codex teal). The stanza clears.
- 0:08.7 "But I dream things that never were…" → 0:14.7 "and I say…" → 0:18.3 "**'Why not?'**" at 148 px with a teal-to-coral gradient, settling from 1.06× scale.
- The hold gives "Why not?" about 4 s on screen. "George Bernard Shaw" fades in, then the accepted DNA mark emerges at 55% opacity, drawn with the same geometry as `HelixLogo`. The words stay dominant.

### 2. Machines can create (0:22–0:31), built

- s06 "Machines can **create** now.": Agents page, real replay at #81. Close-up of the two worker identity cards: Discount Pricing Engineer · Worker · Codex (Active) and Discount Line Engineer · Worker · Claude Code (Planned, "Waiting for Discount pricing in cart.ts"). Slow push-in.
- s07 "Tools like **Claude Code** and **Codex** can build software.": Plan view from #79 to #83, plan approved → Codex worker "In progress" (`plan.node_updated` "No unmet dependencies; worker started"). Callouts: "Codex · building", "Claude Code · waits on its dependency".
- Every footage frame carries the chip "Replay of a real recorded Helix run · Oct 28, 2026". Agent names appear as product identities only, with no logos beyond those the app already renders and no suggestion of endorsement.

### 3. Manage the team (0:31–0:57), planned. Real discount-codes footage throughout

- s08–s09: pull back to the full plan graph (Helix → two workers → two tasks).
- **Four beats**, one per line, each a readable close-up:
  - "Explain the **goal**." → the build header showing the original request (the plan goal text).
  - "**Divide** the work." → the plan at #72: 2 tasks, owners, file claims, and "After task 1".
  - "**Check** the results." → PR #1 CI 1/1 passed (#154–155). This is real CI, not an AI review.
  - "Bring it all **together**." → the receipt starting "from fetched base … merged prerequisites: cart-discount-pricing (PR #1)" (#158) → both PRs merged, "2/2 merged".
- s14 "That's what **Helix** helps manage.": the Helix orchestrator card, "Complete", with the DNA mark.

### 4. Teamwork insert (insert version only, +31 s), planned. Needs a decision

- "One agent can build. Another can examine its work…" calls for a real author→reviewer pair. **The only real reviews available are in the Daybreak history (Claude Code reviewing the catalogue and cart).** Until that recording is supplied, the only option is the `cross-review` fixture, shown with a persistent **SIMULATED** chip. Builder shots get a teal frame edge; reviewer shots get a violet frame edge (the app's `--status-review`).
- No adversarial plan-review shots: the build docs say that feature is not shipped ("No synthetic intake, adversarial plan review, Output or acceptance-verifier stage is emitted").

### 5. Online store (≈0:58–1:22), planned. Footage does not fully match the words

- **Mismatch:** the narration says "product **catalogue**… shopping **cart**". The real footage here is cart **pricing** (Codex) and the **receipt** (Claude Code). It's a real store, cart work and a dependency, but there is no catalogue.
- **Faithful option A (preferred):** export the Daybreak build as a recording and use its real catalogue and cart tasks and reviews. That requires verifying task names and dependencies once it's in hand.
- **Option B:** keep the discount-codes footage and change the on-screen labels to what's actually shown ("cart pricing" / "receipt"). The narration words stay unchanged, but this needs your approval because the picture won't literally show a catalogue.
- "organises their assignments": the plan's task owners. "tracks what they need from each other": the receipt card's "Waits on Discount pricing in cart.ts". "review and testing": CI on PR #1/#2 (real). Any AI review shot needs Daybreak or the SIMULATED fixture.

### 6. Watch the work (≈1:22–1:46), planned. One close-up per line

- "Who is **building**." → Codex worker "In progress" (#83). Real.
- "Who is **checking**." → **Gap:** discount-codes has no reviewer activity. Use Daybreak (real) or the fixture's Claude Code reviewer "Approved by Claude Code" (SIMULATED chip). CI checks running (#152, "CI is running on PR #1") are real, and could stand in if "checking" can be read as testing.
- "What is **ready**." → task "Done" / CI passed, PR #1 merged. Real.
- "What is **waiting**." → receipt task "Waiting · Waits on Discount pricing in cart.ts". Real, dependency-blocked.
- "And where **your decision** can move it forward." → Inspector "Why this plan is blocked: the plan needs your approval…" + **Approve plan**, then "You approved this plan at 6:01:36 PM. Agents started from it." Real human checkpoint (#79). The replay disables the buttons; we show the real recorded transition and don't stage a click.

### 7. Stay involved (≈1:46–2:00), planned

- Select a task card → Inspector Summary / Files / PR & CI / **Why** chain ("caused by #79 plan.approved") → Tasks page → Pull requests page. All real replay.
- No Output view or conversational intake: neither is shipped (BUILD-WORKFLOW.md), so both are omitted.

### 8. Close (≈2:00–2:24), planned

- "As these tools get stronger… our ambition should grow with them." → the final plan state (2/2 merged), slowly resolving into the DNA mark.
- "You bring the **idea**." and "Helix brings the **team together**." as two separate typographic beats.
- End card: **HELIX** wordmark + DNA mark, held about 3 s, leaving room for the live demo.

## Audio

- **No voice.** Per your direction, there's no TTS or scratch voice. The words are on screen.
- **Music:** `tools/music.py` synthesizes an original temp bed: a quiet D drone under the Shaw opening, air after "Why not?", then Dm(add9)–B♭maj7–Gm7–Asus4 with a soft pulse. It uses no samples and isn't derived from "Time". It's a placeholder until a licensed or cleared track is supplied, and peaks at −10 dBFS to leave room for narration.
