// Animated plan graph and Board for the promo, styled after Helix's PlanView and Board.
// One build schedule drives both: agents work, go to review, hand off along their dependencies and
// stop animating once done; the Helix orchestrator card always narrates what it is doing.
// Loaded after stage.js and registered as the `graph` and `board` pane kinds.
'use strict';

/** The Daybreak build, in build-clock units (0–100). review: [start, end]; fix: requested-change loop. */
const BUILD = [
  {
    id: 'tokens',
    name: 'Designer',
    task: 'Design system tokens',
    agent: 'claude',
    deps: [],
    work: [0, 9],
    review: [9, 13],
    pr: 41,
  },
  {
    id: 'catalogue',
    name: 'Product Catalogue Engineer',
    task: 'Product catalogue',
    agent: 'codex',
    deps: ['tokens'],
    work: [14, 28],
    review: [28, 32],
    pr: 42,
  },
  {
    id: 'bag',
    name: 'Shopping Bag Engineer',
    task: 'Shopping bag',
    agent: 'codex',
    deps: ['tokens'],
    work: [14, 30],
    review: [30, 42],
    fix: [34, 38],
    pr: 44,
  },
  {
    id: 'story',
    name: 'Story Designer',
    task: 'Our story page',
    agent: 'claude',
    deps: ['tokens'],
    work: [15, 25],
    review: [25, 29],
    pr: 43,
  },
  {
    id: 'newsletter',
    name: 'Newsletter Engineer',
    task: 'Newsletter signup',
    agent: 'claude',
    deps: ['tokens'],
    work: [16, 23],
    review: [23, 27],
    pr: 45,
  },
  {
    id: 'product',
    name: 'Product Detail Designer',
    task: 'Product detail pages',
    agent: 'claude',
    deps: ['catalogue'],
    work: [33, 48],
    review: [48, 52],
    pr: 46,
  },
  {
    id: 'search',
    name: 'Search Filters Engineer',
    task: 'Search and filters',
    agent: 'codex',
    deps: ['catalogue'],
    work: [33, 44],
    review: [44, 48],
    pr: 47,
  },
  {
    id: 'checkout',
    name: 'Checkout Engineer',
    task: 'Checkout flow',
    agent: 'claude',
    deps: ['bag'],
    work: [43, 58],
    review: [58, 62],
    pr: 48,
  },
  {
    id: 'subs',
    name: 'Subscriptions Engineer',
    task: 'Subscriptions',
    agent: 'codex',
    deps: ['bag'],
    work: [43, 55],
    review: [55, 59],
    pr: 49,
  },
  {
    id: 'speed',
    name: 'Mobile Speed Engineer',
    task: 'Mobile speed budget',
    agent: 'codex',
    deps: ['product'],
    work: [53, 64],
    review: [64, 68],
    pr: 50,
  },
  {
    id: 'a11y',
    name: 'Accessibility Auditor',
    task: 'Accessibility audit',
    agent: 'claude',
    deps: ['product', 'checkout'],
    work: [63, 75],
    review: [75, 79],
    pr: 51,
  },
  {
    id: 'launch',
    name: 'Launch Checklist Engineer',
    task: 'Launch checklist',
    agent: 'codex',
    deps: ['a11y', 'speed', 'subs'],
    work: [80, 90],
    review: [90, 94],
    pr: 52,
  },
];
const BY_ID = Object.fromEntries(BUILD.map((n) => [n.id, n]));
const AGENT = {
  codex: { label: 'Codex', color: '#43c2bb', rgb: '67 194 187' },
  claude: { label: 'Claude Code', color: '#d97757', rgb: '217 119 87' },
};
const STATUS = {
  waiting: { label: 'Waiting', color: '#8792a4' },
  working: { label: 'In progress', color: '#5b9bff' },
  review: { label: 'In review', color: '#a98cf7' },
  changes: { label: 'Changes asked', color: '#f0a93b' },
  done: { label: 'Done', color: '#3fc47e' },
};
const doneAt = (n) => n.review[1];

