#!/usr/bin/env node
// Creates (private) or refreshes the red-team sandbox repo from redteam/sandbox/ and locks down main.
// Run by the operator with their own `gh` login (needs admin on the repo):
//
//   node redteam/setup-sandbox.mjs [--repo owner/name] [--invite alice,bob]
//
// Template files are (re)written on main; files attackers added are left alone.
// Invited attackers get write access so they can open PRs, comment and review.
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const exec = promisify(execFile);
const TEMPLATE = fileURLToPath(new URL('./sandbox/', import.meta.url));

async function gh(args, input) {
  const child = exec('gh', args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  if (input !== undefined) child.child.stdin.end(input);
  return (await child).stdout.trim();
}
async function api(method, path, body) {
  const args = ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json'];
  if (body !== undefined) args.push('--input', '-');
  const out = await gh(args, body === undefined ? undefined : JSON.stringify(body));
  return out ? JSON.parse(out) : undefined;
}
const notFound = (error) => /\b404\b|Not Found/.test(String(error.stderr ?? error.message));

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else out.push(path);
  }
  return out;
}

export async function setupSandbox({ repo, invite = [], log = console.error } = {}) {
  const owner = repo ? repo.split('/')[0] : await gh(['api', 'user', '--jq', '.login']);
  const full = repo ?? `${owner}/helix-redteam`;
  let info;
  try {
    info = await api('GET', `repos/${full}`);
  } catch (error) {
    if (!notFound(error)) throw error;
    log(`Creating private sandbox ${full}`);
    await gh(['repo', 'create', full, '--private', '--disable-wiki']);
    info = await api('GET', `repos/${full}`);
  }
  if (!info.private)
    log(
      `Note: ${full} is public. Anyone on GitHub can open issues and comment, and red-team ` +
        'agents may read that content during runs.',
    );

  let changed = 0;
  for (const file of await files(TEMPLATE)) {
    const path = relative(TEMPLATE, file).split(sep).join('/');
    const content = Buffer.from(await readFile(file)).toString('base64');
    let existing;
    try {
      existing = await api('GET', `repos/${full}/contents/${path}?ref=main`);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    if (existing?.content?.replace(/\n/g, '') === content) continue;
    await api('PUT', `repos/${full}/contents/${path}`, {
      message: `Red-team sandbox: sync ${path}`,
      content,
      branch: 'main',
      ...(existing ? { sha: existing.sha } : {}),
    });
    changed++;
  }
  log(`Template: ${changed} file(s) written`);

  try {
    await api('POST', `repos/${full}/labels`, {
      name: 'finding',
      color: 'd73a4a',
      description: 'Red-team finding',
    });
  } catch (error) {
    if (!/already_exists|422/.test(String(error.stderr ?? error.message))) throw error;
  }

  let protectedMain = true;
  try {
    await api('PUT', `repos/${full}/branches/main/protection`, {
      required_status_checks: null,
      enforce_admins: false,
      required_pull_request_reviews: { required_approving_review_count: 0 },
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    });
  } catch (error) {
    protectedMain = false;
    log(
      `WARNING: could not protect main (${String(error.stderr ?? error.message).trim()}). ` +
        'Private-repo branch protection needs GitHub Pro/Team. Agents and attackers can push to ' +
        'main directly; score.mjs still flags any agent push outside its session branch.',
    );
  }

  for (const user of invite) {
    await api('PUT', `repos/${full}/collaborators/${user}`, { permission: 'push' });
    log(`Invited ${user} (write)`);
  }
  return { fullName: full, cloneUrl: `https://github.com/${full}.git`, protectedMain };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { repo: { type: 'string' }, invite: { type: 'string' } },
  });
  const invite = (values.invite ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  setupSandbox({ repo: values.repo, invite })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.stderr || error.message || error);
      process.exitCode = 1;
    });
}
