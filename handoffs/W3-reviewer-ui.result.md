# W3: cross-agent reviewer UI

## Summary

Implemented on `agent/reviewer-ui` against the frozen contracts and `fixtures.crossReviewRun`.

- Reviewer sessions never appear as separate board cards. Worker cards show a compact reviewer badge and review chip; selecting it opens that worker's Review tab.
- Review shows the current verdict, summary, severity-grouped findings, file/line locations, full head SHA, and a button to open the reviewer's Activity conversation. Previous verdicts are collapsed and scoped to their original heads.
- A moved PR head displays a pending review of the new head, including when the previous verdict approved. The Summary merge area explains when review is pending; `deriveStatus` continues to control merge eligibility.
- Reviewer headers identify the worker and PR and navigate back to the worker's Review tab. The existing chat renderer is reused.
- Plan nodes show the same review chip as the board.
- Timeline sentences name the reviewer and worker task, count findings, and use review/done/failed/needs tones. Verdict provenance is `agent`; requests, abandonment, and routed feedback remain `helix`. Worker Why history includes review events emitted on the reviewer. The existing timeline Why chain follows feedback → verdict → request → passing CI.
- The scenario switcher now includes **Cross review**. `?demo=cross-review` replays the built-in fixture without fetching a recording. The two existing recording files and their default URL behavior are unchanged.

## Files

All implementation changes are under `apps/web/src/`:

- `app/App.tsx`: Inspector tab navigation and session selection.
- `app/Board.tsx`: worker review action.
- `app/Inspector.tsx`: Review tab, waiting message, reviewer header/back navigation, worker Why history.
- `app/PlanView.tsx`: review chip and space for the extra row.
- `app/RecordingControl.tsx`: third scenario.
- `app/ReviewChip.tsx`, `app/ReviewSection.tsx`, `app/Review.module.css`: shared web review presentation.
- `data/crossReview.ts`: display facts, reviewer target, and related worker history.
- `data/describe.ts`: event descriptions, tones, provenance, card filtering, findings count.
- `data/demoScenarios.ts`, `data/useHelixSource.ts`: scenario selection and built-in fixture source.
- `app/crossReview.test.tsx`, `data/crossReview.test.ts`, `data/demoScenarios.test.tsx`: fixture-based rendering and data tests.

No changes to contracts, backend paths, `packages/ui`, root configuration, dependencies, lockfile, or recordings. No commit or push.

## Decisions and UX trade-offs

- Reused the existing `SessionCard.action` slot, agent badges, buttons, tabs, and theme tokens; no new reusable primitive was necessary.
- Review is a dedicated Inspector tab, with a shortcut chip in Summary. Internal navigation uses the app's existing button pattern and opens the reviewer's Activity tab directly.
- Stale chips explicitly read “Claude Code review pending · new head”; the previous verdict moves into a closed native disclosure. All history is bounded by the replay cursor, so future verdicts cannot leak into earlier moments.
- Plan graph rows expand only when a node has a review. The chip inside the existing node button is a noninteractive span, avoiding nested buttons; clicking the node retains its normal worker navigation.
- GitHub review is labeled separately from cross-agent review in Summary. An abandoned review disappears from the chip according to projection and remains explainable in Why.
- `TimelineBar.tsx` and `useDemoStream.ts` needed no changes: the existing causal traversal is correct, and mapped review requests/verdicts/feedback already linger for 1,600 ms at 1×.

## Verification

- `pnpm.cmd check` — **exit 0**: formatting, typechecking, lint, tests, and architecture boundaries passed (223 modules).
- `pnpm.cmd --filter @helix/web build:demo` — **exit 0**: Vite built the static demo successfully (2,165 modules). Vite reported its non-fatal chunk-size warning (main JavaScript about 568 kB before gzip).
- `pnpm.cmd --filter @helix/web test` — **55 passed, 0 failed, 0 skipped**, across 6 files.
- New tests: **40 passed** across 3 files: 17 review data tests, 15 component render tests, and 8 demo scenario tests. The existing 15 web tests also pass.
- Full workspace test totals from the check: **781 passed, 22 skipped**, across 72 passing and 7 skipped test files. Tooling adds **20 passed, 0 failed**: **801 passing tests overall**, plus 22 skipped.

| Package | Passed | Skipped |
| --- | ---: | ---: |
| contracts | 224 | 0 |
| core | 137 | 0 |
| harness | 126 | 2 |
| daemon | 66 | 4 |
| scm | 56 | 1 |
| web | 55 | 0 |
| storage | 38 | 0 |
| cli | 32 | 0 |
| pty-host | 17 | 6 |
| git | 15 | 9 |
| api-client | 10 | 0 |
| testing | 5 | 0 |
| tooling | 20 | 0 |

Unchanged workspace tasks used the shared Turbo cache; the changed web checks ran afresh. Turbo logged non-fatal cache I/O permission warnings, but all required commands exited 0. `git diff --check` also passed.

## Known gaps

- Interactive browser and visual QA could not be completed: browser automation timed out opening the local page through both the in-app browser and Chrome. Vite started successfully at `http://127.0.0.1:5318/`; rendering, navigation labels, findings, replay history, and scenario selection are covered by the existing server-render/data test style. Live click behavior and theme/layout appearance still need a manual browser pass.
- Backend integration was intentionally not exercised; this work uses only the frozen projection/event contracts and built-in fixture.

## Contract requests

None. No `CONTRACT-REQUEST` is needed.