function stateAt(n, c) {
  if (c >= doneAt(n)) return 'done';
  if (n.fix && c >= n.fix[0] && c < n.fix[1]) return 'changes';
  if (c >= n.review[0]) return 'review';
  if (c >= n.work[0]) return 'working';
  return 'waiting';
}

/** What Helix is doing at clock c: the latest scheduled orchestration event. */
function helixEvents() {
  const ev = [{ at: -1, text: 'Plan approved · assigning the first task' }];
  for (const n of BUILD) {
    ev.push({ at: n.work[0], text: `Assigned ${n.task.toLowerCase()} to ${n.name}` });
    const reviewer = n.agent === 'codex' ? 'Claude Code' : 'Codex';
    ev.push({
      at: n.review[0],
      text: `Asked ${reviewer} to review ${n.task.toLowerCase()} · PR #${n.pr}`,
    });
    if (n.fix) {
      ev.push({ at: n.fix[0], text: `Routed review findings back to ${n.name}` });
      ev.push({ at: n.fix[1], text: `Fix pushed · CI 4/4 · re-review requested` });
    }
    const next = BUILD.filter((m) => m.deps.includes(n.id)).map((m) => m.name.split(' ')[0]);
    ev.push({
      at: doneAt(n),
      text: `Merged PR #${n.pr}${next.length ? ` · handed off to ${next.join(', ')}` : ''}`,
    });
  }
  ev.push({ at: 95, text: 'All 12 tasks merged · storefront ready in Output' });
  return ev.sort((a, b) => a.at - b.at);
}
const HELIX_EVENTS = helixEvents();

// ---- Glyphs: deterministic versions of the app's animated agent marks ----
const CODEX_PATH =
  'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';
const CLAUDE_RAYS = [
  [0, 9.8, 2.0],
  [28, 10.0, 3.1],
  [58, 9.8, 2.3],
  [90, 9.8, 2.0],
  [122, 10.0, 3.0],
  [150, 9.8, 2.2],
  [180, 9.8, 2.0],
  [208, 10.0, 3.1],
  [238, 9.8, 2.3],
  [270, 9.8, 2.0],
  [302, 10.0, 3.0],
  [330, 9.8, 2.2],
];

/** Codex: the hex-knot rotates while working and rests once done. */
function codexGlyph(size, t, active) {
  const rot = active ? (t * 90) % 360 : 0;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><g transform="rotate(${rot} 12 12)"><path d="${CODEX_PATH}" fill="#43c2bb"/></g></svg>`;
}

/** Claude Code: the sunburst's rays wave and two rings ripple outward while working. */
function claudeGlyph(size, t, active) {
  let rings = '';
  if (active)
    for (const off of [0, 0.5]) {
      const ph = (t * 0.9 + off) % 1;
      rings += `<circle cx="12" cy="12" r="${4 + ph * 7.5}" fill="none" stroke="#d97757" stroke-width="0.8" opacity="${(1 - ph) * 0.7}"/>`;
    }
  const rays = CLAUDE_RAYS.map(([angle, y1, y2], i) => {
    const wave = active ? Math.sin(t * 7 - i * 0.55) * 1.4 : 0;
    return `<line transform="rotate(${angle} 12 12)" x1="12" y1="${y1}" x2="12" y2="${y2 - wave}" stroke="#d97757" stroke-width="2.1" stroke-linecap="round"/>`;
  }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24">${rings}${rays}<circle cx="12" cy="12" r="2.8" fill="#d97757"/></svg>`;
}
const glyph = (agent, size, t, active) =>
  agent === 'codex' ? codexGlyph(size, t, active) : claudeGlyph(size, t, active);

// ---- Graph layout (world px) ----
const COLS = [
  ['tokens'],
  ['catalogue', 'bag', 'story', 'newsletter'],
  ['product', 'search', 'checkout', 'subs'],
  ['speed', 'a11y'],
  ['launch'],
];
const CARD = { w: 390, h: 158 };
const COL_X = (i) => 40 + i * 470;
const ROW_GAP = 190;
const TOP = 230;
const LAYOUT = {};
COLS.forEach((col, ci) => {
  const height = (col.length - 1) * ROW_GAP;
  col.forEach((id, ri) => {
    LAYOUT[id] = { x: COL_X(ci), y: TOP + (3 * ROW_GAP) / 2 - height / 2 + ri * ROW_GAP };
  });
});
const WORLD = { w: COL_X(4) + CARD.w + 40, h: TOP + 4 * ROW_GAP + 20 };
const HELIX_CARD = { x: WORLD.w / 2 - 330, y: 20, w: 660, h: 150 };

