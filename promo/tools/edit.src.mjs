// Generates script/edit.json. Kept as code so shared crops, chips and callouts stay consistent.
// Coordinates are CSS px in the Helix captures: 1920x1080 (`db/…`) or the 5600px-wide strip
// (`dbw/…`) of the Daybreak storefront build. V.A.L.E., intake and feed panes are stage graphics.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = (still, at) => ({ still: `db/${still}`, ...(at !== undefined ? { at } : {}) });
const dbw = (still, at) => ({ still: `dbw/${still}`, ...(at !== undefined ? { at } : {}) });
const full = (states, c0, c1, extra = {}) => ({ rect: 'full', states, c0, c1, ...extra });
const app = (states, c0, c1, extra = {}) => ({ rect: 'app', states, c0, c1, ...extra });
const INSPECTOR = (y) => ({ x: 1524, y, w: 392 });
// Worker card left edges in the 5600px strip; cards are 328 wide, rows sit at y 462 (agent),
// 602 (task) and 818 (reviewer slot).
const X = {
  designer: 518,
  catalogue: 890,
  product: 1260,
  bag: 1630,
  checkout: 2002,
  subs: 2372,
  story: 2744,
  search: 3114,
  newsletter: 3483,
  audit: 3853,
  speed: 4222,
  launch: 4592,
};
const close = (x, w = 720) => ({ x: x - 40, y: 430, w });
const vale = (lines, extra = {}) => ({ kind: 'vale', rect: 'vale', lines, ...extra });
const valeTalk = (lines, extra = {}) => ({
  kind: 'vale',
  rect: 'valeTalk',
  keep: 6,
  lines,
  ...extra,
});
// Beam endpoints in stage pixels: from V.A.L.E.'s transcript to the app pane.
const FROM_VALE = [640, 700];
const FROM_TALK = [860, 640];

