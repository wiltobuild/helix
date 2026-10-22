#!/usr/bin/env node
// Coordinates agents (ours and our teammates') through GitHub issues.
//
//   node scripts/agent-tasks.mjs list            show open agent tasks and their state
//   node scripts/agent-tasks.mjs next            print the first task that is ready to claim
//   node scripts/agent-tasks.mjs claim <issue>   claim it and create its branch
//   node scripts/agent-tasks.mjs release <issue> give a claimed task back
//
// A task is an open issue labeled `agent-task`. It is ready when nobody is assigned and every
// issue named in a "Blocked by #N" line is closed. Claiming assigns you, adds `in-progress`,
// re-reads the issue to detect a race, and creates `agent/<issue>-<slug>` from the base branch.
// Requires an authenticated `gh` CLI.
import { execFileSync } from 'node:child_process';

const BASE = process.env.HELIX_BASE_BRANCH ?? 'wave1/integration';
const TASK_LABEL = 'agent-task';
const CLAIM_LABEL = 'in-progress';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const gh = (args) => run('gh', args);
const git = (args) => run('git', args);
const json = (args) => JSON.parse(gh(args));

function blockers(body) {
  return [...(body ?? '').matchAll(/blocked by\s+#(\d+)/gi)].map((m) => Number(m[1]));
}

function openIssueNumbers() {
  return new Set(
    json(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number']).map(
      (i) => i.number,
    ),
  );
}

function tasks() {
  const open = openIssueNumbers();
  return json([
    'issue',
    'list',
    '--state',
    'open',
    '--label',
    TASK_LABEL,
    '--limit',
    '200',
    '--json',
    'number,title,assignees,labels,body',
  ])
    .sort((a, b) => a.number - b.number)
    .map((i) => {
      const waitingOn = blockers(i.body).filter((n) => open.has(n));
      const claimedBy = i.assignees.map((a) => a.login);
      const state = claimedBy.length ? 'claimed' : waitingOn.length ? 'blocked' : 'ready';
      return { ...i, waitingOn, claimedBy, state };
    });
}

function slug(title) {
  return title
    .toLowerCase()
    .replace(/\[[^\]]*\]\s*/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function list() {
  for (const t of tasks()) {
    const detail =
      t.state === 'claimed'
        ? `claimed by ${t.claimedBy.join(', ')}`
        : t.state === 'blocked'
          ? `waiting on ${t.waitingOn.map((n) => `#${n}`).join(', ')}`
          : 'ready';
    console.log(`#${t.number}  ${t.state.padEnd(7)}  ${t.title}  (${detail})`);
  }
}

function next() {
  const ready = tasks().find((t) => t.state === 'ready');
  if (!ready) {
    console.log('No task is ready. Run `list` to see what is blocked or claimed.');
    process.exitCode = 1;
    return;
  }
  console.log(`#${ready.number}  ${ready.title}`);
}

function claim(number) {
  const me = gh(['api', 'user', '--jq', '.login']);
  const before = json([
    'issue',
    'view',
    String(number),
    '--json',
    'state,assignees,labels,title,body',
  ]);
  if (before.state !== 'OPEN') throw new Error(`#${number} is closed.`);
  if (!before.labels.some((l) => l.name === TASK_LABEL))
    throw new Error(`#${number} is not labeled ${TASK_LABEL}.`);
  if (before.assignees.length)
    throw new Error(
      `#${number} is already claimed by ${before.assignees.map((a) => a.login).join(', ')}.`,
    );
  const open = openIssueNumbers();
  const waitingOn = blockers(before.body).filter((n) => open.has(n));
  if (waitingOn.length)
    throw new Error(`#${number} is blocked by ${waitingOn.map((n) => `#${n}`).join(', ')}.`);

  gh(['issue', 'edit', String(number), '--add-assignee', '@me', '--add-label', CLAIM_LABEL]);

  // GitHub has no atomic claim: if someone else was assigned at the same moment, back off.
  const after = json(['issue', 'view', String(number), '--json', 'assignees']);
  const others = after.assignees.map((a) => a.login).filter((l) => l !== me);
  if (others.length) {
    gh(['issue', 'edit', String(number), '--remove-assignee', '@me']);
    throw new Error(
      `#${number} was claimed by ${others.join(', ')} at the same time. Pick another task.`,
    );
  }

  const branch = `agent/${number}-${slug(before.title)}`;
  git(['fetch', 'origin', BASE]);
  git(['switch', '-c', branch, `origin/${BASE}`]);
  gh([
    'issue',
    'comment',
    String(number),
    '--body',
    `Claimed by @${me}. Working on \`${branch}\` from \`${BASE}\`.`,
  ]);
  console.log(
    `Claimed #${number}. You are on ${branch}. Open your PR against ${BASE} with "Closes #${number}".`,
  );
}

function release(number) {
  gh(['issue', 'edit', String(number), '--remove-assignee', '@me', '--remove-label', CLAIM_LABEL]);
  gh(['issue', 'comment', String(number), '--body', 'Released. This task is available again.']);
  console.log(`Released #${number}.`);
}

const [command, arg] = process.argv.slice(2);
try {
  if (command === 'list') list();
  else if (command === 'next') next();
  else if (command === 'claim' && arg) claim(Number(arg.replace('#', '')));
  else if (command === 'release' && arg) release(Number(arg.replace('#', '')));
  else {
    console.log(
      'Usage: node scripts/agent-tasks.mjs <list | next | claim <issue> | release <issue>>',
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
