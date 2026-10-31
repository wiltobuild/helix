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
  wide: { x: 96, y: 186, w: 1728, h: 520 },
  left: { x: 96, y: 56, w: 1060, h: 798 },
  right: { x: 1180, y: 56, w: 644, h: 798 },
  third1: { x: 96, y: 56, w: 540, h: 798 },
  third2: { x: 690, y: 56, w: 540, h: 798 },
  third3: { x: 1284, y: 56, w: 540, h: 798 },
  vale: { x: 96, y: 56, w: 600, h: 798 },
  app: { x: 724, y: 56, w: 1100, h: 798 },
  valeTalk: { x: 96, y: 56, w: 820, h: 798 },
  intake: { x: 946, y: 56, w: 878, h: 798 },
};
/** Default 3D drift per pane: rotateY eases from ry[0] to ry[1] degrees across the segment. */
const TILT = {
  full: [3.2, -3.2],
  wide: [4, -4],
  left: [5, 2],
  right: [-5, -2],
  third1: [7, 4],
  third2: [0, 0],
  third3: [-7, -4],
};
const STRAND = {
  codex: 'var(--codex)',
  claude: 'var(--claude)',
  orch: 'var(--orch)',
  review: 'var(--review)',
};
const GLOW = {
  codex: '67 194 187',
  claude: '217 119 87',
  orch: '227 165 63',
  review: '169 140 247',
};
const SOURCES = {
  dc: { dir: '../footage/stills/dc/', ext: '.jpg', size: { w: 1920, h: 1080 } },
  lap: { dir: '../footage/stills/lap/', ext: '.jpg', size: { w: 5600, h: 1080 } },
  db: { dir: '../footage/stills/db/', ext: '.jpg', size: { w: 1920, h: 1080 } },
  dbw: { dir: '../footage/stills/dbw/', ext: '.jpg', size: { w: 5600, h: 1080 } },
  daybreak: { dir: '../footage/daybreak/', ext: '.webp', size: null },
};
/** How strongly the living DNA backdrop shows behind each kind of segment. */
const BACKDROP = { shaw: 0.55, end: 1, title: 0.9, evidence: 0.45, footage: 0.4 };
const XFADE = 1.4;
const STATE_FADE = 0.85;

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

/** A huge, slow double helix drifting behind everything, in the mark's teal and coral. */
function backdrop(t, level) {
  if (level <= 0.01) return '';
  const W = 2400;
  const cy = 540;
  const amp = 210;
  const wave = 1100;
  const shift = t * 38;
  let rungs = '';
  let dots = '';
  for (let x = -60; x <= W + 60; x += 46) {
    const ph = ((x + shift) / wave) * Math.PI * 2;
    const y = Math.sin(ph) * amp;
    const depth = Math.cos(ph);
    rungs += `<line x1="${x}" x2="${x}" y1="${cy + y}" y2="${cy - y}" stroke="#8fa3bd" stroke-width="1.4" opacity="${0.1 + 0.08 * Math.abs(depth)}"/>`;
    for (const sign of [1, -1]) {
      const d = sign * depth;
      dots += `<circle cx="${x}" cy="${cy + sign * y}" r="${5 + 4 * d}" fill="${sign === 1 ? '#43c2bb' : '#d97757'}" opacity="${0.35 + 0.35 * d}"/>`;
    }
  }
  const tilt = -8 + Math.sin(t / 14) * 2;
  return `<svg class="backdrop" width="${W}" height="1080" style="opacity:${0.22 * level};transform:rotate(${tilt}deg);filter:blur(1.2px)">${rungs}${dots}</svg>`;
}

