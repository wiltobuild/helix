import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { eventSchemas, type HarnessEmission } from '@helix/contracts';
import { ClaudeMessages } from './claude.js';
import { codexItem } from './codex.js';
import { JsonLines, inputSummary, reasoning, record } from './protocol.js';

function fixture(name: string): unknown[] {
  return readFileSync(new URL(`./__fixtures__/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}
function validate(events: HarnessEmission[]): void {
  for (const event of events)
    expect(eventSchemas[event.type].shape.payload.safeParse(event.payload).success).toBe(true);
}
describe('documented protocol fixtures', () => {
  it('maps Claude text, tool lifecycle and thinking into bounded contract emissions', () => {
    const parser = new ClaudeMessages();
    const events = fixture('claude').flatMap((value) => parser.parse(value));
    validate(events);
    expect(events.map((event) => event.type)).toEqual([
      'chat.item',
      'reasoning.summary',
      'chat.item',
      'chat.item',
    ]);
    expect(events[3]).toMatchObject({
      payload: { item: { kind: 'tool_call', tool: 'Read', status: 'succeeded' } },
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE FILE CONTENT');
  });
  it('maps canonical Codex items without duplicating streamed text or exposing raw reasoning/patches', () => {
    const events = fixture('codex').flatMap((value) => {
      const message = record(value);
      return ['item/completed', 'item/started'].includes(String(message.method))
        ? codexItem(record(message.params).item, message.method === 'item/completed')
        : [];
    });
    validate(events);
    expect(events).toHaveLength(6);
    expect(events.at(-1)).toMatchObject({
      payload: { item: { status: 'failed', inputSummary: 'src/api.ts' } },
    });
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|RAW REASONING/);
  });
  it('handles unmatched tool results and failed command results', () => {
    const parser = new ClaudeMessages();
    const events = parser.parse({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'missing', is_error: true, content: [] }],
      },
    });
    expect(events[0]).toMatchObject({ payload: { item: { status: 'failed' } } });
    expect(
      codexItem({ type: 'commandExecution', command: 'false', exitCode: 1 }, true)[0],
    ).toMatchObject({ payload: { item: { status: 'failed' } } });
  });
  it('bounds summaries and trims long reasoning at a sentence', () => {
    expect(inputSummary({ command: 'x'.repeat(500), content: 'secret' })).toHaveLength(200);
    expect(reasoning(`First sentence. ${'x'.repeat(500)}`)).toBe('First sentence.');
    expect(reasoning('x'.repeat(1000))).toHaveLength(400);
  });
  it('decodes split UTF-8, CRLF, BOM, noise, unknown objects, and a final unterminated line', () => {
    const messages: unknown[] = [];
    const errors: string[] = [];
    const decoder = new JsonLines(
      (value) => messages.push(value),
      (error) => errors.push(error),
    );
    const bytes = Buffer.from(
      '\uFEFF{"text":"hé🙂"}\r\nnoise\r\nnull\n[]\n{"future":true}\n{"last":1}',
    );
    for (const byte of bytes) decoder.push(Buffer.from([byte]));
    decoder.end();
    expect(messages).toEqual([{ text: 'hé🙂' }, { future: true }, { last: 1 }]);
    expect(errors).toHaveLength(3);
  });
  it('recovers after oversized lines and malformed JSON', () => {
    const messages: unknown[] = [];
    const errors: string[] = [];
    const decoder = new JsonLines(
      (value) => messages.push(value),
      (error) => errors.push(error),
      20,
    );
    decoder.push('x'.repeat(100));
    decoder.push('tail\r\n{"broken":\n{"ok":true}\n');
    expect(messages).toEqual([{ ok: true }]);
    expect(errors).toHaveLength(2);
  });
});
