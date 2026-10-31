// Generates promo/footage/recordings/daybreak-storefront.helixlog: an invented, schema-valid Helix
// run of the Daybreak storefront build, so the real app UI renders new agents, plan review, Design,
// agent reviews and Output for the promo. Usage: npx tsx promo/tools/make-recording.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  helixEventSchema,
  serializeHelixlog,
  type HelixEvent,
} from '../../packages/contracts/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectId = 'project_daybreak_storefront';
const orchestrator = 'session_daybreak_helix';
const start = Date.UTC(2026, 9, 31, 14, 2, 0);
let clock = 0;
const ts = (advance = 7) => new Date(start + (clock += advance) * 1000).toISOString();
const events: HelixEvent[] = [];
function add(
  type: string,
  payload: unknown,
  sessionId?: string,
  planNodeId?: string,
  advance?: number,
): number {
  events.push(
    helixEventSchema.parse({
      v: 1,
      seq: events.length + 1,
      ts: ts(advance),
      projectId,
      type,
      payload,
      ...(sessionId ? { sessionId } : {}),
      ...(planNodeId ? { planNodeId } : {}),
    }),
  );
  return events.length;
}
const hash = (seed: string) => {
  let h = 2166136261;
  let out = '';
  for (let i = 0; out.length < 64; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i % seed.length) ^ i, 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
};
const sha = (seed: string) => hash(seed).slice(0, 40);

const project = {
  id: projectId,
  name: 'daybreak-storefront',
  repoPath: '<repo>',
  defaultBranch: 'main',
  github: { owner: 'daybreak-coffee', repo: 'storefront' },
  defaultAgent: 'codex',
  createdAt: new Date(start).toISOString(),
};
add('project.added', { project }, undefined, undefined, 0);

// The brief V.A.L.E. gathered by voice and handed to Helix's guided intake.
const answers = [
  {
    id: 'q1',
    question: 'Who is the store for?',
    answer: 'Coffee lovers ordering beans for home, plus regulars who want a subscription.',
    source: 'user',
  },
  {
    id: 'q2',
    question: 'What must work on launch day?',
    answer: 'Catalogue, product pages, a bag and checkout, and subscriptions.',
    source: 'user',
  },
  {
    id: 'q3',
    question: 'How should it feel?',
    answer: 'Bright and bold, like a sunrise. Use the Daybreak blue and orange.',
    assistantMessage: 'I will send these references to Design.',
    source: 'user',
  },
  {
    id: 'q4',
    question: 'Anything we must not break?',
    answer: 'Accessibility and fast pages on phones.',
    source: 'recommendation-accepted',
  },
];
const brief =
  'Daybreak storefront: a bright, sunrise-styled online coffee store. Customers browse a product catalogue, open product pages, add beans to a bag, check out, and can subscribe for repeat deliveries. Must be accessible and fast on phones.';
add(
  'session.created',
  {
    session: {
      id: orchestrator,
      projectId,
      role: 'orchestrator',
      agent: 'claude-code',
      title: 'Daybreak storefront',
      prompt: brief,
      reviewedBrief: {
        intakeId: 'intake_daybreak_vale',
        revision: 3,
        text: brief,
        approvedAt: ts(0),
        answers,
        assumptions: ['Payments use the existing provider sandbox.', 'Ship to the US first.'],
      },
      interface: 'chat',
      createdAt: ts(0),
    },
  },
  orchestrator,
);
add('session.started', {}, orchestrator);
add('activity.changed', { activity: 'active' }, orchestrator);

// Design: three concepts from the supplied Daybreak designs, then an approved palette.
const img = (n: number) =>
  `data:image/webp;base64,${fs.readFileSync(path.join(root, `footage/daybreak/design-${n}.webp`)).toString('base64')}`;