const fmtClock = (c) => clamp(c, 0, 100);

function progress(n, c) {
  if (c < n.work[0]) return 0;
  if (c >= n.review[0]) return 1;
  return (c - n.work[0]) / (n.work[1] - n.work[0]);
}

function agentCard(n, c, t) {
  const st = stateAt(n, c);
  const s = STATUS[st];
  const a = AGENT[n.agent];
  const active = st === 'working' || st === 'changes';
  const reviewer = n.agent === 'codex' ? 'claude' : 'codex';
  const reviewing = st === 'review';
  const p = progress(n, c);
  const justDone = clamp((c - doneAt(n)) / 2.5);
  const glow =
    st === 'working' || st === 'changes'
      ? `0 0 0 1px rgb(${a.rgb} / 0.75), 0 0 ${34 + 10 * Math.sin(t * 3)}px rgb(${a.rgb} / 0.32)`
      : reviewing
        ? `0 0 0 1px rgb(169 140 247 / 0.8), 0 0 36px rgb(169 140 247 / 0.3)`
        : st === 'done'
          ? `0 0 0 1px rgb(63 196 126 / ${0.35 + 0.5 * (1 - justDone)}), 0 0 ${40 * (1 - justDone)}px rgb(63 196 126 / 0.5)`
          : '0 0 0 1px #212a38';
  const shimmer =
    st === 'working' ? `<div class="lp-shimmer" style="left:${((t * 70) % 140) - 40}%"></div>` : '';
  const bar =
    st === 'done' ? '#3fc47e' : reviewing ? '#a98cf7' : st === 'changes' ? '#f0a93b' : '#5b9bff';
  const foot = [];
  if (c >= n.review[0])
    foot.push(`<span class="lp-chip ok">✓ CI ${c >= n.review[0] + 1 ? '4/4' : '2/4'}</span>`);
  if (reviewing || st === 'changes' || st === 'done')
    foot.push(
      `<span class="lp-chip rev">${glyph(reviewer, 16, t, reviewing)} ${st === 'done' ? 'Approved by' : st === 'changes' ? 'Changes from' : 'Reviewing ·'} ${AGENT[reviewer].label}</span>`,
    );
  if (st === 'done') foot.push(`<span class="lp-chip merged">PR #${n.pr} merged</span>`);
  if (st === 'waiting') {
    const blockers = n.deps.filter((d) => c < doneAt(BY_ID[d])).map((d) => BY_ID[d].task);
    foot.push(
      `<span class="lp-wait">${blockers.length ? `Waits on ${blockers.join(', ')}` : 'Starting…'}</span>`,
    );
  }
  if (st === 'working')
    foot.push(`<span class="lp-wait">${Math.round(p * 100)}% · writing code</span>`);
  return `<div class="lp-card" style="left:${LAYOUT[n.id].x}px;top:${LAYOUT[n.id].y}px;box-shadow:${glow};opacity:${st === 'waiting' ? 0.72 : 1}">
    <div class="lp-head"><div class="lp-tile" style="background:rgb(${a.rgb} / 0.12);border-color:rgb(${a.rgb} / 0.4)">${glyph(n.agent, 34, t + n.pr, active)}</div>
      <div class="lp-names"><div class="lp-name">${n.name}</div><div class="lp-kind">${a.label} · ${n.task}</div></div></div>
    <div class="lp-barrow"><span class="lp-pill" style="color:${s.color};border-color:${s.color}66;background:${s.color}1a"><i style="background:${s.color}"></i>${s.label}</span><div class="lp-bar"><div style="width:${p * 100}%;background:${bar}"></div>${shimmer}</div></div>
    <div class="lp-foot">${foot.join('')}</div></div>`;
}