const segments = [
  { id: 'shaw', from: 's01', type: 'shaw' },
  { id: 'helix-intro', from: 's05+2.6', type: 'end' },
  {
    id: 'roster',
    from: 's06',
    type: 'footage',
    panes: [full([db('agents')], { x: 236, y: 104, w: 1300 }, { x: 250, y: 150, w: 1120 })],
  },
  {
    id: 'plan-start',
    from: 's07',
    type: 'footage',
    panes: [
      full([dbw('strip-parallel')], close(X.designer, 1100), close(X.catalogue - 200, 900), {
        callouts: [
          { at: 0.8, text: 'Claude Code · Designer', strand: 'claude', x: X.designer + 10, y: 420 },
          {
            at: 1.6,
            text: 'Codex · Product Catalogue Engineer',
            strand: 'codex',
            x: X.catalogue + 10,
            y: 420,
          },
        ],
      }),
    ],
  },
  {
    id: 'many',
    from: 's08',
    type: 'footage',
    panes: [
      {
        rect: 'wide',
        states: [dbw('strip-mid')],
        c0: { x: 480, y: 432, w: 1480 },
        c1: { x: 3000, y: 432, w: 1480 },
      },
    ],
  },
  // V.A.L.E. arrives and takes the brief by voice.
  {
    id: 'vale-intake',
    from: 's09',
    type: 'footage',
    panes: [
      valeTalk([
        {
          who: 'vale',
          at: 's09+0.3',
          text: 'Hi, I’m V.A.L.E. I’m connected to Helix. What are we building?',
        },
        {
          who: 'you',
          at: 's10',
          text: 'An online store for Daybreak Coffee. Bright, like a sunrise.',
          sent: 'Goal',
        },
        { who: 'vale', at: 's10+3.4', text: 'Got it. I’ve started a new build in Helix.' },
      ]),
      {
        kind: 'intake',
        rect: 'intake',
        title: 'Daybreak storefront',
        rows: [
          {
            q: 'GOAL',
            a: 'An online store for Daybreak Coffee, bright like a sunrise.',
            at: 's10+3.0',
          },
          { q: 'WHO IS IT FOR?', a: '', at: 999 },
          { q: 'WHAT MUST WORK ON DAY ONE?', a: '', at: 999 },
          { q: 'HOW SHOULD IT FEEL?', a: '', at: 999 },
        ],
      },
    ],
    beams: [{ at: 's10+2.4', from: FROM_TALK, to: [1150, 300] }],
  },
  {
    id: 'divide',
    from: 's11',
    type: 'footage',
    panes: [
      vale([
        {
          who: 'vale',
          at: 0.4,
          text: 'Helix split it into twelve tasks for Codex and Claude Code.',
        },
        {
          who: 'vale',
          at: 's12',
          text: 'Codex reviewed the plan and caught one dependency. Fixed.',
        },
      ]),
      app(
        [db('plan-review-1'), db('plan-review-changes', 's12')],
        { x: 240, y: 290, w: 1000 },
        { x: 240, y: 330, w: 900 },
        {
          callouts: [
            {
              at: 's12+0.6',
              text: 'Codex plan review · 1 change',
              strand: 'review',
              x: 640,
              y: 300,
            },
          ],
        },
      ),
    ],
    beams: [{ at: 0.9, from: FROM_VALE, to: [1200, 380] }],
  },
  {
    id: 'together',
    from: 's13',
    type: 'footage',
    panes: [full([db('output')], { x: 236, y: 300, w: 1300 }, { x: 240, y: 330, w: 1270 })],
  },
  {
    id: 'helix',
    from: 's14',
    type: 'footage',
    panes: [full([db('complete')], { x: 560, y: 280, w: 660 }, { x: 640, y: 296, w: 500 })],
  },
  // Teamwork insert (insert version only).
  {
    id: 'pair',
    from: 't01',
    type: 'footage',
    panes: [full([db('agents')], { x: 250, y: 150, w: 1120 }, { x: 256, y: 160, w: 1040 })],
  },
  {
    id: 'coordinated',
    from: 't02',
    type: 'footage',
    panes: [
      {
        rect: 'wide',
        states: [dbw('strip-done')],
        c0: { x: 3000, y: 432, w: 1480 },
        c1: { x: 1200, y: 432, w: 1480 },
      },
    ],
  },
  {
    id: 'build',
    from: 't03',
    type: 'footage',
    panes: [
      full([dbw('strip-early')], close(X.bag), null, {
        edge: 'codex',
        callouts: [
          {
            at: 0.3,
            text: 'Codex · building the shopping bag',
            strand: 'codex',
            x: X.bag + 10,
            y: 420,
          },
        ],
      }),
    ],
  },
  {
    id: 'examine',
    from: 't04',
    type: 'footage',
    panes: [
      {
        rect: 'left',
        states: [db('bag-review-changes')],
        c0: { x: 1000, y: 300, w: 560 },
        c1: { x: 1010, y: 310, w: 520 },
      },
      {
        rect: 'right',
        states: [db('bag-review-changes')],
        c0: INSPECTOR(220),
        edge: 'review',
        callouts: [{ at: 0.8, text: 'Claude Code reviews it', strand: 'claude', x: 1540, y: 640 }],
      },
    ],
  },
  {
    id: 'perspective',
    from: 't05',
    type: 'footage',
    panes: [
      full(
        [db('plan-review-changes')],
        { x: 240, y: 430, w: 1290 },
        { x: 250, y: 440, w: 1200 },
        {
          edge: 'review',
          callouts: [
            { at: 0.4, text: 'Codex challenges the plan', strand: 'codex', x: 262, y: 822 },
          ],
        },
      ),
    ],
  },
  {
    id: 'scrutiny',
    from: 't06',
    type: 'footage',
    panes: [
      { rect: 'left', states: [db('bag-approved')], c0: { x: 1000, y: 300, w: 560 } },
      { rect: 'right', states: [db('bag-review-approved')], c0: INSPECTOR(220), edge: 'review' },
    ],
  },
  {
    id: 'shared',
    from: 't07',
    type: 'footage',
    panes: [full([db('output')], { x: 240, y: 330, w: 1270 }, { x: 236, y: 300, w: 1300 })],
  },
  // Online store: the full voice interview, transmitted into Helix's guided intake.
  {
    id: 'store-interview',
    from: 's15',
    type: 'footage',
    panes: [
      valeTalk([
        { who: 'vale', at: 's15+0.6', text: 'Who is the store for?' },
        {
          who: 'you',
          at: 's15+2.0',
          text: 'Coffee lovers at home, and regulars who subscribe.',
          sent: 'Audience',
        },
        { who: 'vale', at: 's15+4.8', text: 'What has to work on day one?' },
        {
          who: 'you',
          at: 's15+6.2',
          text: 'The catalogue, product pages, a bag, checkout and subscriptions.',
          sent: 'Scope',
        },
        { who: 'vale', at: 's15+9.4', text: 'And how should it feel?' },
        { who: 'you', at: 's15+10.6', text: 'Bright and bold. Like a sunrise.', sent: 'Design' },
        { who: 'vale', at: 's15+13.0', text: 'Brief’s ready. Twelve tasks. Launching it now.' },
      ]),
      {
        kind: 'intake',
        rect: 'intake',
        title: 'Daybreak storefront',
        rows: [
          { q: 'GOAL', a: 'An online store for Daybreak Coffee, bright like a sunrise.', at: 0 },
          {
            q: 'WHO IS IT FOR?',
            a: 'Coffee lovers at home, plus regulars who subscribe.',
            at: 's15+4.6',
          },
          {
            q: 'WHAT MUST WORK ON DAY ONE?',
            a: 'Catalogue · product pages · bag · checkout · subscriptions',
            at: 's15+9.2',
          },
          {
            q: 'HOW SHOULD IT FEEL?',
            a: 'Bright and bold, like a sunrise. Daybreak blue and orange.',
            at: 's15+12.2',
          },
          {
            q: 'MUST NOT BREAK · SUGGESTED BY V.A.L.E',
            a: 'Accessible, and fast on phones.',
            at: 's15+12.8',
          },
        ],
        readyAt: 's15+13.6',
      },
    ],
    beams: [
      { at: 's15+4.0', from: FROM_TALK, to: [1150, 420] },
      { at: 's15+8.6', from: FROM_TALK, to: [1150, 540] },
      { at: 's15+11.6', from: FROM_TALK, to: [1150, 660] },
    ],
  },
  {
    id: 'catalogue-cart',
    from: 's16',
    type: 'footage',
    panes: [
      full([dbw('strip-parallel')], close(X.catalogue, 760), close(X.bag - 40, 760), {
        callouts: [
          {
            at: 0.4,
            text: 'Product catalogue · in progress',
            strand: 'codex',
            x: X.catalogue + 10,
            y: 420,
            until: 's17+-0.3',
          },
          { at: 's17', text: 'Shopping bag · in progress', strand: 'codex', x: X.bag + 10, y: 420 },
        ],
      }),
    ],
  },
  {
    id: 'assignments',
    from: 's18',
    type: 'footage',
    panes: [full([db('tasks-page')], { x: 244, y: 100, w: 1290 }, { x: 250, y: 104, w: 1180 })],
  },
  {
    id: 'needs',
    from: 's19',
    type: 'footage',
    panes: [
      full([dbw('strip-early')], close(X.checkout), null, {
        callouts: [
          {
            at: 0.4,
            text: 'Checkout waits on the shopping bag',
            strand: 'claude',
            x: X.checkout + 10,
            y: 420,
          },
        ],
      }),
    ],
  },
  {
    id: 'review-testing',
    from: 's20',
    type: 'footage',
    panes: [
      full([dbw('strip-mid')], close(X.catalogue), null, {
        edge: 'review',
        callouts: [
          {
            at: 0.4,
            text: 'Reviewed by Claude Code · CI 4/4',
            strand: 'review',
            x: X.catalogue + 10,
            y: 420,
          },
        ],
      }),
    ],
  },
  // Watch the work: a long pan across all twelve agents as their stages advance.
  {
    id: 'watch',
    from: 's21',
    type: 'footage',
    panes: [
      {
        rect: 'full',
        states: [dbw('strip-early'), dbw('strip-mid', 's22'), dbw('strip-late', 's22+3.2')],
        c0: { x: 470, y: 422, w: 1000 },
        c1: { x: 4000, y: 422, w: 1000 },
      },
    ],
  },
  {
    id: 'building',
    from: 's23',
    type: 'footage',
    panes: [
      full([dbw('strip-mid')], close(X.product), null, {
        edge: 'claude',
        callouts: [
          {
            at: 0.2,
            text: 'Building · Product detail pages',
            strand: 'claude',
            x: X.product + 10,
            y: 420,
          },
        ],
      }),
    ],
  },
  {
    id: 'checking',
    from: 's24',
    type: 'footage',
    panes: [
      { rect: 'left', states: [db('bag-review-changes')], c0: { x: 1000, y: 300, w: 560 } },
      { rect: 'right', states: [db('bag-review-changes')], c0: INSPECTOR(220), edge: 'review' },
    ],
  },
  {
    id: 'ready',
    from: 's25',
    type: 'footage',
    panes: [
      full([dbw('strip-mid')], close(X.designer), null, {
        edge: 'codex',
        callouts: [
          {
            at: 0.2,
            text: 'Ready · approved, CI passed, merged',
            strand: 'codex',
            x: X.designer + 10,
            y: 420,
          },
        ],
      }),
    ],
  },
  {
    id: 'waiting',
    from: 's26',
    type: 'footage',
    panes: [
      full([dbw('strip-mid')], close(X.audit), null, {
        edge: 'claude',
        callouts: [
          {
            at: 0.2,
            text: 'Waiting · on product pages and checkout',
            strand: 'claude',
            x: X.audit + 10,
            y: 420,
          },
        ],
      }),
    ],
  },
  {
    id: 'decision',
    from: 's27',
    type: 'footage',
    panes: [
      vale([
        { who: 'vale', at: 0.4, text: 'Codex passed the plan. Want me to approve it?' },
        { who: 'you', at: 's27+2.8', text: 'Yes. Approve it.', sent: 'Plan approval' },
      ]),
      app(
        [db('plan-ready'), db('plan-approved', 's27+4.6')],
        { x: 1060, y: 340, w: 860 },
        { x: 1080, y: 360, w: 840 },
        {
          edge: 'orch',
        },
      ),
    ],
    beams: [{ at: 's27+3.9', from: FROM_VALE, to: [1560, 520] }],
  },
  // Stay involved.
  {
    id: 'shaping',
    from: 's28',
    type: 'footage',
    panes: [
      vale([
        { who: 'you', at: 0.3, text: 'Go with the sunrise design.', sent: 'Design decision' },
        { who: 'vale', at: 's28+2.4', text: 'Approved. I’ve shared it with every worker.' },
      ]),
      app([db('design')], { x: 236, y: 320, w: 1150 }, { x: 240, y: 380, w: 1050 }),
    ],
    beams: [{ at: 1.6, from: FROM_VALE, to: [1200, 520] }],
  },
  {
    id: 'coordination',
    from: 's29',
    type: 'footage',
    panes: [
      {
        kind: 'feed',
        rect: 'vale',
        rows: [
          {
            at: 0.3,
            strand: 'claude',
            title: 'Review asked for one change',
            detail: 'Shopping bag · sent back to the Codex engineer',
          },
          {
            at: 1.4,
            strand: 'codex',
            title: 'Shopping bag fixed',
            detail: 'CI 4/4 · re-review approved',
          },
          {
            at: 2.5,
            strand: 'orch',
            title: 'Checkout unblocked',
            detail: 'It was waiting on the bag',
          },
          {
            at: 3.6,
            strand: 'review',
            title: 'Product pages approved',
            detail: 'Reviewed by Codex · ready to merge',
          },
          {
            at: 4.7,
            strand: 'codex',
            title: 'Subscriptions started',
            detail: 'Codex · new worktree',
          },
        ],
      },
      app(
        [dbw('strip-early'), dbw('strip-mid', 2.5)],
        { x: 1600, y: 430, w: 1100 },
        { x: 2200, y: 430, w: 1100 },
      ),
    ],
  },
  {
    id: 'handoffs',
    from: 's30',
    type: 'footage',
    panes: [full([db('output')], { x: 240, y: 330, w: 1270 }, { x: 236, y: 300, w: 1300 })],
  },
  // Close.
  {
    id: 'ambition',
    from: 's31',
    type: 'footage',
    panes: [
      {
        rect: 'wide',
        states: [dbw('strip-done')],
        c0: { x: 2300, y: 432, w: 1300 },
        c1: { x: 1500, y: 250, w: 2600 },
      },
    ],
  },
  {
    id: 'idea',
    from: 's33',
    type: 'title',
    lines: [
      {
        top: 400,
        cls: 'title',
        html: 'You bring the <span class="shine claude">idea</span>.',
        until: 's34+-0.2',
      },
      {
        at: 's34',
        top: 400,
        cls: 'title',
        html: '<span class="shine helix">Helix</span> brings the <span class="shine">team together</span>.',
      },
    ],
    mark: { at: 's34+0.8', top: 590, size: 64, opacity: 0.95 },
  },
  { id: 'end', from: 's35', type: 'end' },
];

fs.writeFileSync(
  path.join(root, 'script/edit.json'),
  JSON.stringify(
    {
      note: 'Generated by tools/edit.src.mjs: edit there. Each segment starts at its `from` phrase (minus lead) and runs to the next. Footage is the Helix UI replaying the invented Daybreak storefront build (db, dbw); V.A.L.E., intake and feed panes are stage graphics.',
      lead: 0.5,
      segments,
    },
    null,
    2,
  ) + '\n',
);
console.log('edit.json:', segments.length, 'segments');
