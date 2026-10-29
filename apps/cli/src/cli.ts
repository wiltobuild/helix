import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createHelixClient, HelixApiError, type HelixClient } from '@helix/api-client';
import {
  boardColumn,
  deriveStatus,
  projectUpTo,
  sessionIdSchema,
  planIdSchema,
  planNodeIdSchema,
  type HelixEvent,
  type Project,
} from '@helix/contracts';
import { parsePlanInput } from './plan-input.js';
import { parseReviewInput } from './review-input.js';

const usage = `helix [--json] <command>
  status
  project add <path>
  task <title> --agent codex|claude-code --prompt <text> [--project <id>]
  send <sessionId> <text> [--interrupt]
  plan submit <file.json>
  plan show <planId>
  review submit <file|-> --head <sha>
  explain <text> [--session <id>] [--node <id>]
Environment: HELIX_URL, HELIX_DATA_DIR (default ~/.helix),
  HELIX_SESSION_ID (explain/plan submit/review submit), HELIX_PROJECT_ID (plan submit)`;
class UsageError extends Error {}

export async function resolveBaseUrl(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.HELIX_URL) {
    const url = new URL(env.HELIX_URL);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new UsageError('HELIX_URL must be HTTP(S)');
    return url.href.replace(/\/$/, '');
  }
  const file = join(env.HELIX_DATA_DIR ?? join(homedir(), '.helix'), 'run.json');
  const run: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (
    typeof run !== 'object' ||
    !run ||
    !('port' in run) ||
    typeof run.port !== 'number' ||
    !Number.isInteger(run.port) ||
    run.port < 1 ||
    run.port > 65535
  )
    throw new UsageError(`Invalid daemon port in ${file}`);
  return `http://127.0.0.1:${run.port}`;
}

async function projectHistory(client: HelixClient, project: Project): Promise<HelixEvent[]> {
  const events: HelixEvent[] = [];
  let since = 0;
  for (;;) {
    const page = await client.projectEvents(project.id, { since, limit: 1000 });
    events.push(...page.events);
    if (!page.events.length) return events;
    if (page.lastSeq <= since)
      throw new HelixApiError('INTERNAL_ERROR', 'Event cursor did not advance', 500);
    since = page.lastSeq;
  }
}

function selectProject(projects: Project[], cwd: string, id?: string): Project {
  if (id) {
    const found = projects.find((p) => p.id === id);
    if (found) return found;
    throw new UsageError(`Unknown project: ${id}`);
  }
  const matches = projects
    .filter((p) => {
      const part = relative(resolve(p.repoPath), cwd);
      return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
    })
    .sort((a, b) => b.repoPath.length - a.repoPath.length);
  if (matches[0]) return matches[0];
  if (projects.length === 1) return projects[0]!;
  throw new UsageError('Register a project first, or select one with --project <id>');
}

export type CliOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  client?: HelixClient;
  stdin?: () => Promise<string>;
};