const palette = {
  name: 'Sunrise',
  background: '#FFF6DC',
  foreground: '#14161F',
  primary: '#0B44B8',
  accent: '#F25A2A',
};
const concepts = [
  {
    id: 'concept-sunrise',
    title: 'Rise. Brew. Shine.',
    imageUrl: img(1),
    mimeType: 'image/webp',
    prompt: 'Bold sunrise storefront',
    rationale: 'Loudest brand moment; product grid reads at a glance.',
    tradeoffs: ['Busy on small screens'],
    recommended: true,
  },
  {
    id: 'concept-good-days',
    title: 'Good days start here',
    imageUrl: img(5),
    mimeType: 'image/webp',
    prompt: 'Warm editorial storefront',
    rationale: 'Editorial warmth for the story pages.',
    tradeoffs: ['Less distinct palette'],
    recommended: false,
  },
  {
    id: 'concept-new-energy',
    title: 'Good coffee. New energy.',
    imageUrl: img(2),
    mimeType: 'image/webp',
    prompt: 'Fresh, botanical storefront',
    rationale: 'Calm and premium; strong subscription banner.',
    tradeoffs: ['Cooler than the brand brief'],
    recommended: false,
  },
];
const designBase = {
  sessionId: orchestrator,
  brief: 'Bright and bold, like a sunrise. Daybreak blue and orange.',
  references: [],
  receipts: [],
};
add(
  'design.updated',
  {
    design: {
      ...designBase,
      revision: 1,
      status: 'ready',
      rounds: [{ revision: 1, jobId: 'design_round_1', concepts, palette }],
      conversation: [
        {
          role: 'user',
          text: 'Bright and bold, like a sunrise. Use the Daybreak blue and orange.',
          revision: 1,
          references: [],
        },
        {
          role: 'helix',
          text: 'Three directions. I recommend Rise. Brew. Shine. for the storefront.',
          revision: 1,
          references: [],
        },
      ],
    },
  },
  orchestrator,
);
add(
  'design.updated',
  {
    design: {
      ...designBase,
      revision: 2,
      status: 'approved',
      rounds: [{ revision: 1, jobId: 'design_round_1', concepts, palette }],
      conversation: [
        {
          role: 'user',
          text: 'Go with the sunrise one.',
          revision: 2,
          references: [],
        },
      ],
      decision: {
        revision: 2,
        conceptIds: ['concept-sunrise'],
        rationale: 'Approved by voice through V.A.L.E.: the sunrise direction and palette.',
        palette,
      },
    },
  },
  orchestrator,
  undefined,
  20,
);