function background(t, level) {
  const o1x = 22 + Math.sin(t / 11) * 8;
  const o1y = 30 + Math.cos(t / 13) * 8;
  const o2x = 78 + Math.cos(t / 12) * 8;
  const o2y = 70 + Math.sin(t / 10) * 8;
  const o3x = 50 + Math.sin(t / 17) * 20;
  const boost = 0.6 + 0.4 * level;
  return (
    `<div class="orb" style="left:${o1x}%;top:${o1y}%;width:900px;height:700px;margin:-350px 0 0 -450px;background:rgb(67 194 187 / ${0.13 * boost})"></div>` +
    `<div class="orb" style="left:${o2x}%;top:${o2y}%;width:900px;height:700px;margin:-350px 0 0 -450px;background:rgb(217 119 87 / ${0.12 * boost})"></div>` +
    `<div class="orb" style="left:${o3x}%;top:50%;width:700px;height:500px;margin:-250px 0 0 -350px;background:rgb(77 141 255 / ${0.05 * boost})"></div>` +
    backdrop(t, level)
  );
}

const cue = (id) => TL.cues.find((c) => c.id === id);
/** Segment-local time of a marker: a number, or a cue id (optionally `id+offset`). */
function localAt(seg, at) {
  if (typeof at === 'number') return at;
  const [id, off] = String(at).split('+');
  const c = cue(id);
  return c ? c.start - seg.start + Number(off ?? 0) : Infinity;
}
/** Position of a shine band: sweeps from right to left once, starting at `start`. */
const sweepPos = (t, start, dur = 2.4) => `${lerp(140, -40, ease(ramp(t, start, start + dur)))}%`;

/** A line that rises out of a blur and settles its tracking. */
function riseLine(text, top, start, t, cls = '', dur = 2.0) {
  const k = easeOut(ramp(t, start, start + dur));
  if (k <= 0) return '';
  return `<div class="quote ${cls}" style="top:${top}px;opacity:${k};transform:translateY(${(1 - k) * 26}px);filter:blur(${(1 - k) * 14}px);--sx:${sweepPos(t, start + 0.7)}">${text}</div>`;
}

/** The full Shaw quote builds line by line and stays on screen until it hands over to HELIX. */
function shaw(t) {
  const [c1, c2, c3, c4, c5] = ['s01', 's02', 's03', 's04', 's05'].map(cue);
  let html = '';
  if (c1) html += riseLine('You see things…', 215, c1.start, t);
  if (c2) html += riseLine('and you say, ‘<em>Why?</em>’', 301, c2.start, t);
  if (c3) html += riseLine('But I dream things that never were…', 437, c3.start, t);
  if (c4) html += riseLine('and I say…', 523, c4.start, t);
  if (c5) {
    html += riseLine('<span class="shine">‘Why not?’</span>', 625, c5.start, t, 'big', 2.4);
    const a = easeOut(ramp(t, c5.end + 0.8, c5.end + 2.6));
    html += `<div class="attrib" style="opacity:${a};letter-spacing:${lerp(0.4, 0.22, a)}em">— George Bernard Shaw</div>`;
  }
  return html;
}

const srcOf = (ref) => {
  const [source, name] = ref.split('/');
  const s = SOURCES[source];
  return { url: s.dir + name + s.ext, size: s.size ?? sizes.get(s.dir + name + s.ext) };
};

/** One framed window onto footage: 3D drift, light sweep, crossfading states, crop easing c0 -> c1. */
function pane(seg, p, t) {
  const rectName = typeof p.rect === 'string' ? p.rect : 'full';
  const r = typeof p.rect === 'object' ? p.rect : RECTS[rectName];
  const local = t - seg.start;
  const k = (p.linear ? (x) => x : ease)(ramp(t, seg.start, seg.end));
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
    const a = Math.min(easeOut(ramp(local, at, at + 0.8)), 1 - ramp(local, until - 0.4, until));
    if (a <= 0) continue;
    const px = (c.x - x) * scale;
    const py = (c.y - y) * scale;
    const anchor =
      c.align === 'right' ? 'translateX(-100%)' : c.align === 'center' ? 'translateX(-50%)' : '';
    callouts += `<div class="callout" style="left:${px}px;top:${py}px;opacity:${a};transform:${anchor} translateY(${(1 - a) * 14}px) scale(${lerp(0.94, 1, a)})"><span class="dot" style="background:${STRAND[c.strand] ?? 'var(--text-2)'};box-shadow:0 0 14px ${STRAND[c.strand] ?? 'transparent'}"></span>${c.text}</div>`;
  }
  const [ry0, ry1] = p.tilt ?? TILT[rectName] ?? [0, 0];
  const ry = lerp(ry0, ry1, ease(ramp(t, seg.start, seg.end)));
  const glow = p.edge
    ? `border-color:${STRAND[p.edge]};box-shadow:0 0 0 1px ${STRAND[p.edge]},0 0 70px rgb(${GLOW[p.edge]} / 0.35),0 40px 90px rgb(0 0 0 / 0.6)`
    : 'box-shadow:0 40px 90px rgb(0 0 0 / 0.6),0 0 60px rgb(67 194 187 / 0.08)';
  const sweepX = lerp(-50, 150, ease(ramp(local, 0.3, 2.1)));
  const sweep = local < 2.2 ? `<div class="sweep" style="left:${sweepX}%"></div>` : '';
  const chip = p.chip
    ? `<div class="chip ${p.chipAt ?? 'tl'}"><span class="dot"></span>${p.chip}</div>`
    : '';
  return `<div class="tilt" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;transform:perspective(2600px) rotateY(${ry}deg) rotateX(1.2deg)"><div class="frame" style="${glow}">${imgs}<div class="reflection"></div>${sweep}${callouts}${chip}</div></div>`;
}