function edgePath(from, to) {
  const a = LAYOUT[from];
  const b = LAYOUT[to];
  const x1 = a.x + CARD.w;
  const y1 = a.y + CARD.h / 2;
  const x2 = b.x;
  const y2 = b.y + CARD.h / 2;
  const mx = (x1 + x2) / 2;
  return {
    d: `M${x1} ${y1} C${mx} ${y1},${mx} ${y2},${x2} ${y2}`,
    pts: [x1, y1, mx, y1, mx, y2, x2, y2],
  };
}
const bez = ([x1, y1, cx1, cy1, cx2, cy2, x2, y2], u) => {
  const v = 1 - u;
  return [
    v * v * v * x1 + 3 * v * v * u * cx1 + 3 * v * u * u * cx2 + u * u * u * x2,
    v * v * v * y1 + 3 * v * v * u * cy1 + 3 * v * u * u * cy2 + u * u * u * y2,
  ];
};

function edges(c, t) {
  let svg = '';
  for (const n of BUILD)
    for (const dep of n.deps) {
      const src = BY_ID[dep];
      const { d, pts } = edgePath(dep, n.id);
      const handed = c >= doneAt(src);
      const color = AGENT[src.agent].color;
      svg += `<path d="${d}" stroke="${handed ? color : '#2e394a'}" stroke-width="${handed ? 3 : 2}" fill="none" opacity="${handed ? 0.75 : 1}" ${handed ? '' : 'stroke-dasharray="7 7"'}/>`;
      // Handoff: a bright packet travels from the finished task into the one that needed it.
      const k = (c - doneAt(src)) / 3;
      if (k >= 0 && k <= 1.2) {
        const [x, y] = bez(pts, clamp(ease(clamp(k))));
        const f = 1 - ramp(k, 1, 1.2);
        svg += `<circle cx="${x}" cy="${y}" r="16" fill="${color}" opacity="${0.35 * f}" filter="url(#lpblur)"/><circle cx="${x}" cy="${y}" r="7" fill="#ffffff" opacity="${f}"/>`;
      }
      // Waiting work: a slow marching dash shows the dependency is still open.
      if (!handed && c >= src.work[0])
        svg += `<path d="${d}" stroke="${color}" stroke-width="2" fill="none" opacity="0.5" stroke-dasharray="4 18" stroke-dashoffset="${-t * 40}"/>`;
    }
  // Helix assigns each task: a beam from the orchestrator to the card as it starts.
  for (const n of BUILD) {
    const k = (c - n.work[0]) / 2.2;
    if (k < 0 || k > 1.2) continue;
    const L = LAYOUT[n.id];
    const pts = [
      HELIX_CARD.x + HELIX_CARD.w / 2,
      HELIX_CARD.y + HELIX_CARD.h,
      HELIX_CARD.x + HELIX_CARD.w / 2,
      L.y - 60,
      L.x + CARD.w / 2,
      HELIX_CARD.y + HELIX_CARD.h + 40,
      L.x + CARD.w / 2,
      L.y,
    ];
    const [x, y] = bez(pts, clamp(ease(clamp(k))));
    const f = 1 - ramp(k, 1, 1.2);
    svg += `<circle cx="${x}" cy="${y}" r="18" fill="#e3a53f" opacity="${0.3 * f}" filter="url(#lpblur)"/><circle cx="${x}" cy="${y}" r="6" fill="#ffe3a8" opacity="${f}"/>`;
  }
  return `<svg class="lp-edges" width="${WORLD.w}" height="${WORLD.h}"><defs><filter id="lpblur"><feGaussianBlur stdDeviation="6"/></filter></defs>${svg}</svg>`;
}

