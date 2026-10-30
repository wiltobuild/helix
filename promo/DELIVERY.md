# Delivery notes

## Files (rendered into `promo/out/`, regenerate with the tools)

| File                                     | What                                                             |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `helix-promo-baseline-captioned.mp4`     | Baseline cut with captions, 2:24, 1920×1080, 30 fps, H.264 + AAC |
| `helix-promo-baseline-clean.mp4`         | Same cut without captions                                        |
| `subtitles-baseline.srt`                 | Captions for the clean baseline                                  |
| `cues-baseline.csv`                      | Cue sheet: each phrase → time → segment → footage                |
| `helix-promo-insert-*.mp4`, `*-insert.*` | The same four files with the teamwork insert, 2:56               |

The editable project lives in this folder: `script/` (words, shots, edit list), `tools/` (capture, edit list, timeline, music, render) and `stage/` (the renderer).

## Simulated material

None. Every Helix screen is a still from the replay of a real recorded run. The cross-review example fixture is not used.

## Claims and gaps to know about

- **Helix footage is the discount-codes store build, not Daybreak.** Daybreak appears through the five design images you supplied and the review facts from `docs/daybreak-review-failure.md`. No Daybreak Helix recording was available to capture.
- **Catalogue and cart callouts point at the Daybreak designs and name no agent.** I could not verify which agent built Daybreak's catalogue and which built its cart.
- **The Daybreak images are labelled "storefront designs".** I did not verify whether they are the shipped site or design options.
- **"Review and testing" and "Who is checking" show CI checks.** The recorded discount-codes run had no AI review. The only real AI reviews shown are the Daybreak approvals, quoted on the insert's record card. That card cites the run record rather than showing Helix screens.
- **No narration.** Timing is a reading-pace model, so a recorded voice would need a re-time.
- **Music is an original synthesized temp bed** (`tools/music.py`), not "Time" or anything derived from it. Replace it with a licensed or cleared track before distribution if you want a different score.
- **Codex and Claude Code appear only as the app shows them** (names and their in-app icons). Nothing suggests endorsement or partnership.
