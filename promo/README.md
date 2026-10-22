# Helix promo film

A 64-second promo for Helix, styled after the [PRD](../docs/PRD.html): same dark palette, type, two-strand helix (teal = Claude Code, coral = Codex), and the password-reset example run.

- **[`helix-promo.mp4`](helix-promo.mp4)**: the rendered film, 1920×1080, 30 fps, with score.
- **`film.html`**: the film as a web page. Every frame is a pure function of time; open it and press Play (needs `score.mp3` beside it).
- **`score.py`**: synthesizes the score (D minor, 120 BPM) with numpy. Its cue sheet lines up with the scene timings in `film.html`.
- **`render.mjs`**: steps the page frame by frame in headless Chromium and muxes the frames with the score.

| Time | Scene |
|---|---|
| 0–6 s | Terminal chaos: agents in parallel, nobody can follow them |
| 6–16 s | The trust gap (Stack Overflow 2025: 46% distrust, 84% use) |
| 16–24 s | The drop: the helix forms, title reveal |
| 24–32 s | Prompt → orchestrator → plan graph with worktrees |
| 32–42 s | The board runs: CI fails, routes back to Codex, Helix asks for approval |
| 42–50 s | Tape-stop rewind, then the Why panel and its causal chain |
| 50–56 s | Vitamin, painkiller, magic moment |
| 56–64 s | Finale |

## Rebuild

```sh
cd promo
npm install          # playwright, uses the preinstalled Chromium
npm run score        # score.py -> score.mp3 (for film.html)
npm run render       # -> helix-promo.mp4 (about 5 minutes on 4 cores)
node render.mjs out.mp4 --stills 17,35,46   # PNG stills for quick checks
```

Requires Node 18+, Python 3 with numpy, and ffmpeg.
