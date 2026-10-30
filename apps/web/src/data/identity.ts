import type { AgentKind, HelixEvent, ProjectState, SessionState } from '@helix/contracts';

/**
 * Actor identity: the *who* behind a task, kept separate from the task content and from the
 * provider/model running it. Names are derived from the approved task text (never from the
 * harness), so they stay stable while an agent works, while its provider/model is reassigned,
 * and across replay. Internal IDs are carried alongside for tracing; they are never renamed.
 */
export type ActorRole = 'orchestrator' | 'author' | 'reviewer';

export interface ActorIdentity {
  /** Stable, task-derived display name — the primary actor label (e.g. "Catalog Architect"). */
  name: string;
  role: ActorRole;
  /** Provider/model are secondary context; the identity never depends on them. */
  agent: AgentKind;
  model?: string;
  /** Internal IDs, preserved verbatim for tracing. */
  sessionId: string;
  planNodeId?: string;
  /** The task content this actor owns, kept distinct from its identity. */
  taskTitle: string;
  /** False when the name is a deterministic fallback rather than derived from task text. */
  fromTask: boolean;
}

// Low-signal connective words that never carry the task's topic.
const STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'to',
  'for',
  'of',
  'in',
  'on',
  'at',
  'by',
  'from',
  'with',
  'into',
  'onto',
  'as',
  'is',
  'are',
  'be',
  'our',
  'your',
  'their',
  'its',
  'this',
  'that',
  'these',
  'those',
  'it',
  'we',
  'you',
  'all',
  'any',
  'via',
  'per',
  'using',
  'use',
  'new',
  'across',
  'over',
  'under',
  'up',
  'so',
  'than',
  'then',
  'when',
  'where',
  'while',
  'each',
  'both',
  // Common leading verbs that carry intent, not topic.
  'update',
  'updates',
  'make',
  'improve',
  'ensure',
  'handle',
  'setup',
  'enable',
  'allow',
  'manage',
  'wire',
  'cover',
  'run',
]);

// Nouns too generic to identify a task's domain.
const GENERIC = new Set([
  'task',
  'tasks',
  'feature',
  'features',
  'work',
  'thing',
  'things',
  'code',
  'system',
  'systems',
  'app',
  'apps',
  'application',
  'project',
  'projects',
  'change',
  'changes',
  'support',
  'flow',
  'journey',
  'stuff',
  'part',
  'parts',
]);

// Ordered craft rules: the first rule with a matching token decides the craft noun.
const CRAFT_RULES: readonly { craft: string; words: readonly string[] }[] = [
  {
    craft: 'Designer',
    words: [
      'design',
      'designs',
      'ui',
      'ux',
      'visual',
      'style',
      'styling',
      'layout',
      'interface',
      'form',
      'forms',
      'page',
      'pages',
      'screen',
      'screens',
      'theme',
      'css',
      'accessible',
      'accessibility',
    ],
  },
  {
    craft: 'Architect',
    words: [
      'api',
      'apis',
      'endpoint',
      'endpoints',
      'schema',
      'model',
      'models',
      'database',
      'migration',
      'migrations',
      'architecture',
      'foundation',
      'structure',
      'pipeline',
      'infrastructure',
      'backend',
      'service',
      'services',
    ],
  },
  {
    craft: 'Tester',
    words: [
      'test',
      'tests',
      'testing',
      'e2e',
      'coverage',
      'spec',
      'specs',
      'qa',
      'playwright',
      'cypress',
      'verify',
      'verification',
    ],
  },
  {
    craft: 'Scribe',
    words: [
      'docs',
      'doc',
      'documentation',
      'readme',
      'guide',
      'guides',
      'changelog',
      'write',
      'author',
      'draft',
    ],
  },
  {
    craft: 'Engineer',
    words: [
      'integrate',
      'integration',
      'connect',
      'sync',
      'webhook',
      'webhooks',
      'oauth',
      'auth',
      'build',
      'implement',
      'create',
      'develop',
      'add',
      'fix',
      'refactor',
      'optimize',
      'token',
      'tokens',
    ],
  },
];

const CRAFT_WORDS = new Set(CRAFT_RULES.flatMap((r) => r.words));

const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);

const titleCase = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

function craftOf(tokens: readonly string[]): { craft: string; matched: boolean } {
  const present = new Set(tokens);
  for (const rule of CRAFT_RULES) {
    if (rule.words.some((w) => present.has(w))) return { craft: rule.craft, matched: true };
  }
  return { craft: 'Engineer', matched: false };
}

