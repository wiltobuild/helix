// Deterministic promo stage: window.load(timeline, options) then await window.renderAt(seconds).
// Every visual is a pure function of time, so any frame can be rendered in any order.
'use strict';

const FRAME = { w: 1728, h: 798 };
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const ramp = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;

let TL;
let OPT;
const images = new Map();

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

function shaw(t, seg) {
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
      const s = lerp(1.06, 1, k);
      big = `<div class="quote big" style="top:520px;opacity:${k};transform:scale(${s})"><span class="whynot">‘Why not?’</span></div>`;
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

function frameAt(seg, local) {
  const frames = seg.manifest.frames;
  const ms = (seg.startMs ?? 0) + local * 1000 * (seg.rate ?? 1);
  let pick = frames[0];
  for (const f of frames) if (f.ms <= ms) pick = f;
  return `../footage/frames/${seg.shot}/${pick.file}`;
}

function footage(t, seg) {
  const local = t - seg.start;
  const k = ease(ramp(t, seg.start, seg.end));
  const w = lerp(seg.c0.w, seg.c1.w, k);
  const x = lerp(seg.c0.x, seg.c1.x, k);
  const y = lerp(seg.c0.y, seg.c1.y, k);
  const scale = FRAME.w / w;
  const src = frameAt(seg, local);
  const sim = seg.manifest.simulated;
  let callouts = '';
  for (const c of seg.callouts ?? []) {
    const a = easeOut(ramp(local, c.at, c.at + 0.6));
    if (a <= 0) continue;
    const px = (c.x - x) * scale;
    const py = (c.y - y) * scale - 70;
    const color =
      c.strand === 'codex'
        ? 'var(--codex)'
        : c.strand === 'claude'
          ? 'var(--claude)'
          : 'var(--orch)';
    const anchor = c.align === 'right' ? 'translateX(-100%)' : '';
    callouts += `<div class="callout" style="left:${px}px;top:${py}px;opacity:${a};transform:${anchor} translateY(${(1 - a) * 10}px)"><span class="dot" style="background:${color}"></span>${c.text}</div>`;
  }
  const chip = seg.label
    ? `<div class="chip ${sim ? 'sim' : ''} ${seg.chip ?? 'tl'}"><span class="dot"></span>${sim ? 'SIMULATED · ' : ''}${seg.label}</div>`
    : '';
  return `<div class="frame"><img src="${src}" style="transform:translate(${-x * scale}px,${-y * scale}px) scale(${scale})">${callouts}${chip}</div>`;
}

function endCard(t, seg) {
  const a = easeOut(ramp(t, seg.start + 0.3, seg.start + 1.6));
  return `<div class="mark" style="top:470px;opacity:${a}">${dnaSvg(70, dnaPhase(t))}</div>`;
}

const RENDER = { shaw, footage, end: endCard };
const XFADE = 0.7;

function captionHtml(t) {
  if (OPT.clean) return '';
  const i = TL.cues.findIndex((c, n) => {
    const next = TL.cues[n + 1];
    const until = c.gap <= 1.0 && next ? next.start - 0.12 : c.end + 0.6;
    return t >= c.start && t < until;
  });
  const c = TL.cues[i];
  if (!c || c.scene === 1) return ''; // The Shaw opening is set as typography, not captions.
  const next = TL.cues[i + 1];
  const until = c.gap <= 1.0 && next ? next.start - 0.12 : c.end + 0.6;
  const a = Math.min(easeOut(ramp(t, c.start, c.start + 0.3)), 1 - ramp(t, until - 0.25, until));
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
  const srcs = [];
  for (const seg of TL.segments)
    if (seg.manifest)
      for (const f of seg.manifest.frames) srcs.push(`../footage/frames/${seg.shot}/${f.file}`);
  await Promise.all(
    srcs.map((src) => {
      const img = new Image();
      img.src = src;
      images.set(src, img);
      return img.decode();
    }),
  );
  document.getElementById('proof').textContent = options.watermark ?? '';
};

window.renderAt = async (t) => {
  let html = '';
  TL.segments.forEach((seg, i) => {
    const prev = TL.segments[i - 1];
    // Each segment fades in over the previous one; the outgoing one stays until covered.
    if (t < seg.start - (prev ? 0 : 0) || t >= seg.end + XFADE) return;
    const a = prev ? ease(ramp(t, seg.start, seg.start + XFADE)) : 1;
    html += `<div class="layer" style="opacity:${a}">${RENDER[seg.type](t, seg)}</div>`;
  });
  document.getElementById('layers').innerHTML = html;
  document.getElementById('caption').innerHTML = captionHtml(t);
  await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
};
