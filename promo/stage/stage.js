// Deterministic promo stage: window.load(timeline, options) then await window.renderAt(seconds).
// Every visual is a pure function of time, so any frame can be rendered in any order.
'use strict';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const ramp = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;

/** Stage rectangles for panes. Captions live below y 862, so no pane reaches them. */
const RECTS = {
  full: { x: 96, y: 56, w: 1728, h: 798 },
  left: { x: 96, y: 56, w: 1060, h: 798 },
  right: { x: 1180, y: 56, w: 644, h: 798 },
  third1: { x: 96, y: 56, w: 540, h: 798 },
  third2: { x: 690, y: 56, w: 540, h: 798 },
  third3: { x: 1284, y: 56, w: 540, h: 798 },
};
const STRAND = {
  codex: 'var(--codex)',
  claude: 'var(--claude)',
  orch: 'var(--orch)',
  review: 'var(--review)',
};
const SOURCES = {
  dc: { dir: '../footage/stills/dc/', ext: '.jpg', size: { w: 1920, h: 1080 } },
  daybreak: { dir: '../footage/daybreak/', ext: '.webp', size: null },
};
const XFADE = 0.7;
const STATE_FADE = 0.45;

let TL;
let OPT;
const sizes = new Map();

/** The accepted DNA mark: same geometry as packages/ui HelixLogo (teal/rust strands, neutral rungs). */
function dnaSvg(size, phase) {
  const wavelength = 60;
  const amplitude = 10;
  const pts = Array.from({ length: 25 }, (_, i) => {
    const p = (i * Math.PI) / 6;
    return { x: 2 + i * 5, y: Math.sin(p) * amplitude, depth: Math.cos(p) };
  });
  const r3 = (v) => Number(v.toFixed(3));
  const strand = (sign) => {
    let d = 'M2 16';
    const q = wavelength / 4;
    const tan = (amplitude * Math.PI) / 6;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 2;
      const b = a + Math.PI / 2;
      const x = 2 + i * q;
      d += ` C${x + q / 3} ${r3(16 + sign * (amplitude * Math.sin(a) + tan * Math.cos(a)))},${x + (2 * q) / 3} ${r3(16 + sign * (amplitude * Math.sin(b) - tan * Math.cos(b)))},${x + q} ${r3(16 + sign * amplitude * Math.sin(b))}`;
    }
    return d;
  };
  let dots = '';
  for (const front of [false, true])
    pts.forEach(({ x, y, depth }) => {
      for (const sign of [1, -1]) {
        if (sign * depth >= 0 !== front) continue;
        dots += `<circle cx="${x}" cy="${16 + sign * y}" r="${1.3 + 0.6 * sign * depth}" opacity="${0.625 + 0.275 * sign * depth}" fill="${sign === 1 ? '#43c2bb' : '#d97757'}"/>`;
      }
    });
  const rungs = pts
    .filter((_, i) => i % 2 === 1)
    .map(
      ({ x, y }) =>
        `<line x1="${x}" x2="${x}" y1="${16 + y}" y2="${16 - y}" stroke="#2e394a" stroke-width="1" opacity="0.8"/>`,
    )
    .join('');
  return `<svg width="${size * 2}" height="${size}" viewBox="0 0 64 32" fill="none"><svg x="2" y="2" width="60" height="28" viewBox="2 2 60 28" overflow="hidden"><g transform="translate(${-phase} 0)">${rungs}<path d="${strand(1)}" stroke="#43c2bb" stroke-width="1.5" stroke-linecap="round" opacity="0.85"/><path d="${strand(-1)}" stroke="#d97757" stroke-width="1.5" stroke-linecap="round" opacity="0.85"/>${dots}</g></svg></svg>`;
}
const dnaPhase = (t) => ((t / 8.726646) * 60) % 60;

const cue = (id) => TL.cues.find((c) => c.id === id);
/** Segment-local time of a marker: a number, or a cue id (optionally `id+offset`). */
function localAt(seg, at) {
  if (typeof at === 'number') return at;
  const [id, off] = String(at).split('+');
  const c = cue(id);
  return c ? c.start - seg.start + Number(off ?? 0) : Infinity;
}