/** The leading one or two topic words, Title-Cased — the task's domain. */
function domainOf(tokens: readonly string[]): string {
  return tokens
    .filter((t) => !STOP.has(t) && !GENERIC.has(t) && !CRAFT_WORDS.has(t))
    .slice(0, 2)
    .map(titleCase)
    .join(' ');
}

/**
 * Derive a "<Domain> <Craft>" actor name from task text. Deterministic: the same text always
 * yields the same name. Falls back to a generic, non-task name only when the text has no usable
 * words at all.
 */
export function deriveRoleName(text: string): { name: string; fromTask: boolean } {
  const tokens = tokenize(text);
  const { craft, matched } = craftOf(tokens);
  const domain = domainOf(tokens);
  if (domain) return { name: `${domain} ${craft}`, fromTask: true };
  if (craft === 'Engineer' && tokens.some((t) => t === 'integration' || t === 'integrate'))
    return { name: 'Integration Engineer', fromTask: true };
  if (matched) return { name: craft, fromTask: true };
  return { name: 'Agent', fromTask: false };
}

/** A reviewer's name reuses the author's domain with the "Reviewer" craft, so the two never read alike. */
export function reviewerName(workerText: string): { name: string; fromTask: boolean } {
  const domain = domainOf(tokenize(workerText));
  return domain
    ? { name: `${domain} Reviewer`, fromTask: true }
    : { name: 'Reviewer', fromTask: false };
}

/** The approved task text for a session: its plan node title when planned, else the session title. */
export function approvedText(session: SessionState, state: ProjectState): string {
  const nodeId = session.session.planNodeId;
  if (nodeId) {
    for (const plan of Object.values(state.plans)) {
      const node = plan.nodes.find((n) => n.id === nodeId);
      if (node) return node.title;
    }
  }
  return session.session.title || session.session.prompt;
}

function reviewedWorker(reviewer: SessionState, state: ProjectState): SessionState | undefined {
  const parent = reviewer.session.parentSessionId;
  if (parent && state.sessions[parent]?.session.role === 'worker') return state.sessions[parent];
  const reviewerId = reviewer.session.id;
  const byReview = Object.values(state.sessions).find(
    (w) => w.session.role === 'worker' && w.agentReview?.reviewerSessionId === reviewerId,
  );
  if (byReview) return byReview;
  return parent ? state.sessions[parent] : undefined;
}

function baseName(
  session: SessionState,
  state: ProjectState,
): { name: string; role: ActorRole; fromTask: boolean } {
  if (session.session.role === 'orchestrator')
    return { name: 'Helix', role: 'orchestrator', fromTask: true };
  if (session.session.role === 'reviewer') {
    const worker = reviewedWorker(session, state);
    const text = worker ? approvedText(worker, state) : session.session.title;
    const { name, fromTask } = reviewerName(text);
    return { name, role: 'reviewer', fromTask };
  }
  const { name, fromTask } = deriveRoleName(approvedText(session, state));
  return { name, role: 'author', fromTask };
}

type TaskName = ReturnType<typeof deriveRoleName>;
const identityIndex = Symbol('frontend identity index');
type IndexedState = ProjectState & { [identityIndex]?: ReadonlyMap<string, TaskName> };

/** Allocate names once in append-only event order. Reservations survive attachment and
 * replacement, even when a standalone session later takes over an existing plan task.
 * This is frontend metadata only; neither events nor contracts are changed.
 */
export function indexIdentities(events: readonly HelixEvent[]): ReadonlyMap<string, TaskName> {
  const names = new Map<string, TaskName>();
  const counts = new Map<string, number>();
  const nodeTitles = new Map<string, string>();
  const sessionTitles = new Map<string, string>();
  const active = new Map<string, TaskName>();
  const reserve = (key: string, base: TaskName) => {
    if (names.has(key)) return;
    const seen = counts.get(base.name) ?? 0;
    counts.set(base.name, seen + 1);
    names.set(key, { ...base, name: seen ? `${base.name} ${seen + 1}` : base.name });
  };
  for (const event of events) {
    if (event.type === 'plan.submitted') {
      for (const node of event.payload.plan.nodes) {
        nodeTitles.set(node.id, node.title);
        reserve(`node:${node.id}`, deriveRoleName(node.title));
      }
    } else if (event.type === 'session.created') {
      const session = event.payload.session;
      const key = `session:${session.id}`;
      const text =
        (session.planNodeId && nodeTitles.get(session.planNodeId)) ||
        session.title ||
        session.prompt;
      sessionTitles.set(session.id, text);
      const planned = session.planNodeId ? names.get(`node:${session.planNodeId}`) : undefined;
      if (session.role === 'orchestrator') names.set(key, { name: 'Helix', fromTask: true });
      else if (session.role === 'worker' && planned) names.set(key, planned);
      else
        reserve(
          key,
          session.role === 'reviewer'
            ? reviewerName(
                (session.parentSessionId && sessionTitles.get(session.parentSessionId)) ||
                  session.title,
              )
            : deriveRoleName(text),
        );
      active.set(session.id, names.get(key)!);
    } else if (event.type === 'plan.node_updated' && event.payload.sessionId) {
      const title = nodeTitles.get(event.payload.nodeId);
      if (title) sessionTitles.set(event.payload.sessionId, title);
      const name = names.get(`node:${event.payload.nodeId}`);
      if (name) active.set(event.payload.sessionId, name);
    }
    const actorId = event.type === 'session.created' ? event.payload.session.id : event.sessionId;
    const actor = actorId ? active.get(actorId) : undefined;
    if (actor) names.set(`event:${event.seq}`, actor);
    if (event.type === 'feedback.routed') {
      const target = active.get(event.payload.toSessionId);
      if (target) names.set(`target:${event.seq}`, target);
    }
  }
  return names;
}

