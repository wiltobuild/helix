#!/usr/bin/env node
// Creates (or reuses) the private GitHub sandbox used by the real GitHub E2E test
// (apps/daemon/src/github-real.e2e.test.ts) and resets its main branch.
//
// The sandbox's only check is named with the instruction an agent needs, because
// Helix's CI feedback carries failing check names: every new branch fails until it
// adds CI_FIXED.md containing the word "fixed". main must never contain that file,
// so a previous run's merge cannot make the next run pass on its first attempt.
//
// Usage: node scripts/e2e/setup-github-sandbox.mjs   → prints the sandbox as JSON.
// Needs `gh` signed in with the repo and workflow scopes. Override the repository
// with HELIX_E2E_SANDBOX_REPO=owner/name. Refuses to touch a public repository.
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const NAME = 'helix-e2e-sandbox';
export const MARKER = 'CI_FIXED.md';
export const CHECK_NAME = `Add ${MARKER} at the repository root containing the word fixed`;

const WORKFLOW = `# Managed by helix/scripts/e2e/setup-github-sandbox.mjs. Do not edit by hand.
name: Helix E2E sandbox

on:
  pull_request:

permissions:
  contents: read

jobs:
  marker:
    name: ${CHECK_NAME}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955 # v4.3.0
      - name: Require ${MARKER}
        run: |
          if grep -qiw fixed ${MARKER} 2>/dev/null; then
            echo "${MARKER} found."
          else
            echo "::error file=${MARKER}::${CHECK_NAME}."
            exit 1
          fi
`;

const README = `# Helix E2E sandbox

Throwaway repository for Helix's real GitHub feedback-loop test. Managed by
\`scripts/e2e/setup-github-sandbox.mjs\` in https://github.com/wiltobuild/helix.
Every pull request fails its check until it adds \`${MARKER}\`; the test then
expects Helix to route that failure back to the agent and merge only on request.
`;

async function gh(args, input) {
  const child = exec('gh', args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  if (input !== undefined) {
    child.child.stdin.end(input);
  }
  const { stdout } = await child;
  return stdout.trim();
}

async function api(method, path, body) {
  const args = ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json'];
  if (body !== undefined) args.push('--input', '-');
  const out = await gh(args, body === undefined ? undefined : JSON.stringify(body));
  return out ? JSON.parse(out) : undefined;
}

async function getFile(full, path) {
  try {
    return await api('GET', `repos/${full}/contents/${path}?ref=main`);
  } catch (error) {
    if (String(error.stderr ?? error.message).includes('404')) return undefined;
    throw error;
  }
}

async function putFile(full, path, content, message) {
  const existing = await getFile(full, path);
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  if (existing && existing.content?.replace(/\n/g, '') === encoded) return false;
  await api('PUT', `repos/${full}/contents/${path}`, {
    message,
    content: encoded,
    branch: 'main',
    ...(existing ? { sha: existing.sha } : {}),
  });
  return true;
}

export async function setupGitHubSandbox(options = {}) {
  const log = options.log ?? ((message) => console.error(message));
  const owner = options.owner ?? (await gh(['api', 'user', '--jq', '.login']));
  const full = options.repo ?? process.env.HELIX_E2E_SANDBOX_REPO ?? `${owner}/${NAME}`;
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(full))
    throw new Error(`Invalid sandbox repository: ${full}`);

  let repo;
  try {
    repo = await api('GET', `repos/${full}`);
  } catch (error) {
    if (!String(error.stderr ?? error.message).includes('404')) throw error;
  }
  if (!repo) {
    log(`Creating private sandbox ${full}`);
    await gh([
      'repo',
      'create',
      full,
      '--private',
      '--disable-wiki',
      '--disable-issues',
      '--description',
      'Throwaway sandbox for the Helix real GitHub E2E test',
    ]);
    repo = await api('GET', `repos/${full}`);
  }
  if (!repo.private) throw new Error(`Refusing to use ${full}: it is not private.`);

  // README first: on an empty repository this creates main.
  await putFile(full, 'README.md', README, 'Helix E2E sandbox: README');
  if (await putFile(full, '.github/workflows/helix-e2e.yml', WORKFLOW, 'Helix E2E sandbox: CI'))
    log('Updated sandbox workflow');
  const marker = await getFile(full, MARKER);
  if (marker) {
    log(`Removing ${MARKER} from main so the next branch fails its first run`);
    await api('DELETE', `repos/${full}/contents/${MARKER}`, {
      message: `Helix E2E sandbox: reset ${MARKER}`,
      sha: marker.sha,
      branch: 'main',
    });
  }
  return {
    fullName: full,
    owner: full.split('/')[0],
    name: full.split('/')[1],
    cloneUrl: `https://github.com/${full}.git`,
    defaultBranch: 'main',
    checkName: CHECK_NAME,
    marker: MARKER,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setupGitHubSandbox()
    .then((sandbox) => console.log(JSON.stringify(sandbox)))
    .catch((error) => {
      console.error(error.stderr || error.message || error);
      process.exitCode = 1;
    });
}