/** Deterministic pseudo-noise for waveform bars. */
const wobble = (i, t) =>
  0.5 + 0.5 * Math.sin(t * 9.1 + i * 1.7) * Math.sin(t * 4.3 + i * 0.6 + Math.sin(i * 3.1));

/** Glassy panel chrome shared by V.A.L.E., the intake card and the live feed. */
function glass(seg, p, t, inner, accent = '67 194 187') {
  const rectName = p.rect;
  const r = RECTS[rectName];
  const [ry0, ry1] = p.tilt ?? TILT[rectName] ?? [3, 1];
  const ry = lerp(ry0, ry1, ease(ramp(t, seg.start, seg.end)));
  return `<div class="tilt" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;transform:perspective(2600px) rotateY(${ry}deg) rotateX(1.2deg)"><div class="glass" style="box-shadow:0 0 0 1px rgb(${accent} / 0.55),0 0 80px rgb(${accent} / 0.22),0 40px 90px rgb(0 0 0 / 0.6)">${inner}</div></div>`;
}

/** Typed progress of a spoken line: characters revealed and whether it is still being spoken. */
function spoken(line, local) {
  const dur = line.dur ?? Math.max(1.1, line.text.length / 24);
  const k = clamp((local - line.at) / dur);
  return { k, speaking: local >= line.at && k < 1, dur };
}

