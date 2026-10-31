// Generates script/edit.json. Kept as code so shared crops, chips and callouts stay consistent.
// Coordinates are CSS px in the 1920x1080 Helix captures (or native px for Daybreak images).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = 'Real Helix replay · recorded store build, Oct 28 2026';
const DAYBREAK = 'Daybreak storefront designs';
const st = (still, at) => ({ still: `dc/${still}`, ...(at !== undefined ? { at } : {}) });
const full = (states, c0, c1, extra = {}) => ({
  rect: 'full',
  states,
  c0,
  c1,
  chip: REAL,
  ...extra,
});
const PLAN_WIDE = { x: 236, y: 240, w: 1290 };
const INSPECTOR = (y) => ({ x: 1524, y, w: 392 });

const segments = [
  { id: 'shaw', from: 's01', type: 'shaw' },
  { id: 'helix-intro', from: 's05+2.6', type: 'end' },
  {
    id: 'roster',
    from: 's06',
    type: 'footage',
    panes: [
      full(
        [st('agents')],
        { x: 236, y: 172, w: 1040 },
        { x: 254, y: 206, w: 860 },
        { chipAt: 'bl' },
      ),
    ],
  },
  {
    id: 'plan-start',
    from: 's07',
    type: 'footage',
    panes: [
      full(
        [st('plan-approved'), st('codex-start', 1.0), st('codex-working', 2.2)],
        { x: 330, y: 250, w: 1060 },
        { x: 470, y: 384, w: 780 },
        {
          callouts: [
            { at: 1.4, text: 'Codex · building', strand: 'codex', x: 512, y: 352 },
            {
              at: 2.0,
              text: 'Claude Code · waits on its dependency',
              strand: 'claude',
              x: 877,
              y: 352,
            },
          ],
        },
      ),
    ],
  },
  {
    id: 'many',
    from: 's08',
    type: 'footage',
    panes: [
      {
        rect: 'wide',
        states: [{ still: 'lap/strip-mid' }],
        c0: { x: 640, y: 386, w: 1560 },
        c1: { x: 2500, y: 386, w: 1560 },
      },
    ],
  },
  {
    id: 'team',
    from: 's09',
    type: 'footage',
    panes: [
      full(
        [st('codex-working')],
        { x: 400, y: 240, w: 960 },
        { x: 600, y: 246, w: 560 },
        {
          callouts: [
            {
              at: 0.6,
              text: 'Helix · plans and coordinates the team',
              strand: 'orch',
              x: 880,
              y: 214,
              align: 'center',
            },
          ],
        },
      ),
    ],
  },
  {
    id: 'goal',
    from: 's10',
    type: 'footage',
    panes: [
      {
        rect: 'left',
        states: [st('plan-ready')],
        c0: { x: 244, y: 40, w: 660 },
        c1: { x: 248, y: 44, w: 620 },
        chip: REAL,
        chipAt: 'bl',
        callouts: [{ at: 0.5, text: 'The goal, in your words', strand: 'orch', x: 262, y: 170 }],
      },
      { rect: 'right', states: [st('plan-ready')], c0: INSPECTOR(222), c1: INSPECTOR(222) },
    ],
  },
  {
    id: 'divide',
    from: 's11',
    type: 'footage',
    panes: [
      full(
        [st('plan-ready')],
        { x: 470, y: 330, w: 780 },
        { x: 480, y: 360, w: 740 },
        {
          callouts: [
            { at: 0.4, text: 'Task 1 → Codex', strand: 'codex', x: 571, y: 742 },
            {
              at: 0.8,
              text: 'Task 2 → Claude Code, after task 1',
              strand: 'claude',
              x: 1141,
              y: 742,
              align: 'right',
            },
          ],
        },
      ),
    ],
  },
  {
    id: 'check',
    from: 's12',
    type: 'footage',
    panes: [
      {
        rect: 'left',
        states: [st('ci-passed')],
        c0: { x: 470, y: 380, w: 560 },
        c1: { x: 490, y: 390, w: 520 },
        chip: REAL,
        chipAt: 'bl',
        callouts: [{ at: 0.5, text: 'CI 1/1 passed on PR #1', strand: 'review', x: 500, y: 742 }],
      },
      {
        rect: 'right',
        states: [st('task-prci')],
        c0: INSPECTOR(210),
        c1: INSPECTOR(210),
        edge: 'review',
      },
    ],
  },
  {
    id: 'together',
    from: 's13',
    type: 'footage',
    panes: [
      full(
        [st('receipt-from-merged'), st('complete', 's14+-0.9')],
        { x: 244, y: 560, w: 1100 },
        { x: 250, y: 556, w: 1060 },
        {
          callouts: [
            {
              at: 0.6,
              text: 'Task 2 starts from the merged work of task 1',
              strand: 'orch',
              x: 262,
              y: 822,
              until: 's14+-0.9',
            },
          ],
        },
      ),
    ],
  },
  {
    id: 'helix',
    from: 's14',
    type: 'footage',
    panes: [full([st('complete')], { x: 560, y: 236, w: 640 }, { x: 640, y: 246, w: 480 })],
  },
  // Teamwork insert (insert version only).
  {
    id: 'pair',
    from: 't01',
    type: 'footage',
    panes: [
      full(
        [st('agents')],
        { x: 254, y: 206, w: 860 },
        { x: 254, y: 206, w: 860 },
        { chipAt: 'bl' },
      ),
    ],
  },
  {
    id: 'coordinated',
    from: 't02',
    type: 'footage',
    panes: [full([st('complete')], PLAN_WIDE, { x: 300, y: 250, w: 1150 })],
  },
  {
    id: 'build',
    from: 't03',
    type: 'footage',
    panes: [
      full(
        [st('codex-working')],
        { x: 490, y: 386, w: 720 },
        { x: 498, y: 392, w: 660 },
        {
          edge: 'codex',
          callouts: [{ at: 0.3, text: 'Building', strand: 'codex', x: 512, y: 350 }],
        },
      ),
    ],
  },
  {
    id: 'review-record',
    from: 't04',
    type: 'evidence',
    edge: 'review',
    eyebrow: 'Daybreak storefront build · recorded reviews',
    heading: 'The other agent reviews the work',
    rows: [
      {
        at: 0.4,
        strand: 'claude',
        text: 'Claude Code reviewed the catalogue and submitted an approval.',
        source: 'event 631',
      },
      {
        at: 't05',
        strand: 'claude',
        text: 'Claude Code reviewed the cart and submitted an approval.',
        source: 'event 688',
      },
      {
        at: 't06',
        strand: 'review',
        text: 'When a reviewer could not run, Helix recorded why and fell back to CI.',
        source: 'events 585–624 · 980–999',
      },
    ],
    footnote: 'From the Daybreak run record (docs/daybreak-review-failure.md)',
  },
  {
    id: 'shared',
    from: 't07',
    type: 'footage',
    panes: [full([st('complete')], { x: 480, y: 250, w: 780 }, { x: 490, y: 258, w: 740 })],
  },
  // Online store.
  {
    id: 'store',
    from: 's15',
    type: 'footage',
    panes: [1, 5, 2].map((n, i) => ({
      rect: `third${i + 1}`,
      states: [{ still: `daybreak/design-${n}` }],
      c0: { x: 0, y: 0, w: 1015 },
      c1: { x: 0, y: 40, w: 1015 },
      ...(i === 0 ? { chip: DAYBREAK } : {}),
    })),
  },
  {
    id: 'catalogue-cart',
    from: 's16',
    type: 'footage',
    panes: [
      {
        rect: 'full',
        states: [{ still: 'daybreak/design-1' }],
        c0: { x: 0, y: 540, w: 1015 },
        c1: { x: 0, y: 560, w: 1015 },
        chip: DAYBREAK,
        chipAt: 'tr',
        callouts: [
          { at: 0.4, text: 'Product catalogue', strand: 'codex', x: 560, y: 572, until: 's17' },
          {
            at: 's17',
            text: 'Shopping cart · Add to bag',
            strand: 'claude',
            x: 508,
            y: 980,
            align: 'center',
          },
        ],
      },
    ],
  },
  {
    id: 'assignments',
    from: 's18',
    type: 'footage',
    panes: [
      full(
        [st('tasks-page')],
        { x: 252, y: 108, w: 1000 },
        { x: 256, y: 112, w: 960 },
        { chipAt: 'bl' },
      ),
    ],
  },
  {
    id: 'needs',
    from: 's19',
    type: 'footage',
    panes: [
      full(
        [st('codex-working')],
        { x: 860, y: 386, w: 680 },
        { x: 870, y: 392, w: 620 },
        {
          callouts: [{ at: 0.4, text: 'Waits on task 1', strand: 'claude', x: 941, y: 744 }],
        },
      ),
    ],
  },
  {
    id: 'review-testing',
    from: 's20',
    type: 'footage',
    panes: [
      full(
        [st('ci-running'), st('ci-passed', 1.4), st('pr1-merged', 2.8)],
        { x: 470, y: 384, w: 780 },
        { x: 480, y: 390, w: 740 },
        {
          callouts: [
            { at: 0.4, text: 'CI on every pull request', strand: 'review', x: 571, y: 742 },
          ],
        },
      ),
    ],
  },
  // Watch the work.
  {
    id: 'watch',
    from: 's21',
    type: 'footage',
    panes: [
      {
        rect: 'full',
        states: [
          { still: 'lap/strip-early' },
          { still: 'lap/strip-mid', at: 's22' },
          { still: 'lap/strip-late', at: 's22+3.2' },
        ],
        c0: { x: 620, y: 362, w: 1080 },
        c1: { x: 4080, y: 362, w: 1080 },
      },
    ],
  },
  {
    id: 'building',
    from: 's23',
    type: 'footage',
    panes: [
      full([st('codex-working')], { x: 490, y: 386, w: 720 }, null, {
        edge: 'codex',
        callouts: [{ at: 0.2, text: 'Building', strand: 'codex', x: 512, y: 350 }],
      }),
    ],
  },
  {
    id: 'checking',
    from: 's24',
    type: 'footage',
    panes: [
      full([st('ci-running')], { x: 490, y: 386, w: 720 }, null, {
        edge: 'review',
        callouts: [
          { at: 0.2, text: 'Checking · CI running on PR #1', strand: 'review', x: 512, y: 350 },
        ],
      }),
    ],
  },
  {
    id: 'ready',
    from: 's25',
    type: 'footage',
    panes: [
      full([st('pr1-merged')], { x: 490, y: 386, w: 720 }, null, {
        callouts: [{ at: 0.2, text: 'Ready · CI passed, merged', strand: 'codex', x: 512, y: 350 }],
      }),
    ],
  },
  {
    id: 'waiting',
    from: 's26',
    type: 'footage',
    panes: [
      full([st('codex-working')], { x: 860, y: 386, w: 720 }, null, {
        edge: 'claude',
        callouts: [{ at: 0.2, text: 'Waiting · on task 1', strand: 'claude', x: 882, y: 350 }],
      }),
    ],
  },
  {
    id: 'decision',
    from: 's27',
    type: 'footage',
    panes: [
      {
        rect: 'left',
        states: [st('plan-ready'), st('plan-approved', 2.6)],
        c0: { x: 470, y: 250, w: 780 },
        c1: { x: 480, y: 255, w: 760 },
        chip: REAL,
        chipAt: 'bl',
      },
      {
        rect: 'right',
        states: [st('plan-ready'), st('plan-approved', 2.6)],
        c0: INSPECTOR(492),
        c1: INSPECTOR(492),
        edge: 'orch',
      },
    ],
  },
  // Stay involved.
  {
    id: 'shaping',
    from: 's28',
    type: 'footage',
    panes: [
      {
        rect: 'left',
        states: [st('complete'), st('task-selected', 0.8)],
        c0: { x: 470, y: 250, w: 780 },
        c1: { x: 480, y: 255, w: 760 },
        chip: REAL,
        chipAt: 'bl',
      },
      {
        rect: 'right',
        states: [st('complete'), st('task-selected', 0.8)],
        c0: INSPECTOR(210),
        c1: INSPECTOR(210),
      },
    ],
  },
  {
    id: 'coordination',
    from: 's29',
    type: 'footage',
    panes: [
      {
        rect: 'left',
        states: [st('task-selected'), st('task-why', 0.5)],
        c0: { x: 480, y: 255, w: 760 },
        chip: REAL,
        chipAt: 'bl',
      },
      {
        rect: 'right',
        states: [st('task-selected'), st('task-why', 0.5)],
        c0: INSPECTOR(330),
        c1: INSPECTOR(360),
        callouts: [
          { at: 0.9, text: 'Why · every step and its cause', strand: 'orch', x: 1540, y: 790 },
        ],
      },
    ],
  },
  {
    id: 'handoffs',
    from: 's30',
    type: 'footage',
    panes: [
      full(
        [st('tasks-page'), st('prs-page', 's30+3.0')],
        { x: 252, y: 108, w: 1000 },
        { x: 256, y: 104, w: 980 },
        { chipAt: 'bl' },
      ),
    ],
  },
  // Close.
  {
    id: 'ambition',
    from: 's31',
    type: 'footage',
    panes: [full([st('complete')], { x: 480, y: 250, w: 780 }, { x: 236, y: 62, w: 1290 })],
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
      note: 'Generated by tools/edit.src.mjs: edit there. Each segment starts at its `from` phrase (minus lead) and runs to the next. Footage is real Helix replay stills (dc) or the supplied Daybreak designs.',
      lead: 0.5,
      segments,
    },
    null,
    2,
  ) + '\n',
);
console.log('edit.json:', segments.length, 'segments');