function helixCard(c, t, compact) {
  const merged = BUILD.filter((n) => c >= doneAt(n)).length;
  const working = BUILD.filter((n) => ['working', 'changes'].includes(stateAt(n, c))).length;
  const reviewing = BUILD.filter((n) => stateAt(n, c) === 'review').length;
  const ev = [...HELIX_EVENTS].reverse().find((e) => e.at <= c) ?? HELIX_EVENTS[0];
  const fresh = 1 - clamp((c - ev.at) / 2);
  const complete = merged === BUILD.length;
  const pill = complete
    ? '<span class="lp-pill" style="color:#3fc47e;border-color:#3fc47e66;background:#3fc47e1a"><i style="background:#3fc47e"></i>Complete</span>'
    : '<span class="lp-pill" style="color:#3fc47e;border-color:#3fc47e66;background:#3fc47e1a"><i style="background:#3fc47e"></i>Running</span>';
  const style = compact
    ? 'left:24px;top:20px;width:560px'
    : `left:${HELIX_CARD.x}px;top:${HELIX_CARD.y}px;width:${HELIX_CARD.w}px`;
  return `<div class="lp-helix" style="${style}">
    <div class="lp-head"><div class="lp-tile helix">${dnaSvg(30, complete ? 0 : dnaPhase(t * 2))}</div>
      <div class="lp-names"><div class="lp-name">Helix</div><div class="lp-kind">Plan and coordinate all tasks</div></div>${pill}</div>
    <div class="lp-now" style="background:rgb(227 165 63 / ${0.06 + 0.16 * fresh})"><span class="lp-dot"></span>${ev.text}</div>
    <div class="lp-metrics"><span>${merged}/12 merged</span><span>${working} working</span><span>${reviewing} in review</span><span>✓ plan approved</span></div></div>`;
}

/** Slim Helix status bar for the Board: what it is doing now, and the build's progress. */
function helixStrip(c, t) {
  const merged = BUILD.filter((n) => c >= doneAt(n)).length;
  const ev = [...HELIX_EVENTS].reverse().find((e) => e.at <= c) ?? HELIX_EVENTS[0];
  const fresh = 1 - clamp((c - ev.at) / 2);
  return `<div class="lb-strip"><div class="lb-brand">Board <span>Daybreak storefront</span></div><div class="lb-now" style="background:rgb(227 165 63 / ${0.08 + 0.16 * fresh})">${dnaSvg(18, merged === 12 ? 0 : dnaPhase(t * 2))}<b>Helix</b>${ev.text}</div><div class="lb-merged">${merged}/12 merged</div></div>`;
}

/** Map a segment's local time onto the build clock. */
function clockFor(seg, p, t) {
  const [c0, c1] = p.clock;
  return lerp(c0, c1, ramp(t, seg.start + (p.clockDelay ?? 0), seg.end));
}

/** The live plan graph, framed like a pane; `c0`/`c1` are camera rects in world px, or 'fit'. */
function graphPane(seg, p, t) {
  const r = RECTS[p.rect ?? 'full'];
  const c = clockFor(seg, p, t);
  const k = ease(ramp(t, seg.start, seg.end));
  const fit = { x: -20, y: 0, w: Math.max(WORLD.w + 40, WORLD.h * (r.w / r.h)) };
  const cam0 = p.c0 === 'fit' || !p.c0 ? fit : p.c0;
  const cam1 = p.c1 === 'fit' ? fit : (p.c1 ?? cam0);
  const w = lerp(cam0.w, cam1.w, k);
  const x = lerp(cam0.x, cam1.x, k);
  const y = lerp(cam0.y, cam1.y, k);
  const scale = r.w / w;
  // Centre the world vertically when the camera is wider than the graph is tall.
  const yOff = (r.h / scale - WORLD.h) / 2;
  const world = `<div class="lp-world" style="width:${WORLD.w}px;height:${WORLD.h}px;transform:translate(${-x * scale}px,${(-y + Math.max(0, yOff)) * scale}px) scale(${scale})">${edges(c, t)}${helixCard(c, t)}${BUILD.map((n) => agentCard(n, c, t)).join('')}</div>`;
  const [ry0, ry1] = p.tilt ?? TILT[p.rect ?? 'full'] ?? [3, -3];
  const ry = lerp(ry0, ry1, k);
  return `<div class="tilt" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;transform:perspective(2600px) rotateY(${ry}deg) rotateX(1.2deg)"><div class="frame lp-frame" style="box-shadow:0 40px 90px rgb(0 0 0 / 0.6),0 0 60px rgb(67 194 187 / 0.1)">${world}<div class="reflection"></div></div></div>`;
}

