import { parseHelixlog, type HelixEvent, type HelixlogHeader } from '@helix/contracts';

/** A recorded run ready to replay in the browser. Recordings are replay-only. */
export interface Recording {
  name: string;
  header: HelixlogHeader;
  events: readonly HelixEvent[];
}

/** The validator's message can be a JSON list of issues; show the first two as `path: message`. */
function readable(message: string): string {
  try {
    const issues = JSON.parse(message) as { path?: (string | number)[]; message?: string }[];
    if (Array.isArray(issues) && issues.length) {
      const shown = issues
        .slice(0, 2)
        .map((i) => `${i.path?.length ? `${i.path.join('.')}: ` : ''}${i.message ?? 'invalid'}`);
      return shown.join('; ') + (issues.length > 2 ? ` (+${issues.length - 2} more)` : '');
    }
  } catch {
    /* Not JSON: already a plain message. */
  }
  return message;
}

/** Bundled recording `?demo` plays when no name is given: the orchestrator plans, Codex and Claude Code build. */
export const DEFAULT_RECORDING = 'discount-codes';

/** Bundled recording of a real CI failure routed back to the agent and fixed. */
export const CI_REPAIR_RECORDING = 'github-ci-repair';

/** Parses .helixlog text with the contracts validator; throws a readable error. */
export function readRecording(name: string, text: string): Recording {
  const parsed = parseHelixlog(text);
  if (!parsed.success)
    throw new Error(
      `${name} is not a valid recording (line ${parsed.error.line}): ${readable(parsed.error.message)}`,
    );
  return { name, header: parsed.data.header, events: parsed.data.events };
}

/** Loads a recording bundled with the site under `recordings/<name>.helixlog`. */
export async function fetchRecording(name: string): Promise<Recording> {
  // Names come from the URL; only allow simple file names under recordings/.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.includes('..'))
    throw new Error(`“${name}” is not a recording name.`);
  const response = await fetch(`${import.meta.env.BASE_URL}recordings/${name}.helixlog`);
  const type = response.headers.get('content-type') ?? '';
  // Static hosts often answer a missing file with the app's index.html.
  if (!response.ok || type.includes('text/html'))
    throw new Error(`Recording “${name}” was not found.`);
  return readRecording(name, await response.text());
}

/** Reads a .helixlog file the viewer picked, entirely in the browser. */
export async function openRecordingFile(file: File): Promise<Recording> {
  return readRecording(file.name.replace(/\.helixlog$/i, ''), await file.text());
}

/** Where replay starts: just before the first plan or task, so the run unfolds on screen. */
export function replayStart(events: readonly HelixEvent[]): number {
  const first = events.findIndex(
    (e) => e.type === 'plan.submitted' || e.type === 'session.created',
  );
  return first === -1 ? Math.min(1, events.length) : first + 1;
}