// The plan: twelve new agents with real dependencies between their tasks.
const spec: [string, string, 'codex' | 'claude-code', string[], string[]][] = [
  ['tokens', 'Design system tokens', 'claude-code', [], ['src/styles/**']],
  ['catalogue', 'Product catalogue', 'codex', ['tokens'], ['src/catalogue/**']],
  ['product-pages', 'Product detail pages', 'claude-code', ['catalogue'], ['src/product/**']],
  ['bag', 'Shopping bag', 'codex', ['tokens'], ['src/bag/**']],
  ['checkout', 'Checkout flow', 'claude-code', ['bag'], ['src/checkout/**']],
  ['subscriptions', 'Subscriptions', 'codex', ['bag'], ['src/subscriptions/**']],
  ['story', 'Our story page', 'claude-code', ['tokens'], ['src/story/**']],
  ['search', 'Search and filters', 'codex', ['catalogue'], ['src/search/**']],
  ['newsletter', 'Newsletter signup', 'claude-code', ['tokens'], ['src/newsletter/**']],
  ['a11y', 'Accessibility audit', 'claude-code', ['product-pages', 'checkout'], ['src/a11y/**']],
  ['speed', 'Mobile speed budget', 'codex', ['product-pages'], ['src/perf/**']],
  ['launch', 'Launch checklist', 'codex', ['a11y', 'speed', 'subscriptions'], ['docs/launch/**']],
];
const nodes = spec.map(([id, title, agent, dependsOn, files]) => ({
  id,
  title,
  description: title,
  acceptance: [`${title} works on phone and desktop`, 'Tests cover the new behaviour'],
  files,
  dependsOn,
  agent,
  rationale: dependsOn.length
    ? `Needs ${dependsOn.join(', ')} first.`
    : 'Foundation the other tasks build on.',
  sessionId: `session_daybreak_${id.replace(/-/g, '_')}`,
}));
const firstNodes = nodes.map((n) => (n.id === 'checkout' ? { ...n, dependsOn: ['catalogue'] } : n));
const plan = (id: string, n: typeof nodes, review: unknown) => ({
  id,
  projectId,
  orchestratorSessionId: orchestrator,
  goal: brief,
  nodes: n,
  review,
  createdAt: ts(0),
});
// Attempt 1: Codex reviews the plan and pushes back on one dependency.
const firstReview = {
  hash: hash('plan-v1'),
  attempt: 1,
  status: 'reviewing',
  reviewer: 'codex',
  message: 'Codex is reviewing the plan.',
};
add('plan.submitted', { plan: plan('plan_daybreak_v1', firstNodes, firstReview) }, orchestrator);
add(
  'plan.reviewed',
  {
    planId: 'plan_daybreak_v1',
    review: {
      ...firstReview,
      status: 'changes_requested',
      message: 'Checkout depends on the bag, not the catalogue.',
      result: {
        verdict: 'changes_requested',
        summary: 'One dependency is wrong: checkout reads the bag contract.',
        findings: [
          {
            nodeIds: ['checkout'],
            severity: 'blocking',
            evidence:
              'Checkout totals come from the bag API, which the catalogue task does not own.',
            change: 'Make Checkout flow depend on Shopping bag.',
          },
        ],
      },
    },
  },
  orchestrator,
  undefined,
  25,
);
// Attempt 2: the corrected plan passes review, then the human approves it.
const planId = 'plan_daybreak_v2';
const secondReview = {
  hash: hash('plan-v2'),
  attempt: 2,
  status: 'reviewing',
  reviewer: 'codex',
  message: 'Codex is reviewing the revised plan.',
};
add('plan.submitted', { plan: plan(planId, nodes, secondReview) }, orchestrator, undefined, 15);
add(
  'plan.reviewed',
  {
    planId,
    review: {
      ...secondReview,
      status: 'passed',
      message: 'Dependencies and file ownership check out.',
      result: {
        verdict: 'passed',
        summary: 'Dependencies and file ownership check out.',
        findings: [],
      },
    },
  },
  orchestrator,
  undefined,
  20,
);
add(
  'plan.approved',
  { planId, approvedBy: 'human', reviewHash: secondReview.hash },
  orchestrator,
  undefined,
  12,
);