function shaw(t) {
  const [c1, c2, c3, c4, c5] = ['s01', 's02', 's03', 's04', 's05'].map(cue);
  const line = (text, top, c, cls = '') => {
    if (!c) return '';
    const k = easeOut(ramp(t, c.start, c.start + 1.1));
    return `<div class="quote ${cls}" style="top:${top}px;opacity:${k};transform:translateY(${(1 - k) * 18}px)">${text}</div>`;
  };
  let html = '';
  // Stanza one clears before the dream begins.
  const out1 = c3 ? 1 - ramp(t, c3.start - 0.9, c3.start - 0.1) : 1;
  html += `<div class="layer" style="opacity:${out1}">${line('You see things…', 380, c1)}${line('and you say, ‘<em class="why">Why?</em>’', 480, c2)}</div>`;
  if (c3 && t >= c3.start - 0.2) {
    let big = '';
    if (c5) {
      const k = easeOut(ramp(t, c5.start, c5.start + 1.6));
      big = `<div class="quote big" style="top:520px;opacity:${k};transform:scale(${lerp(1.06, 1, k)})"><span class="whynot">‘Why not?’</span></div>`;
    }
    html += `<div class="layer">${line('But I dream things that never were…', 300, c3)}${line('and I say…', 400, c4)}${big}`;
    if (c5) {
      const a = easeOut(ramp(t, c5.end + 0.3, c5.end + 1.5));
      html += `<div class="attrib" style="opacity:${a}">George Bernard Shaw</div>`;
      const m = ease(ramp(t, c5.end + 1.0, c5.end + 2.6)) * 0.55;
      html += `<div class="mark" style="opacity:${m}">${dnaSvg(44, dnaPhase(t))}</div>`;
    }
    html += `</div>`;
  }
  return html;
}

const srcOf = (ref) => {
  const [source, name] = ref.split('/');
  const s = SOURCES[source];
  return { url: s.dir + name + s.ext, size: s.size ?? sizes.get(s.dir + name + s.ext) };
};

/** One framed window onto real footage: crossfades between states, eases its crop c0 -> c1. */
function pane(seg, p, t) {
  const r = typeof p.rect === 'string' ? RECTS[p.rect] : (p.rect ?? RECTS.full);
  const local = t - seg.start;
  const k = ease(ramp(t, seg.start, seg.end));
  const c1 = p.c1 ?? p.c0;
  const w = lerp(p.c0.w, c1.w, k);
  const x = lerp(p.c0.x, c1.x, k);
  const y = lerp(p.c0.y, c1.y, k);
  const scale = r.w / w;
  const states = p.states.map((s) => ({ ...s, at: localAt(seg, s.at ?? 0) }));
  let imgs = '';
  states.forEach((s, i) => {
    if (local < s.at) return;
    const next = states[i + 1];
    if (next && local >= next.at + STATE_FADE) return;
    const a = i === 0 ? 1 : easeOut(ramp(local, s.at, s.at + STATE_FADE));
    const { url, size } = srcOf(s.still);
    imgs += `<img src="${url}" style="width:${size.w}px;height:${size.h}px;opacity:${a};transform:translate(${-x * scale}px,${-y * scale}px) scale(${scale})">`;
  });
  let callouts = '';
  for (const c of p.callouts ?? []) {
    const at = localAt(seg, c.at ?? 0);
    const until = c.until === undefined ? Infinity : localAt(seg, c.until);
    const a = Math.min(easeOut(ramp(local, at, at + 0.6)), 1 - ramp(local, until - 0.3, until));
    if (a <= 0) continue;
    const px = (c.x - x) * scale;
    const py = (c.y - y) * scale;
    const anchor =
      c.align === 'right' ? 'translateX(-100%)' : c.align === 'center' ? 'translateX(-50%)' : '';
    callouts += `<div class="callout" style="left:${px}px;top:${py}px;opacity:${a};transform:${anchor} translateY(${(1 - a) * 10}px)"><span class="dot" style="background:${STRAND[c.strand] ?? 'var(--text-2)'}"></span>${c.text}</div>`;
  }
  const edge = p.edge
    ? `border-color:${STRAND[p.edge]};box-shadow:0 0 0 1px ${STRAND[p.edge]},0 30px 80px rgb(0 0 0 / 0.55)`
    : '';
  const chip = p.chip
    ? `<div class="chip ${p.chipAt ?? 'tl'}"><span class="dot"></span>${p.chip}</div>`
    : '';
  return `<div class="frame" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;${edge}">${imgs}${callouts}${chip}</div>`;
}

function footage(t, seg) {
  return seg.panes.map((p) => pane(seg, p, t)).join('');
}

