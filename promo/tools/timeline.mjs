// Builds a timed timeline from script/narration.json + script/edit.json + captured footage manifests.
// No narration recording exists yet, so phrase durations come from a slow reading-pace model and are
// PROVISIONAL. When a recording arrives, replace `timing` with measured phrase in/out points.
// Usage: node tools/timeline.mjs <baseline|insert> [--until <phraseId>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const variant = process.argv[2] ?? 'baseline';
const untilIdx = process.argv.indexOf('--until');
const until = untilIdx > 0 ? process.argv[untilIdx + 1] : undefined;

const narration = read('script/narration.json');
const edit = read('script/edit.json');
const FPS = 30;
const OPENING_SILENCE = 1.5;
const TAIL = 9.0; // the HELIX end card holds before the live demo

/** Slow, deliberate reading pace: about 150 words a minute plus settle time, never under 1.4s. */
const readTime = (text) => {
  const words = text.split(/\s+/).filter(Boolean).length;
  const trailing = text.endsWith('…') ? 0.4 : 0;
  return Math.min(6.5, Math.max(1.4, 0.8 + 0.4 * words + trailing));
};

const phrases = narration.phrases.filter((p) => variant === 'insert' || !p.insert);
let t = OPENING_SILENCE;
const cues = [];
for (const p of phrases) {
  const dur = readTime(p.text);
  const gap = typeof p.pause === 'number' ? p.pause : narration.pauses[p.pause];
  cues.push({ ...p, start: +t.toFixed(3), end: +(t + dur).toFixed(3), gap });
  t += dur + gap;
  if (p.id === until) break;
}
const total = +(t + TAIL).toFixed(3);

const byId = Object.fromEntries(cues.map((c) => [c.id, c]));
const segments = [];
for (const s of edit.segments) {
  // `from` is a phrase id (start just before it) or `id+seconds` (that long after the phrase ends).
  const [fromId, after] = s.from.split('+');
  const cue = byId[fromId];
  if (!cue) continue;
  const start =
    s.type === 'shaw'
      ? 0
      : after !== undefined
        ? cue.end + Number(after)
        : Math.max(0, cue.start - edit.lead);
  segments.push({ ...s, start: +start.toFixed(3) });
}
segments.forEach((s, i) => (s.end = segments[i + 1]?.start ?? total));

const out = path.join(root, 'out');
fs.mkdirSync(out, { recursive: true });
const name = `${variant}${until ? `-until-${until}` : ''}`;
fs.writeFileSync(
  path.join(out, `timeline-${name}.json`),
  JSON.stringify({ variant, fps: FPS, total, provisional: true, cues, segments }, null, 1),
);

const stamp = (s, sep) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000),
    m = Math.floor(ms / 60000) % 60,
    sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`;
};
// Captions stay up through short pauses and clear during long ones, so silence reads as silence.
const captionEnd = (c, i) => (c.gap <= 1.0 && cues[i + 1] ? cues[i + 1].start - 0.12 : c.end + 0.6);
fs.writeFileSync(
  path.join(out, `subtitles-${name}.srt`),
  cues
    .map(
      (c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(captionEnd(c, i), ',')}\n${c.text}\n`,
    )
    .join('\n'),
);
const segFor = (c) => segments.find((s) => c.start >= s.start && c.start < s.end);
/** What a segment shows, for the cue sheet: real replay stills, Daybreak designs or typography. */
const describe = (s) => {
  if (!s?.panes) return [s?.type === 'evidence' ? 'recorded facts card' : 'typography', ''];
  const refs = [...new Set(s.panes.flatMap((p) => (p.states ?? []).map((x) => x.still)))];
  const kinds = [...new Set(s.panes.map((p) => p.kind).filter(Boolean))];
  const kind = [
    refs.some((r) => r.startsWith('db')) && 'Helix UI replaying the invented Daybreak build',
    refs.some((r) => r.startsWith('dc/')) && 'real Helix replay (discount-codes run)',
    refs.some((r) => r.startsWith('daybreak/')) && 'Daybreak storefront design images',
    kinds.length && `stage graphics (${kinds.join(', ')})`,
  ]
    .filter(Boolean)
    .join(' + ');
  return [kind, refs.join(' > ')];
};
fs.writeFileSync(
  path.join(out, `cues-${name}.csv`),
  ['id,scene,start,end,phrase,segment,source,footage']
    .concat(
      cues.map((c) => {
        const s = segFor(c);
        const [kind, refs] = describe(s);
        return [
          c.id,
          c.scene,
          stamp(c.start, '.'),
          stamp(c.end, '.'),
          JSON.stringify(c.text),
          s?.id ?? '',
          kind,
          refs,
        ].join(',');
      }),
    )
    .join('\n') + '\n',
);
console.log(
  `${name}: ${cues.length} phrases, ${total.toFixed(1)}s (${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')})`,
);