const sessionFor = (node: (typeof nodes)[number]) => ({
  id: node.sessionId,
  projectId,
  role: 'worker',
  agent: node.agent,
  title: node.title,
  prompt: node.description,
  planNodeId: node.id,
  parentSessionId: orchestrator,
  interface: 'chat',
  createdAt: ts(0),
});
const checks = (passed: number, pending: number, total = 4) => ({
  total,
  passed,
  failed: 0,
  pending,
  failingNames: [],
});
let prNumber = 40;
const prs = new Map<string, { number: number; head: string }>();
function startWorker(id: string) {
  const node = nodes.find((n) => n.id === id)!;
  add('session.created', { session: sessionFor(node) }, node.sessionId, node.id, 3);
  add(
    'worktree.created',
    {
      branch: `helix/${node.id}`,
      path: `<worktrees>/${node.sessionId}`,
      baseSha: sha(`base-${id}`),
    },
    node.sessionId,
    node.id,
    1,
  );
  add('session.started', {}, node.sessionId, node.id, 1);
  add('activity.changed', { activity: 'active' }, node.sessionId, node.id, 1);
  add(
    'plan.node_updated',
    { nodeId: node.id, sessionId: node.sessionId, note: 'Dependencies merged; worker started.' },
    node.sessionId,
    node.id,
    1,
  );
}
function openPr(id: string) {
  const node = nodes.find((n) => n.id === id)!;
  const number = ++prNumber;
  const head = sha(`head-${id}`);
  prs.set(id, { number, head });
  add(
    'worktree.diff_updated',
    { filesChanged: 3 + (number % 5), insertions: 120 + number * 3, deletions: 4 + (number % 9) },
    node.sessionId,
    node.id,
    4,
  );
  add(
    'pr.opened',
    {
      pr: {
        number,
        url: `https://github.com/daybreak-coffee/storefront/pull/${number}`,
        state: 'open',
        draft: false,
        headSha: head,
        mergeable: 'mergeable',
        checks: checks(0, 4),
        review: { decision: 'none', unresolvedThreads: 0 },
        updatedAt: ts(0),
      },
    },
    node.sessionId,
    node.id,
    2,
  );
  add('activity.changed', { activity: 'idle' }, node.sessionId, node.id, 1);
}
function ciPass(id: string) {
  const node = nodes.find((n) => n.id === id)!;
  add(
    'ci.updated',
    { prNumber: prs.get(id)!.number, checks: checks(4, 0) },
    node.sessionId,
    node.id,
    5,
  );
}
function review(id: string, verdict: 'approve' | 'request_changes') {
  const node = nodes.find((n) => n.id === id)!;
  const pr = prs.get(id)!;
  const rid = `${node.sessionId}_review`;
  const other = node.agent === 'codex' ? 'claude-code' : 'codex';
  if (!events.some((e) => e.sessionId === rid)) {
    add(
      'session.created',
      {
        session: {
          id: rid,
          projectId,
          role: 'reviewer',
          agent: other,
          title: `Review: ${node.title}`,
          prompt: `Review PR #${pr.number} against its task.`,
          interface: 'chat',
          createdAt: ts(0),
          parentSessionId: node.sessionId,
        },
      },
      rid,
      undefined,
      1,
    );
    add('session.started', {}, rid, undefined, 1);
  }
  add(
    'agent_review.requested',
    { workerSessionId: node.sessionId, prNumber: pr.number, headSha: pr.head },
    rid,
    undefined,
    1,
  );
  add('activity.changed', { activity: 'active' }, rid, undefined, 1);
  add(
    'agent_review.submitted',
    {
      workerSessionId: node.sessionId,
      prNumber: pr.number,
      headSha: pr.head,
      review:
        verdict === 'approve'
          ? {
              verdict,
              summary: `${node.title} matches its task and the approved design.`,
              findings: [],
            }
          : {
              verdict,
              summary: 'The bag total ignores the subscription discount.',
              findings: [
                {
                  severity: 'major',
                  title: 'Subscription discount missing from bag total',
                  detail: 'Subscribed items show full price in the bag.',
                  file: 'src/bag/total.ts',
                  line: 28,
                },
              ],
            },
    },
    rid,
    undefined,
    9,
  );
  add('activity.changed', { activity: 'idle' }, rid, undefined, 1);
  if (verdict === 'request_changes') {
    add(
      'feedback.routed',
      {
        prNumber: pr.number,
        reason: 'review_findings',
        summary: `Review requested changes:\n- [major] Subscription discount missing from bag total (src/bag/total.ts:28)`,
        toSessionId: node.sessionId,
      },
      node.sessionId,
      node.id,
      1,
    );
    add('activity.changed', { activity: 'active' }, node.sessionId, node.id, 1);
    const fixed = sha(`fix-${id}`);
    prs.set(id, { ...pr, head: fixed });
    add(
      'pr.updated',
      {
        pr: {
          number: pr.number,
          url: `https://github.com/daybreak-coffee/storefront/pull/${pr.number}`,
          state: 'open',
          draft: false,
          headSha: fixed,
          mergeable: 'mergeable',
          checks: checks(4, 0),
          review: { decision: 'none', unresolvedThreads: 0 },
          updatedAt: ts(0),
        },
      },
      node.sessionId,
      node.id,
      12,
    );
    add('activity.changed', { activity: 'idle' }, node.sessionId, node.id, 1);
  }
}
function merge(id: string) {
  const node = nodes.find((n) => n.id === id)!;
  const pr = prs.get(id)!;
  add(
    'pr.merged',
    { prNumber: pr.number, mergeSha: sha(`merge-${id}`) },
    node.sessionId,
    node.id,
    4,
  );
  add('session.exited', { code: 0 }, node.sessionId, node.id, 1);
}
function finish(id: string, verdict: 'approve' | 'request_changes' = 'approve') {
  openPr(id);
  ciPass(id);
  review(id, verdict);
  if (verdict === 'request_changes') review(id, 'approve');
  merge(id);
}

