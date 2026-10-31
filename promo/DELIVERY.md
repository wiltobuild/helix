# Delivery notes

## Files (rendered into `promo/out/`, regenerate with the tools)

| File                                     | What                                                             |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `helix-promo-baseline-captioned.mp4`     | Baseline cut with captions, 3:06, 1920×1080, 30 fps, H.264 + AAC |
| `helix-promo-baseline-clean.mp4`         | Same cut without captions                                        |
| `subtitles-baseline.srt`                 | Captions for the clean baseline                                  |
| `cues-baseline.csv`                      | Cue sheet: each phrase → time → segment → source                 |
| `helix-promo-insert-*.mp4`, `*-insert.*` | The same four files with the teamwork insert, 3:38               |

## What this cut shows

- **A new build: the Daybreak storefront.** Twelve new agents work on it (Designer, Product Catalogue Engineer, Shopping Bag Engineer, Checkout Engineer, Subscriptions Engineer and others), each with a Codex or Claude Code reviewer. No worker cards from earlier cuts are reused.
- **New app features, in the real upgraded UI:**
  - guided-intake brief
  - Codex plan review (changes requested, then passed)
  - plan approval
  - Design workspace with the three Daybreak concepts and an approved palette
  - cross-agent review with a requested change and a re-review
  - Output workspace showing the assembled storefront
- **V.A.L.E.,** shown connected to Helix through the Codex Dot extension:
  - It interviews you by voice and sends each answer into Helix's guided intake.
  - It reports the plan and the plan review.
  - It asks for and relays your plan approval.
  - It approves the design on your word.
  - It streams live updates as agents work.

## What is staged for the film (not shown on screen)

- **The Daybreak build's events are invented.** `tools/make-recording.ts` writes them, validated against the app's own schemas. The app replays them exactly as it would a real run, so the screens are the real UI, but no agents ran.
- **Output can't open a preview server during replay.** The capture tool places the first Daybreak design image inside Output's preview frame.
- **V.A.L.E. is stage graphics:** the orb, waveform, transcript, intake card, live-update feed and light beams. The repo's Dot adapter (`packages/dot-adapter`) is read-only today. It has no write, voice, messaging, plan or approval surface, so V.A.L.E. driving intake, approving the plan and messaging agents is a depiction of the intended product, not shipped behaviour.
- **There is no audio voice.** V.A.L.E.'s conversation appears as an on-screen transcript.
- **The score is original and synthesized** (`tools/music.py`).
