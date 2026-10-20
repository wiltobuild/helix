import { z } from 'zod';
import { projectSchema, timestampSchema } from './entities.js';
import { helixEventSchema } from './events.js';

export const helixlogHeaderSchema = z.strictObject({ format: z.literal('helixlog'), version: z.literal(1), project: projectSchema, recordedAt: timestampSchema, redactions: z.array(z.string()) });
export type HelixlogHeader = z.infer<typeof helixlogHeaderSchema>;
export const helixlogSchema = z.strictObject({ header: helixlogHeaderSchema, events: z.array(helixEventSchema) }).superRefine((log, ctx) => {
  let previous = 0;
  for (const [index, event] of log.events.entries()) {
    if (event.projectId !== log.header.project.id || event.seq <= previous) ctx.addIssue({ code: 'custom', path: ['events', index], message: 'Events must match the project and have strictly increasing sequences' });
    previous = event.seq;
  }
  const first = log.events[0];
  if (!first || first.type !== 'project.added' || JSON.stringify(first.payload.project) !== JSON.stringify(log.header.project)) ctx.addIssue({ code: 'custom', path: ['events', 0], message: 'Recording must begin with project.added matching the header project' });
});
export type Helixlog = z.infer<typeof helixlogSchema>;
export type HelixlogParseResult = { success: true; data: Helixlog } | { success: false; error: { line: number; message: string } };

/** Nonthrowing parser. Blank interior lines are invalid; one final newline and CRLF are allowed. */
export function parseHelixlog(text: string): HelixlogParseResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const values: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    try { values.push(JSON.parse(line)); }
    catch { return { success: false, error: { line: index + 1, message: 'Invalid JSON line' } }; }
    const result = (index === 0 ? helixlogHeaderSchema : helixEventSchema).safeParse(values[index]);
    if (!result.success) return { success: false, error: { line: index + 1, message: result.error.message } };
  }
  const result = helixlogSchema.safeParse({ header: values[0], events: values.slice(1) });
  if (result.success) return { success: true, data: result.data };
  const path = result.error.issues[0]?.path;
  const line = path?.[0] === 'events' && typeof path[1] === 'number' ? path[1] + 2 : 1;
  return { success: false, error: { line, message: result.error.message } };
}
/** Validates before writing; throws ZodError for invalid in-memory input. No implicit redaction. */
export function serializeHelixlog(log: Helixlog): string {
  const valid = helixlogSchema.parse(log);
  return [valid.header, ...valid.events].map((line) => JSON.stringify(line)).join('\n') + '\n';
}