/** V.A.L.E.: the voice assistant, connected to Helix through the Codex Dot extension. */
function valePane(seg, p, t) {
  const local = t - seg.start;
  const lines = p.lines.map((l) => ({ ...l, at: localAt(seg, l.at ?? 0) }));
  const active = lines.find((l) => spoken(l, local).speaking);
  const who = active?.who ?? 'idle';
  const level = who === 'idle' ? 0.12 : 1;
  const hue = who === 'you' ? '217 119 87' : '67 194 187';
  const orbScale = 1 + 0.08 * level * wobble(3, t);
  const rings = [0, 1, 2]
    .map((i) => {
      const ph = (t * 0.7 + i / 3) % 1;
      return `<div class="ring" style="transform:scale(${1 + ph * 0.9 * (0.4 + level)});opacity:${(1 - ph) * (0.15 + 0.45 * level)};border-color:rgb(${hue} / 0.8)"></div>`;
    })
    .join('');
  const bars = Array.from({ length: 44 }, (_, i) => {
    const centre = 1 - Math.abs(i - 21.5) / 24;
    const h = 6 + (level * 70 * centre + 8) * wobble(i, t);
    return `<span style="height:${h}px;background:rgb(${hue} / ${0.45 + 0.5 * centre})"></span>`;
  }).join('');
  const shown = lines.filter((l) => local >= l.at).slice(-(p.keep ?? 5));
  const bubbles = shown
    .map((l, i) => {
      const { k } = spoken(l, local);
      const a = easeOut(ramp(local, l.at, l.at + 0.5)) * (i < shown.length - 4 ? 0.45 : 1);
      const n = Math.max(1, Math.round(l.text.length * k));
      const caret = k < 1 ? '<i class="caret"></i>' : '';
      const sentK = l.sent
        ? easeOut(ramp(local, l.at + spoken(l, local).dur, l.at + spoken(l, local).dur + 0.6))
        : 0;
      const sent =
        l.sent && sentK > 0
          ? `<div class="sent" style="opacity:${sentK};transform:translateX(${(1 - sentK) * 12}px)">→ Sent to Helix · ${l.sent}</div>`
          : '';
      return `<div class="bubble b-${l.who}" style="opacity:${a};transform:translateY(${(1 - a) * 14}px)"><div class="who">${l.who === 'you' ? 'You' : 'V.A.L.E'}</div><div class="said">${l.text.slice(0, n)}${caret}</div>${sent}</div>`;
    })
    .join('');
  const inner = `<div class="vale">
    <div class="vhead"><div class="orbwrap"><div class="vorb" style="transform:scale(${orbScale});box-shadow:0 0 ${40 + 60 * level}px rgb(${hue} / ${0.35 + 0.35 * level})"></div>${rings}</div>
      <div><div class="vname">V.A.L.E</div><div class="vsub">Connected to Helix · Dot for Codex</div></div>
      <div class="live"><span style="opacity:${0.5 + 0.5 * Math.abs(Math.sin(t * 2.4))}"></span>${who === 'you' ? 'Listening' : who === 'vale' ? 'Speaking' : 'Live'}</div></div>
    <div class="wave">${bars}</div>
    <div class="transcript">${bubbles}</div></div>`;
  return glass(seg, p, t, inner, hue);
}

/** Helix guided intake as V.A.L.E. fills it in from the conversation. */
function intakePane(seg, p, t) {
  const local = t - seg.start;
  const rows = p.rows
    .map((row) => {
      const at = localAt(seg, row.at);
      if (local < at)
        return `<div class="irow pending"><div class="q">${row.q}</div><div class="a">Waiting for your answer…</div></div>`;
      const k = clamp((local - at) / Math.max(0.8, row.a.length / 40));
      const flash = 1 - ramp(local, at, at + 1.4);
      return `<div class="irow" style="box-shadow:0 0 0 1px rgb(67 194 187 / ${0.25 + 0.6 * flash}),0 0 ${30 * flash}px rgb(67 194 187 / ${0.5 * flash})"><div class="q">${row.q}</div><div class="a">${row.a.slice(0, Math.max(1, Math.round(row.a.length * k)))}</div></div>`;
    })
    .join('');
  const ready =
    p.readyAt === undefined
      ? 0
      : easeOut(ramp(local, localAt(seg, p.readyAt), localAt(seg, p.readyAt) + 0.8));
  const launch =
    p.readyAt === undefined
      ? ''
      : `<div class="launch" style="opacity:${ready};transform:scale(${lerp(0.96, 1, ready)})"><span>Brief ready · 12 tasks proposed</span><b style="box-shadow:0 0 ${20 + 30 * Math.abs(Math.sin(t * 2))}px rgb(35 165 90 / 0.6)">Launch build</b></div>`;
  const inner = `<div class="intake"><div class="ihead"><div><div class="eyebrow">New build · guided intake</div><div class="ititle">${p.title}</div></div><div class="via"><span></span>Voice via V.A.L.E</div></div>${rows}${launch}</div>`;
  return glass(seg, p, t, inner, '67 194 187');
}