/** Board: tasks flow across Waiting → In progress → In review → Done as the build advances. */
const BOARD_COLS = [
  { key: 'waiting', label: 'Waiting', states: ['waiting'] },
  { key: 'working', label: 'In progress', states: ['working', 'changes'] },
  { key: 'review', label: 'In review', states: ['review'] },
  { key: 'done', label: 'Done', states: ['done'] },
];
function boardSlots(c) {
  const slots = {};
  for (const [ci, col] of BOARD_COLS.entries()) {
    const cards = BUILD.filter((n) => col.states.includes(stateAt(n, c)));
    cards.forEach((n, i) => (slots[n.id] = { ci, i, count: cards.length }));
  }
  return slots;
}
function boardPane(seg, p, t) {
  const r = RECTS[p.rect ?? 'full'];
  const c = clockFor(seg, p, t);
  const colW = (r.w - 60) / 4;
  const top = 150;
  const avail = r.h - top - 24;
  // Average each card's slot over a short window so moves between columns glide.
  const samples = 8;
  const span = p.glide ?? 1.4;
  const pos = {};
  for (let s = 0; s < samples; s++) {
    const slots = boardSlots(c - (span * s) / (samples - 1));
    for (const n of BUILD) {
      const sl = slots[n.id];
      const h = Math.min(108, avail / Math.max(sl.count, 1));
      const px = 20 + sl.ci * (colW + 6.7) + 10;
      const py = top + sl.i * h;
      const acc = (pos[n.id] ??= { x: 0, y: 0, h: 0 });
      acc.x += px / samples;
      acc.y += py / samples;
      acc.h += h / samples;
    }
  }
  const now = boardSlots(c);
  const heads = BOARD_COLS.map((col, ci) => {
    const count = BUILD.filter((n) => col.states.includes(stateAt(n, c))).length;
    return `<div class="lb-col" style="left:${20 + ci * (colW + 6.7)}px;width:${colW}px"><div class="lb-head"><span style="background:${STATUS[col.key].color}"></span>${col.label}<b>${count}</b></div></div>`;
  }).join('');
  const cards = BUILD.map((n) => {
    const st = stateAt(n, c);
    const a = AGENT[n.agent];
    const active = st === 'working' || st === 'changes';
    const P = pos[n.id];
    const compact = P.h < 86;
    const s = STATUS[st];
    return `<div class="lb-card" style="left:${P.x}px;top:${P.y}px;width:${colW - 20}px;height:${P.h - 10}px;box-shadow:0 0 0 1px ${active ? `rgb(${a.rgb} / 0.7)` : '#2e394a'}${active ? `,0 0 26px rgb(${a.rgb} / 0.3)` : ''}">
      <div class="lp-tile small" style="background:rgb(${a.rgb} / 0.12);border-color:rgb(${a.rgb} / 0.4)">${glyph(n.agent, compact ? 20 : 26, t + n.pr, active)}</div>
      <div class="lb-text"><div class="lb-task">${n.task}</div>${compact ? '' : `<div class="lb-agent">${n.name} · ${a.label}</div>`}</div>
      <span class="lb-state" style="color:${s.color}">${st === 'done' ? `#${n.pr} ✓` : s.label}</span></div>`;
  }).join('');
  void now;
  const [ry0, ry1] = p.tilt ?? TILT[p.rect ?? 'full'] ?? [3, -3];
  const ry = lerp(ry0, ry1, ease(ramp(t, seg.start, seg.end)));
  return `<div class="tilt" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;transform:perspective(2600px) rotateY(${ry}deg) rotateX(1.2deg)"><div class="frame lp-frame" style="box-shadow:0 40px 90px rgb(0 0 0 / 0.6),0 0 60px rgb(67 194 187 / 0.1)">${helixStrip(c, t)}${heads}${cards}<div class="reflection"></div></div></div>`;
}

PANES.graph = graphPane;
PANES.board = boardPane;
void fmtClock;