/** Large typographic beats, one or more lines revealed at their cues. */
function title(t, seg) {
  const local = t - seg.start;
  let html = '';
  for (const l of seg.lines) {
    const at = localAt(seg, l.at ?? 0);
    const k = easeOut(ramp(local, at, at + 1.0));
    const out =
      l.until === undefined
        ? 1
        : 1 - ramp(local, localAt(seg, l.until) - 0.6, localAt(seg, l.until));
    html += `<div class="quote ${l.cls ?? ''}" style="top:${l.top}px;opacity:${Math.min(k, out)};transform:translateY(${(1 - k) * 18}px)">${l.html}</div>`;
  }
  if (seg.mark) {
    const m =
      ease(ramp(local, localAt(seg, seg.mark.at), localAt(seg, seg.mark.at) + 1.6)) *
      (seg.mark.opacity ?? 0.8);
    html += `<div class="mark" style="top:${seg.mark.top}px;opacity:${m}">${dnaSvg(seg.mark.size ?? 44, dnaPhase(t))}</div>`;
  }
  return html;
}

/** A record card quoting real recorded facts, each row revealed at its cue. */
function evidence(t, seg) {
  const local = t - seg.start;
  const rows = seg.rows
    .map((row) => {
      const at = localAt(seg, row.at ?? 0);
      const a = easeOut(ramp(local, at, at + 0.7));
      return `<div class="row" style="opacity:${a};transform:translateX(${(1 - a) * 16}px)"><span class="dot" style="background:${STRAND[row.strand] ?? 'var(--text-2)'}"></span><div><div class="what">${row.text}</div><div class="src">${row.source}</div></div></div>`;
    })
    .join('');
  const edge = seg.edge ? `border-color:${STRAND[seg.edge]}` : '';
  return `<div class="evidence" style="${edge}"><div class="eyebrow">${seg.eyebrow}</div><div class="head">${seg.heading}</div>${rows}<div class="foot">${seg.footnote}</div></div>`;
}

function endCard(t, seg) {
  const local = t - seg.start;
  const a = easeOut(ramp(local, 0.3, 1.8));
  const w = easeOut(ramp(local, 1.0, 2.4));
  return `<div class="mark" style="top:330px;opacity:${a}">${dnaSvg(80, dnaPhase(t))}</div><div class="wordmark" style="opacity:${w};letter-spacing:${lerp(0.5, 0.32, w)}em">HELIX</div>`;
}

const RENDER = { shaw, footage, title, evidence, end: endCard };

/** Cues set as on-screen typography (Shaw, title beats) are not repeated as captions. */
function ownedByTitle(c) {
  const seg = TL.segments.find((s) => c.start >= s.start && c.start < s.end);
  return seg && (seg.type === 'shaw' || (seg.type === 'title' && !seg.captions));
}

function captionHtml(t) {
  if (OPT.clean) return '';
  const until = (c, n) => {
    const next = TL.cues[n + 1];
    return c.gap <= 1.0 && next ? next.start - 0.12 : c.end + 0.6;
  };
  const i = TL.cues.findIndex((c, n) => t >= c.start && t < until(c, n));
  const c = TL.cues[i];
  if (!c || ownedByTitle(c)) return '';
  const end = until(c, i);
  const a = Math.min(easeOut(ramp(t, c.start, c.start + 0.3)), 1 - ramp(t, end - 0.25, end));
  let text = c.text;
  for (const e of c.emphasis ?? []) {
    const cls = /claude/i.test(e)
      ? 'claude'
      : /codex/i.test(e)
        ? 'codex'
        : /helix/i.test(e)
          ? 'helix'
          : '';
    text = text.replace(e, `<b class="${cls}">${e}</b>`);
  }
  return `<span style="opacity:${a}">${text}</span>`;
}

window.load = async (timeline, options = {}) => {
  TL = timeline;
  OPT = options;
  await document.fonts.ready;
  const refs = new Set();
  for (const seg of TL.segments)
    for (const p of seg.panes ?? []) for (const s of p.states) refs.add(s.still);
  await Promise.all(
    [...refs].map(async (ref) => {
      const [source, name] = ref.split('/');
      const s = SOURCES[source];
      const url = s.dir + name + s.ext;
      const img = new Image();
      img.src = url;
      await img.decode();
      if (!s.size) sizes.set(url, { w: img.naturalWidth, h: img.naturalHeight });
    }),
  );
  document.getElementById('proof').textContent = options.watermark ?? '';
};

window.renderAt = async (t) => {
  let html = '';
  TL.segments.forEach((seg, i) => {
    const prev = TL.segments[i - 1];
    // Each segment fades in over the previous one; the outgoing one stays until covered.
    if (t < seg.start || t >= seg.end + XFADE) return;
    const a = prev ? ease(ramp(t, seg.start, seg.start + XFADE)) : 1;
    html += `<div class="layer" style="opacity:${a}">${RENDER[seg.type](t, seg)}</div>`;
  });
  document.getElementById('layers').innerHTML = html;
  document.getElementById('caption').innerHTML = captionHtml(t);
  await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
};