/** V.A.L.E.'s real-time update feed: newest first. */
function feedPane(seg, p, t) {
  const local = t - seg.start;
  const rows = p.rows
    .map((row) => ({ ...row, at: localAt(seg, row.at) }))
    .filter((row) => local >= row.at)
    .reverse()
    .map((row) => {
      const a = easeOut(ramp(local, row.at, row.at + 0.6));
      const flash = 1 - ramp(local, row.at, row.at + 1.2);
      return `<div class="frow" style="opacity:${a};transform:translateX(${(1 - a) * 40}px);background:rgb(${GLOW[row.strand] ?? '120 130 150'} / ${0.06 + 0.14 * flash})"><span class="dot" style="background:${STRAND[row.strand] ?? 'var(--text-2)'};box-shadow:0 0 14px ${STRAND[row.strand] ?? 'transparent'}"></span><div><div class="ft">${row.title}</div><div class="fd">${row.detail}</div></div></div>`;
    })
    .join('');
  const inner = `<div class="feed"><div class="fhead"><div class="vorb small"></div><div><div class="vname small">V.A.L.E</div><div class="vsub">Live updates from Helix</div></div><div class="live"><span style="opacity:${0.5 + 0.5 * Math.abs(Math.sin(t * 2.4))}"></span>Live</div></div>${rows}</div>`;
  return glass(seg, p, t, inner, '169 140 247');
}