// Wave 1: the foundation.
startWorker('tokens');
finish('tokens');
// Wave 2: everything that only needs tokens runs in parallel.
startWorker('catalogue');
startWorker('bag');
startWorker('story');
startWorker('newsletter');
finish('catalogue');
// Wave 3: work that needs the catalogue starts while the bag and story pages are still going.
startWorker('product-pages');
startWorker('search');
finish('story');
finish('bag', 'request_changes');
finish('newsletter');
// Wave 4.
startWorker('checkout');
startWorker('subscriptions');
add(
  'approval.requested',
  {
    approval: {
      id: 'approval_daybreak_payments',
      sessionId: nodes[4]!.sessionId,
      kind: 'network',
      summary: 'Allow the payments sandbox for checkout tests',
      detail: 'Checkout tests call the payment provider sandbox.',
      scope: 'session',
      requestedAt: ts(0),
    },
  },
  nodes[4]!.sessionId,
  'checkout',
  2,
);
finish('product-pages');
add(
  'approval.decided',
  { approvalId: 'approval_daybreak_payments', decision: 'approved' },
  nodes[4]!.sessionId,
  'checkout',
  6,
);
startWorker('speed');
finish('search');
finish('checkout');
finish('subscriptions');
startWorker('a11y');
finish('speed');
finish('a11y');
startWorker('launch');
finish('launch');

// Output: the assembled storefront previewed at the merged head.
const outputBase = {
  workerSessionId: nodes[11]!.sessionId,
  buildSessionId: orchestrator,
  branch: 'main',
  headSha: sha('merge-launch'),
  briefHash: hash('brief'),
  designHash: hash('design-sunrise'),
};
add(
  'output.updated',
  {
    output: {
      ...outputBase,
      revision: 1,
      status: 'starting',
      message: 'Starting the preview.',
      feedback: [],
    },
  },
  outputBase.workerSessionId,
  'launch',
  4,
);
add(
  'output.updated',
  {
    output: {
      ...outputBase,
      revision: 2,
      artifactHash: hash('artifact'),
      status: 'running',
      message: 'The Daybreak storefront is running at the merged head.',
      feedback: [
        {
          id: 'feedback_hero',
          revision: 2,
          headSha: sha('merge-launch'),
          text: 'Make the hero headline bigger on phones.',
          status: 'resolved',
          disposition: 'Hero scales up below 600px.',
        },
      ],
    },
  },
  outputBase.workerSessionId,
  'launch',
  9,
);
add('activity.changed', { activity: 'idle' }, orchestrator);

const out = path.join(root, 'footage/recordings/daybreak-storefront.helixlog');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  serializeHelixlog({
    header: {
      format: 'helixlog',
      version: 1,
      project,
      recordedAt: events.at(-1)!.ts,
      redactions: [],
    },
    events,
  }),
);
console.log(`wrote ${out}: ${events.length} events`);