export function withIdentityIndex(
  state: ProjectState,
  index: ReadonlyMap<string, TaskName>,
): ProjectState {
  return { ...state, [identityIndex]: index } as IndexedState;
}

/** Historical labels use the assignment at the event, not a session's current assignment. */
export function historicalActorName(
  state: ProjectState,
  event: HelixEvent,
  target = false,
): string | undefined {
  return (state as IndexedState)[identityIndex]?.get(`${target ? 'target' : 'event'}:${event.seq}`)
    ?.name;
}

/** Reserve every plan task before workers attach. Replacements share their task's identity.
 * Log order, never timestamps or lexical IDs, decides collisions. Bare projections retain
 * insertion order within plans and sessions; useRun supplies the immutable log reservations.
 */
export function resolveProjectIdentities(state: ProjectState) {
  const sessions = Object.values(state.sessions);
  const counts = new Map<string, number>();
  const nodes = new Map<string, ReturnType<typeof deriveRoleName>>();
  const bases = new Map<string, ReturnType<typeof baseName>>();
  const candidates: {
    key: string;
    base: ReturnType<typeof deriveRoleName>;
    assign: (name: string) => void;
  }[] = [];
  for (const plan of Object.values(state.plans)) {
    for (const node of plan.nodes) {
      const base = deriveRoleName(node.title);
      candidates.push({
        key: `node:${node.id}`,
        base,
        assign: (name) => nodes.set(node.id, { ...base, name }),
      });
    }
  }
  const planned = new Set(candidates.map((c) => c.key));
  for (const session of sessions) {
    const base = baseName(session, state);
    if (base.role === 'orchestrator') {
      bases.set(session.session.id, base);
    } else if (base.role !== 'author' || !planned.has(`node:${session.session.planNodeId}`)) {
      candidates.push({
        key: `session:${session.session.id}`,
        base,
        assign: (name) => bases.set(session.session.id, { ...base, name }),
      });
    }
  }
  const index = (state as IndexedState)[identityIndex];
  for (const candidate of candidates) {
    const seen = counts.get(candidate.base.name) ?? 0;
    counts.set(candidate.base.name, seen + 1);
    candidate.assign(
      index?.get(candidate.key)?.name ??
        (seen === 0 ? candidate.base.name : `${candidate.base.name} ${seen + 1}`),
    );
  }
  const out = new Map<string, ActorIdentity>();
  for (const session of sessions) {
    const node =
      session.session.role === 'worker' && session.session.planNodeId
        ? nodes.get(session.session.planNodeId)
        : undefined;
    const base = node ? { ...node, role: 'author' as const } : bases.get(session.session.id)!;
    out.set(session.session.id, {
      name: base.name,
      role: base.role,
      agent: session.session.agent,
      ...(session.session.model ? { model: session.session.model } : {}),
      sessionId: session.session.id,
      ...(session.session.planNodeId ? { planNodeId: session.session.planNodeId } : {}),
      taskTitle: session.session.title,
      fromTask: base.fromTask,
    });
  }
  return { sessions: out, nodes };
}

export function resolveIdentities(state: ProjectState): Map<string, ActorIdentity> {
  return resolveProjectIdentities(state).sessions;
}

/** The identity of a single session, or undefined when it is not in the project. */
export function identityFor(state: ProjectState, sessionId: string): ActorIdentity | undefined {
  return resolveIdentities(state).get(sessionId);
}

/** A short, human-readable trace of the internal IDs behind an identity. */
export function traceLabel(identity: ActorIdentity): string {
  return identity.planNodeId
    ? `${identity.sessionId} · ${identity.planNodeId}`
    : identity.sessionId;
}
