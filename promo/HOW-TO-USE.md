# Using the promo files

## Which video to play

- **Presenting live with no voice-over:** play `helix-promo-baseline-captioned.mp4` (3:06). The words are on screen, so the room can read along. Use the `insert` file instead if you want the extra teamwork passage (3:38).
- **Narrating it yourself, or uploading somewhere with its own caption system** (YouTube, Canvas, Google Drive, a class LMS): use `helix-promo-baseline-clean.mp4` plus `subtitles-baseline.srt`.
  - **YouTube:** Studio → Subtitles → Add language → Upload file → "With timing" → choose the `.srt`.
  - **Google Drive:** ⋮ → Manage caption tracks → Add.
  - **VLC or QuickTime:** keep the `.srt` beside the `.mp4` with the same base name, or drag it onto the player.
- **Editing it further** (Premiere, DaVinci Resolve, CapCut, iMovie): import the clean `.mp4`, then import the `.srt` as a caption track. Every caption lands at its time, and you can restyle or retime it there.

## The cue sheet (`cues-baseline.csv`, `cues-insert.csv`)

Open it in Excel, Numbers or Google Sheets. There's one row per narration phrase:

| Column         | Meaning                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------- |
| `id`           | Phrase ID (`s01`…`s35` baseline, `t01`…`t07` the teamwork insert)                           |
| `scene`        | Storyboard scene number (1 = Shaw quote … 8 = close)                                        |
| `start`, `end` | When the phrase's caption appears and when its reading time ends (hh:mm:ss.mmm)             |
| `phrase`       | The exact words                                                                             |
| `segment`      | The visual shot under it, e.g. `vale-intake`, `watch` (12-agent pan), `assignments` (Board) |
| `source`       | What the picture is made of (Helix UI replay, Daybreak images, stage graphics)              |
| `footage`      | The stills used, if any                                                                     |

Use it to:

1. **Rehearse or record narration in sync.** Read each phrase at its `start`. If you record a voice-over, note your real in and out points in two new columns. I can then re-time the film to your recording with `tools/timeline.mjs`, so the picture follows your voice.
2. **Find a moment to change.** Tell me the `id` or `segment` (for example, "make `waiting` longer" or "change the V.A.L.E. line at `s27`") and I can edit exactly that shot.
3. **Cut a shorter version.** Pick a range of rows, and the `start` of the first and the `end` of the last give you the in and out points to trim in any editor.

## The other files

- `STORYBOARD.md` describes each scene.
- `DELIVERY.md` lists what's staged for the film.
- `README.md` has the commands to rebuild everything.
