import { StringDecoder } from 'node:string_decoder';
import type { ChatItem, HarnessEmission } from '@helix/contracts';

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}
export function compact(value: string, limit = 200): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
export function reasoning(value: string): string {
  const text = compact(value, 400);
  if (value.length <= 400) return text;
  const end = Math.max(text.lastIndexOf('. '), text.lastIndexOf('! '), text.lastIndexOf('? '));
  return end > 0 ? text.slice(0, end + 1) : text;
}
/** Summarize metadata; never stringify file contents, patches, or arbitrary tool arguments. */
export function inputSummary(value: unknown): string {
  const input = record(value);
  const parts = ['command', 'file_path', 'path', 'pattern', 'query', 'url'].flatMap((key) => {
    const text = string(input[key]);
    return text ? [`${key}: ${text}`] : [];
  });
  return compact(
    parts.join('; ') || `Arguments: ${Object.keys(input).slice(0, 10).join(', ') || 'none'}`,
  );
}
export function outputSummary(value: unknown): string {
  if (typeof value === 'string') return `Output received (${value.length} characters)`;
  if (Array.isArray(value)) return `Output received (${value.length} blocks)`;
  return 'Output received';
}
export function chat(item: ChatItem): HarnessEmission {
  return { type: 'chat.item', payload: { item } };
}

/** Bounded UTF-8 JSONL decoder. Discards oversized lines through their next newline. */
export class JsonLines {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private discarding = false;
  constructor(
    private onMessage: (value: unknown) => void,
    private onInvalid: (reason: string) => void,
    private maxLength = 4 * 1024 * 1024,
  ) {}
  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const parts = text.split('\n');
    for (let index = 0; index < parts.length; index++) {
      if (!this.discarding) this.pending += parts[index] ?? '';
      if (this.pending.length > this.maxLength) {
        this.pending = '';
        this.discarding = true;
        this.onInvalid('Oversized JSON line skipped');
      }
      if (index < parts.length - 1) {
        if (!this.discarding) this.line(this.pending);
        this.pending = '';
        this.discarding = false;
      }
    }
  }
  end(): void {
    this.push(this.decoder.end());
    if (!this.discarding && this.pending.trim()) this.line(this.pending);
    this.pending = '';
  }
  private line(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line.replace(/^\uFEFF/, ''));
    } catch {
      this.onInvalid('Non-JSON output skipped');
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.onInvalid('Non-object JSON output skipped');
      return;
    }
    this.onMessage(value);
  }
}
