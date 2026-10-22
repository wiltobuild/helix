import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One active log and one rotated generation, each bounded by maxBytes. */
export class TerminalLog {
  private size = 0;
  private queue = Promise.resolve();
  private error: Error | undefined;
  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
  ) {}
  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, '');
    this.size = (await stat(this.path)).size;
  }
  append(data: Buffer): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        if (this.error) return;
        for (let offset = 0; offset < data.length;) {
          if (this.size >= this.maxBytes) {
            await rm(`${this.path}.1`, { force: true });
            await rename(this.path, `${this.path}.1`);
            this.size = 0;
          }
          const part = data.subarray(offset, offset + this.maxBytes - this.size);
          await appendFile(this.path, part);
          this.size += part.length;
          offset += part.length;
        }
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error : new Error(String(error));
      });
    return this.queue;
  }
  async flush(): Promise<void> {
    await this.queue;
    if (this.error) throw this.error;
  }
}

export function tailUtf8(data: Buffer, maxBytes: number): Buffer {
  if (data.length <= maxBytes) return data;
  let start = data.length - maxBytes;
  while (start < data.length && (data[start]! & 0xc0) === 0x80) start++;
  return Buffer.from(data.subarray(start));
}
