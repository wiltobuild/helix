"""Puts the cue sheet into the videos.

1. <variant>-with-cues.mp4: the clean video plus the narration as a switchable subtitle track
   (on by default) and one chapter per shot, named by phrase ID and words. No re-encode.
2. <variant>-rehearsal.mp4: the captioned video with each cue's ID, timecode and shot burned in
   at the top-left, plus a running clock, for rehearsing or recording against the cue sheet.

Usage: python3 tools/embed-cues.py baseline|insert
"""
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "out"
variant = sys.argv[1] if len(sys.argv) > 1 else "baseline"
tl = json.loads((out / f"timeline-{variant}.json").read_text())
cues, segments, total = tl["cues"], tl["segments"], tl["total"]


def stamp(s):
    m, sec = divmod(s, 60)
    return f"{int(m):02d}:{sec:04.1f}"


# Chapters: one per shot, titled by the first phrase that plays over it.
meta = [";FFMETADATA1"]
for seg in segments:
    first = next((c for c in cues if seg["start"] - 0.6 <= c["start"] < seg["end"]), None)
    label = f"{first['id']} · {first['text']}" if first else {"shaw": "Opening quote", "helix-intro": "HELIX title", "end": "HELIX end card"}.get(seg["id"], seg["id"])
    if seg["id"] == "shaw":
        label = "s01 · Opening quote (George Bernard Shaw)"
    meta += [
        "[CHAPTER]",
        "TIMEBASE=1/1000",
        f"START={int(seg['start'] * 1000)}",
        f"END={int(min(seg['end'], total) * 1000)}",
        "title=" + f"{label} [{seg['id']}]".replace("=", r"\=").replace(";", r"\;").replace("#", r"\#"),
    ]
(out / f"chapters-{variant}.txt").write_text("\n".join(meta) + "\n")

subprocess.run(
    [
        "ffmpeg", "-v", "error", "-y",
        "-i", str(out / f"helix-promo-{variant}-clean.mp4"),
        "-i", str(out / f"subtitles-{variant}.srt"),
        "-i", str(out / f"chapters-{variant}.txt"),
        "-map", "0:v", "-map", "0:a", "-map", "1:s",
        "-map_metadata", "2", "-map_chapters", "2",
        "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text",
        "-metadata:s:s:0", "language=eng", "-metadata:s:s:0", "title=Narration",
        "-disposition:s:0", "default",
        "-movflags", "+faststart",
        str(out / f"helix-promo-{variant}-with-cues.mp4"),
    ],
    check=True,
)

# Rehearsal overlay: an ASS track with the active cue's ID, phrase timing and shot.
def ass_time(s):
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{sec:05.2f}"


lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Cue,DejaVu Sans Mono,24,&H00F2EBE6,&H00F2EBE6,&H00000000,&HB0100B08,0,0,0,0,100,100,0,0,3,10,0,7,24,24,20,1",
    "", "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
]
for i, c in enumerate(cues):
    end = cues[i + 1]["start"] if i + 1 < len(cues) else total
    seg = next((s for s in segments if s["start"] <= c["start"] < s["end"]), segments[-1])
    text = (
        f"{{\\c&H7FC243&}}CUE {c['id']}{{\\c&HF2EBE6&}}  {stamp(c['start'])} → {stamp(c['end'])}"
        f"  ·  scene {c['scene']}  ·  shot {seg['id']}"
    )
    lines.append(f"Dialogue: 0,{ass_time(c['start'])},{ass_time(end)},Cue,,0,0,0,,{text}")
ass = out / f"cues-{variant}.ass"
ass.write_text("\n".join(lines) + "\n")

clock = (
    "drawtext=font='DejaVu Sans Mono':fontsize=24:fontcolor=0xE6EBF2:box=1:boxcolor=0x080B10B0:boxborderw=10:"
    "x=w-tw-24:y=20:text='%{pts\\:hms}'"
)
subprocess.run(
    [
        "ffmpeg", "-v", "error", "-y",
        "-i", str(out / f"helix-promo-{variant}-captioned.mp4"),
        "-vf", f"ass={ass},{clock}",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "copy", "-movflags", "+faststart",
        str(out / f"helix-promo-{variant}-rehearsal.mp4"),
    ],
    check=True,
)
print("wrote", f"helix-promo-{variant}-with-cues.mp4", "and", f"helix-promo-{variant}-rehearsal.mp4")