/** Returns 0 success, 1 usage/configuration error, 2 daemon/transport failure. */
export async function runCli(args: string[], options: CliOptions = {}): Promise<0 | 1 | 2> {
  const out = options.stdout ?? console.log;
  const err = options.stderr ?? console.error;
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? env.INIT_CWD ?? process.cwd());
  let json = args.includes('--json');
  let contacting = false;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        agent: { type: 'string' },
        prompt: { type: 'string' },
        project: { type: 'string' },
        interrupt: { type: 'boolean' },
        session: { type: 'string' },
        node: { type: 'string' },
        head: { type: 'string' },
      },
    });
    json = values.json ?? false;
    if (values.help) {
      out(usage);
      return 0;
    }
    const [command, ...rest] = positionals;
    const check = (count: number, allowed: string[] = []) => {
      if (rest.length !== count || rest.some((s) => !s.trim())) throw new UsageError(usage);
      for (const key of Object.keys(values))
        if (!['json', 'help', ...allowed].includes(key))
          throw new UsageError(`Unexpected --${key} for ${command}`);
    };
    switch (command) {
      case 'status':
        check(0);
        break;
      case 'project':
        check(2);
        if (rest[0] !== 'add') throw new UsageError(usage);
        break;
      case 'task':
        check(1, ['agent', 'prompt', 'project']);
        if (!['codex', 'claude-code'].includes(values.agent ?? '') || !values.prompt?.trim())
          throw new UsageError('task requires --agent codex|claude-code and --prompt <text>');
        break;
      case 'send':
        check(2, ['interrupt']);
        sessionIdSchema.parse(rest[0]);
        break;
      case 'plan':
        check(2);
        if (!['submit', 'show'].includes(rest[0]!)) throw new UsageError(usage);
        if (rest[0] === 'show') planIdSchema.parse(rest[1]);
        break;
      case 'review':
        check(2, ['head']);
        if (rest[0] !== 'submit') throw new UsageError(usage);
        if (!values.head?.trim()) throw new UsageError('review submit requires --head <sha>');
        if (!env.HELIX_SESSION_ID) throw new UsageError('review submit requires HELIX_SESSION_ID');
        break;
      case 'explain':
        check(1, ['session', 'node']);
        if (values.session === undefined && env.HELIX_SESSION_ID !== undefined)
          values.session = env.HELIX_SESSION_ID;
        if (!values.session)
          throw new UsageError('explain requires --session <id> or HELIX_SESSION_ID');
        sessionIdSchema.parse(values.session);
        if (values.node) planNodeIdSchema.parse(values.node);
        break;
      default:
        throw new UsageError(usage);
    }
    const plan =
      command === 'plan' && rest[0] === 'submit'
        ? parsePlanInput(JSON.parse(await readFile(resolve(cwd, rest[1]!), 'utf8')), env)
        : undefined;
    const review =
      command === 'review'
        ? parseReviewInput(
            JSON.parse(
              rest[1] === '-'
                ? await (options.stdin ?? readStdin)()
                : await readFile(resolve(cwd, rest[1]!), 'utf8'),
            ),
            env,
            values.head,
          )
        : undefined;
    const client = options.client ?? createHelixClient({ baseUrl: await resolveBaseUrl(env) });
    contacting = true;
    const print = (value: unknown, human: string) => out(json ? JSON.stringify(value) : human);
    switch (command) {
      case 'status': {
        const projects = await client.projects();
        const result = await Promise.all(
          projects.map(async (project) => {
            const events = await projectHistory(client, project);
            const state = events.length ? projectUpTo(events, events.at(-1)!.seq) : undefined;
            return {
              project,
              sessions: Object.values(state?.sessions ?? {}).map((s) => ({
                id: s.session.id,
                title: s.session.title,
                agent: s.session.agent,
                status: deriveStatus(s),
                column: boardColumn(deriveStatus(s)),
              })),
            };
          }),
        );
        print(
          { projects: result },
          result.length
            ? result
                .map(
                  ({ project, sessions }) =>
                    `${project.name} (${project.id})\n${sessions.map((s) => `  ${s.id}  ${s.status}  ${s.agent}  ${s.title}`).join('\n') || '  No sessions'}`,
                )
                .join('\n')
            : 'No projects',
        );
        break;
      }
      case 'project': {
        const project = await client.createProject({ repoPath: resolve(cwd, rest[1]!) });
        print(project, `Added ${project.name} (${project.id})`);
        break;
      }
      case 'task': {
        const project = selectProject(await client.projects(), cwd, values.project);
        const session = await client.createSession(
          project.id,
          {
            title: rest[0]!,
            prompt: values.prompt!,
            agent: values.agent!,
            interface: 'chat',
          },
          { idempotencyKey: randomUUID() },
        );
        print(session, `Started ${session.id}: ${session.title}`);
        break;
      }
      case 'send': {
        const response = await client.sendMessage(sessionIdSchema.parse(rest[0]), {
          text: rest[1]!,
          mode: values.interrupt ? 'interrupt' : 'queue',
        });
        print(response, `Message accepted for ${rest[0]}`);
        break;
      }
      case 'plan': {
        if (rest[0] === 'submit') {
          const response = await client.submitPlan(plan!);
          print(response, `Submitted ${response.id} (${response.nodes.length} nodes)`);
          break;
        }
        const id = planIdSchema.parse(rest[1]);
        let found = false;
        for (const project of await client.projects()) {
          const events = await projectHistory(client, project);
          if (!events.length) continue;
          const state = projectUpTo(events, events.at(-1)!.seq);
          const shown = Object.hasOwn(state.plans, id) ? state.plans[id] : undefined;
          if (!shown) continue;
          print(
            shown,
            `${shown.goal}\n${shown.id}  ${shown.status}\n${shown.nodes
              .map(
                (node) =>
                  `  ${node.id}  ${node.agent}  ${shown.nodeStatus[node.id]}  ${node.title}\n    dependsOn: ${node.dependsOn.join(', ') || '(none)'}\n    files: ${node.files.join(', ') || '(none)'}`,
              )
              .join('\n')}`,
          );
          found = true;
          break;
        }
        if (!found) throw new HelixApiError('NOT_FOUND', `Unknown plan: ${id}`, 404);
        break;
      }
      case 'explain': {
        const response = await client.explain({
          sessionId: sessionIdSchema.parse(values.session),
          text: rest[0]!,
          ...(values.node ? { planNodeId: planNodeIdSchema.parse(values.node) } : {}),
        });
        print(response, `Recorded explanation #${response.seq}`);
        break;
      }
      case 'review': {
        const response = await client.submitReview(review!);
        print(
          response,
          `Submitted ${response.payload.review.verdict} for PR #${response.payload.prNumber} at ${response.payload.headSha}`,
        );
        break;
      }
    }
    return 0;
  } catch (error) {
    const api = error instanceof HelixApiError;
    const remote =
      api ||
      (contacting &&
        !(error instanceof UsageError) &&
        !(error instanceof Error && error.name === 'ZodError'));
    const code = api ? error.code : remote ? 'INTERNAL_ERROR' : 'INVALID_REQUEST';
    const message =
      error instanceof Error && error.name === 'ZodError'
        ? 'Invalid command arguments or plan file'
        : error instanceof Error
          ? error.message
          : 'Command failed';
    err(json ? JSON.stringify({ error: { code, message } }) : `${code}: ${message}`);
    return remote ? 2 : 1;
  }
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}
