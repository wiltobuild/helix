**Summary:** Implemented both adapters and the scripted fake harness. Changes remain uncommitted.

**Public API:** `createHarness`, `detectAll`, `createFakeHarness`, and `passwordResetApiScript`. Exact signatures and options are in the [handoff report](C:/Users/Wil/Documents/Projects/helix-wt/w1-harness/handoffs/W1-harness.result.md).

**Files:** Only owned paths and the result file changed.

**New dependencies:** None.

**Decisions:** Codex uses app-server; Windows uses Job Objects for process-tree cleanup; resumed sessions wait for a new message.

**CONTRACT-REQUESTs:** Approval cancellation events and harness exit code/signal metadata. Contracts remain unchanged.

**Verification:** Root `pnpm check` exited **0**. **242 tests passed; 2 gated smoke tests skipped.** Boundaries passed across 95 modules.

**Known gaps / follow-ups:** Both CLIs are signed out, so fixtures are synthetic. Real-agent smoke runs and Linux CI verification remain.