/** Light travelling from V.A.L.E. into the app when something is sent to Helix. */
function beams(seg, t) {
  const local = t - seg.start;
  let svg = '';
  for (const b of seg.beams ?? []) {
    const at = localAt(seg, b.at);
    const k = (local - at) / 1.1;
    if (k < 0 || k > 1.3) continue;
    const [x1, y1] = b.from;
    const [x2, y2] = b.to;
    const cx = (x1 + x2) / 2;
    const cy = Math.min(y1, y2) - 160;
    const pt = (u) => [
      (1 - u) * (1 - u) * x1 + 2 * (1 - u) * u * cx + u * u * x2,
      (1 - u) * (1 - u) * y1 + 2 * (1 - u) * u * cy + u * u * y2,
    ];
    const head = clamp(ease(clamp(k)));
    const fade = 1 - ramp(k, 1, 1.3);
    let path = '';
    for (let i = 0; i <= 24; i++) {
      const [x, y] = pt(head * (i / 24));
      path += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    const [hx, hy] = pt(head);
    svg += `<path d="${path}" stroke="url(#beam)" stroke-width="4" fill="none" opacity="${0.9 * fade}" stroke-linecap="round"/><circle cx="${hx}" cy="${hy}" r="${10 + 6 * Math.sin(t * 20)}" fill="#bff3ee" opacity="${fade}" filter="url(#glow)"/>`;
  }
  return svg
    ? `<svg class="beams" width="1920" height="1080"><defs><linearGradient id="beam" x1="0" x2="1"><stop offset="0" stop-color="#43c2bb" stop-opacity="0"/><stop offset="1" stop-color="#9ff0e8"/></linearGradient><filter id="glow"><feGaussianBlur stdDeviation="6"/></filter></defs>${svg}</svg>`
    : '';
}

const PANES = { vale: valePane, intake: intakePane, feed: feedPane };

function footage(t, seg) {
  return seg.panes.map((p) => (PANES[p.kind] ?? pane)(seg, p, t)).join('') + beams(seg, t);
}

/** Large typographic beats, one or more lines revealed at their cues. */
function title(t, seg) {
  const local = t - seg.start;
  let html = '';
  for (const l of seg.lines) {
    const at = localAt(seg, l.at ?? 0);
    const out =
      l.until === undefined
        ? 1
        : 1 - ramp(local, localAt(seg, l.until) - 0.8, localAt(seg, l.until));
    if (out <= 0) continue;
    html += `<div style="opacity:${out}">${riseLine(l.html, l.top, seg.start + at, t, l.cls ?? '', 1.8)}</div>`;
  }
  if (seg.mark) {
    const at = localAt(seg, seg.mark.at);
    const m = ease(ramp(local, at, at + 1.8)) * (seg.mark.opacity ?? 0.9);
    html += `<div class="mark" style="top:${seg.mark.top}px;opacity:${m};filter:drop-shadow(0 0 30px rgb(67 194 187 / 0.35))">${dnaSvg(seg.mark.size ?? 52, dnaPhase(t))}</div>`;
  }
  return html;
}

/** A record card quoting real recorded facts, each row revealed at its cue. */
function evidence(t, seg) {
  const local = t - seg.start;
  const rows = seg.rows
    .map((row) => {
      const at = localAt(seg, row.at ?? 0);
      const a = easeOut(ramp(local, at, at + 0.9));
      return `<div class="row" style="opacity:${a};transform:translateX(${(1 - a) * 20}px)"><span class="dot" style="background:${STRAND[row.strand] ?? 'var(--text-2)'};box-shadow:0 0 16px ${STRAND[row.strand] ?? 'transparent'}"></span><div><div class="what">${row.text}</div><div class="src">${row.source}</div></div></div>`;
    })
    .join('');
  const ry = lerp(3, -2, ease(ramp(t, seg.start, seg.end)));
  const edge = seg.edge
    ? `border-color:${STRAND[seg.edge]};box-shadow:0 0 70px rgb(${GLOW[seg.edge]} / 0.3),0 40px 90px rgb(0 0 0 / 0.6)`
    : '';
  return `<div class="evidence" style="${edge};transform:perspective(2600px) rotateY(${ry}deg)"><div class="eyebrow">${seg.eyebrow}</div><div class="head">${seg.heading}</div>${rows}<div class="foot">${seg.footnote}</div></div>`;
}

/** The HELIX title card: used right after the quote and again to close. */
function endCard(t, seg) {
  const local = t - seg.start;
  const m = easeOut(ramp(local, 0.2, 2.2));
  const w = easeOut(ramp(local, 0.9, 3.0));
  const r = ease(ramp(local, 1.8, 3.4));
  const g = easeOut(ramp(local, 2.6, 4.0));
  const pulse = 0.3 + 0.1 * Math.sin(local * 1.4);
  const spacing = lerp(0.62, 0.2, w);
  return (
    `<div class="mark" style="top:${lerp(300, 250, m)}px;opacity:${m};filter:drop-shadow(0 0 ${lerp(10, 46, m)}px rgb(67 194 187 / ${pulse}))">${dnaSvg(118, dnaPhase(t))}</div>` +
    `<div class="wordmark" style="top:420px;opacity:${w};filter:blur(${(1 - w) * 16}px)"><span style="letter-spacing:${spacing}em;padding-left:${spacing}em;background-position:${sweepPos(local, 2.4, 2.6)} 0,0 0">HELIX</span></div>` +
    `<div class="rule" style="top:648px;width:${lerp(0, 760, r)}px;opacity:${r}"></div>` +
    `<div class="tagline" style="top:682px;opacity:${g};transform:translateY(${(1 - g) * 12}px)">Coding agent orchestrator</div>`
  );
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
  const a = Math.min(easeOut(ramp(t, c.start, c.start + 0.4)), 1 - ramp(t, end - 0.3, end));
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
  return `<span style="display:inline-block;opacity:${a};transform:translateY(${(1 - a) * 10}px)">${text}</span>`;
}

window.load = async (timeline, options = {}) => {
  TL = timeline;
  OPT = options;
  await document.fonts.ready;
  const refs = new Set();
  for (const seg of TL.segments)
    for (const p of seg.panes ?? []) for (const s of p.states ?? []) refs.add(s.still);
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
  let level = 0;
  TL.segments.forEach((seg, i) => {
    const prev = TL.segments[i - 1];
    const next = TL.segments[i + 1];
    if (t < seg.start || (next && t >= next.start + XFADE)) return;
    // Incoming segments sharpen and settle; outgoing ones soften and recede.
    const inK = prev ? ease(ramp(t, seg.start, seg.start + XFADE)) : 1;
    const outK = next ? ease(ramp(t, next.start, next.start + XFADE)) : 0;
    const a = inK * (1 - outK);
    if (a <= 0.001) return;
    const scale = lerp(1.04, 1, inK) * lerp(1, 0.97, outK);
    const blur = (1 - inK) * 12 + outK * 8;
    level = Math.max(level, (BACKDROP[seg.type] ?? 0.4) * a);
    html += `<div class="layer" style="opacity:${a};transform:scale(${scale});${blur > 0.05 ? `filter:blur(${blur}px)` : ''}">${RENDER[seg.type](t, seg)}</div>`;
  });
  document.getElementById('bg').innerHTML = background(t, level);
  document.getElementById('layers').innerHTML = html;
  document.getElementById('caption').innerHTML = captionHtml(t);
  await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
};
