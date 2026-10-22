Implemented and left uncommitted. Full handoff: [W1-core.result.md](C:/Users/Wil/Documents/Projects/helix-wt/w1-core/handoffs/W1-core.result.md).

**Summary:** Implemented `HelixCore`, including orchestration, feedback routing, approvals, plans, recording delegation, recovery, and safe cleanup.

**Public API:** `createHelixCore(deps: CoreDeps): HelixCore`; exports `CoreDeps`, `CoreLog`, and `PACKAGE_NAME`.

**Files:** Changes are confined to `packages/core/**` and the result file. Frozen contracts remain unchanged.

**New dependencies:** None.

**Decisions:** Ordered command processing, event-derived state, guarded squash merges, and explicit reattach opt-in.

**CONTRACT-REQUESTs:** Durable resume metadata, reattach capability, delivery acknowledgments, and turn IDs. Workarounds are documented.

**Verification:** `pnpm check` exited **0**. **35 core tests**, **234 total tests**, and **80-module boundary validation** passed. Final supplemental lint and whitespace checks passed.

**Known gaps / follow-ups:** Real-adapter integration remains. Frozen v1 cannot guarantee exactly-once delivery or atomic recovery across external side effects and event persistence.