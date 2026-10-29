import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { fixtures, submitPlanRequestSchema } from '@helix/contracts';
import { ORCHESTRATOR_PROMPT, orchestratorPrompt } from '../index.js';

const project = fixtures.passwordResetProject;
const session = fixtures.passwordResetRun.find((event) => event.type === 'session.created')!.payload
  .session;

test('public prompt export loads the Markdown and includes planning rules', async () => {
  expect(ORCHESTRATOR_PROMPT).toBe(await readFile(new URL('./prompt.md', import.meta.url), 'utf8'));
  for (const rule of [
    'read-only',
    'Never edit, create or',
    'git write commands',
    'independently',
    'dependsOn',
    'description',
    'acceptance',
    'non-empty',
    'repository-relative globs',
    'rationale',
    'codex',
    'overlapping files',
    'contract task',
    'HELIX_PROJECT_ID',
    'HELIX_SESSION_ID',
    'helix plan submit <scratch folder>/plan.json',
    'fix the plan',
    'resubmit',
    'waiting for their approval',
    'then stop',
    'Never try to approve',
    'helix explain "<why>" --node <id>',
    'outside the repository',
  ])
    expect(ORCHESTRATOR_PROMPT).toContain(rule);
});

test('orchestratorPrompt prepends the project and session header', () => {
  expect(orchestratorPrompt({ project, session })).toBe(
    `Project: ${project.name}\nDefault branch: ${project.defaultBranch}\nProject id: ${project.id}\nSession id: ${session.id}\n\n${ORCHESTRATOR_PROMPT}`,
  );
});

test('example is a valid submission with a contract and two independent consumers', () => {
  const example = ORCHESTRATOR_PROMPT.match(/```json\n([\s\S]*?)\n```/)?.[1];
  expect(example).toBeTruthy();
  const plan = submitPlanRequestSchema.parse(JSON.parse(example!));
  expect(plan.nodes).toHaveLength(3);
  const [contract, ...consumers] = plan.nodes;
  expect(contract!.dependsOn).toEqual([]);
  for (const node of consumers) expect(node.dependsOn).toEqual([contract!.id]);
  expect(new Set(plan.nodes.flatMap((node) => node.files)).size).toBe(3);
});

test('tsx resolves the package export and Markdown independently of the invoking cwd', async () => {
  const script = `import { ORCHESTRATOR_PROMPT, orchestratorPrompt } from '@helix/harness'; console.log(JSON.stringify({ prompt: ORCHESTRATOR_PROMPT, header: orchestratorPrompt(${JSON.stringify({ project, session })}) }));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(import.meta.resolve('tsx/cli')), '--eval', script],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, INIT_CWD: tmpdir() },
      windowsHide: true,
      timeout: 20_000,
    },
  );
  expect(JSON.parse(stdout)).toEqual({
    prompt: ORCHESTRATOR_PROMPT,
    header: orchestratorPrompt({ project, session }),
  });
}, 25_000);
