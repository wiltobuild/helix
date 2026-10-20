import { join, resolve } from 'node:path';
import type { IPty, IPtyForkOptions } from 'node-pty';
import {
  HelixError,
  type SessionId,
  type TerminalAttachment,
  type TerminalHost,
  type TerminalOutput,
  type TerminalSpawnOptions,
  type Unsubscribe,
} from '@helix/contracts';
import { TerminalLog, tailUtf8 } from './log.js';
import { killProcessTree } from './process-tree.js';

export type PtyProcess = Pick<
  IPty,
  'pid' | 'write' | 'resize' | 'kill' | 'pause' | 'resume' | 'onData' | 'onExit'
>;
export type PtyFactory = (command: string, args: string[], options: IPtyForkOptions) => PtyProcess;
export interface NodePtyHostOptions {
  dataDir: string;
  scrollbackBytes?: number;
  logMaxBytes?: number;
  /** Test seams: default tests do not load a native addon or spawn real binaries. */
  spawnPty?: PtyFactory;
  killTree?: (pid: number) => Promise<void>;
  onError?: (error: HelixError) => void;
}
type Listener = {
  callback: (message: TerminalOutput) => void;
  replaying: boolean;
  pending: TerminalOutput[];
};
type Terminal = {
  pty: PtyProcess;
  log: TerminalLog;
  scrollback: Buffer;
  listeners: Set<Listener>;
  exit: { code: number | null } | undefined;
  completed: Promise<void>;
  complete: () => void;
  killing: Promise<void> | undefined;
  queuedBytes: number;
};
function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new HelixError('INVALID_REQUEST', 'Terminal sizes must be positive safe integers.');
}

export class NodePtyHost implements TerminalHost {
  private readonly terminals = new Map<SessionId, Terminal>();
  private readonly spawning = new Set<SessionId>();
  private readonly exits = new Set<(sessionId: SessionId, code: number | null) => void>();
  private readonly scrollbackBytes: number;
  private readonly logMaxBytes: number;
  constructor(private readonly options: NodePtyHostOptions) {
    this.scrollbackBytes = options.scrollbackBytes ?? 2 * 1024 * 1024;
    this.logMaxBytes = options.logMaxBytes ?? 20 * 1024 * 1024;
    positive(this.scrollbackBytes);
    positive(this.logMaxBytes);
  }
  private report(message: string, cause: unknown): void {
    try {
      this.options.onError?.(
        new HelixError('INTERNAL_ERROR', message, {
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    } catch {
      /* An observer cannot crash the terminal host. */
    }
  }
  private deliver(listener: Listener, message: TerminalOutput): void {
    try {
      listener.callback(message);
    } catch (error) {
      this.report('Terminal output listener failed.', error);
    }
  }
  private broadcast(terminal: Terminal, message: TerminalOutput): void {
    for (const listener of [...terminal.listeners]) {
      if (listener.replaying) listener.pending.push(message);
      else this.deliver(listener, message);
    }
  }
  async spawn(sessionId: SessionId, options: TerminalSpawnOptions): Promise<void> {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(sessionId) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sessionId)
    )
      throw new HelixError('INVALID_REQUEST', 'Session ID is not a safe filename.');
    if (this.spawning.has(sessionId) || this.terminals.has(sessionId))
      throw new HelixError('CONFLICT', 'Terminal session already exists.');
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    positive(cols);
    positive(rows);
    if (!options.command || !options.cwd)
      throw new HelixError('INVALID_REQUEST', 'Terminal command and cwd are required.');
    this.spawning.add(sessionId);
    try {
      const log = new TerminalLog(
        join(resolve(this.options.dataDir), 'terminals', `${sessionId}.log`),
        this.logMaxBytes,
      );
      await log.open();
      const spawn = this.options.spawnPty ?? (await import('node-pty')).spawn;
      const env = Object.fromEntries(
        Object.entries({ ...process.env, ...options.env }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const pty = spawn(options.command, options.args, {
        cwd: options.cwd,
        env,
        cols,
        rows,
        name: 'xterm-256color',
      });
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const terminal: Terminal = {
        pty,
        log,
        scrollback: Buffer.alloc(0),
        listeners: new Set(),
        exit: undefined,
        completed,
        complete,
        killing: undefined,
        queuedBytes: 0,
      };
      this.terminals.set(sessionId, terminal);
      const dataSubscription = pty.onData((data) => {
        if (terminal.exit) return;
        const bytes = Buffer.from(data, 'utf8');
        terminal.scrollback = tailUtf8(
          Buffer.concat([terminal.scrollback, bytes]),
          this.scrollbackBytes,
        );
        terminal.queuedBytes += bytes.length;
        if (terminal.queuedBytes >= this.scrollbackBytes) pty.pause();
        void log.append(bytes).then(() => {
          terminal.queuedBytes -= bytes.length;
          if (!terminal.exit && terminal.queuedBytes < this.scrollbackBytes) pty.resume();
        });
        this.broadcast(terminal, { t: 'out', data });
      });
      const exitSubscription = pty.onExit(({ exitCode }) => {
        if (terminal.exit) return;
        const code = Number.isInteger(exitCode) ? exitCode : null;
        terminal.exit = { code };
        dataSubscription.dispose();
        // onExit is asynchronous in node-pty; defer disposal for synchronous test drivers too.
        queueMicrotask(() => exitSubscription.dispose());
        this.broadcast(terminal, { t: 'exit', code });
        for (const callback of [...this.exits]) {
          try {
            callback(sessionId, code);
          } catch (error) {
            this.report('Terminal exit listener failed.', error);
          }
        }
        void log
          .flush()
          .catch((error: unknown) => this.report('Terminal log write failed.', error))
          .finally(complete);
      });
    } catch (error) {
      if (error instanceof HelixError) throw error;
      throw new HelixError('INTERNAL_ERROR', 'Unable to spawn terminal.', {
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.spawning.delete(sessionId);
    }
  }
  attach(
    sessionId: SessionId,
    onOutput: (message: TerminalOutput) => void,
  ): Promise<TerminalAttachment> {
    const terminal = this.terminals.get(sessionId);
    if (!terminal) return Promise.reject(new HelixError('NOT_FOUND', 'Unknown terminal session.'));
    const listener: Listener = { callback: onOutput, replaying: true, pending: [] };
    const exit = terminal.exit;
    terminal.listeners.add(listener);
    if (terminal.scrollback.length)
      this.deliver(listener, { t: 'out', data: terminal.scrollback.toString('utf8') });
    if (exit) this.deliver(listener, { t: 'exit', code: exit.code });
    while (listener.pending.length) this.deliver(listener, listener.pending.shift()!);
    listener.replaying = false;
    let detached = false;
    const active = () => {
      if (detached || terminal.exit || terminal.killing)
        throw new HelixError('CONFLICT', 'Terminal attachment is no longer writable.');
    };
    return Promise.resolve({
      write(data) {
        active();
        try {
          terminal.pty.write(data);
        } catch {
          throw new HelixError('INTERNAL_ERROR', 'Terminal write failed.');
        }
      },
      resize(cols, rows) {
        active();
        positive(cols);
        positive(rows);
        try {
          terminal.pty.resize(cols, rows);
        } catch {
          throw new HelixError('INTERNAL_ERROR', 'Terminal resize failed.');
        }
      },
      detach() {
        detached = true;
        terminal.listeners.delete(listener);
      },
    });
  }
  async kill(sessionId: SessionId): Promise<void> {
    const terminal = this.terminals.get(sessionId);
    if (!terminal) throw new HelixError('NOT_FOUND', 'Unknown terminal session.');
    if (terminal.exit) {
      await terminal.completed;
      return;
    }
    terminal.killing ??= (async () => {
      await (this.options.killTree ?? killProcessTree)(terminal.pty.pid);
      // Release the ConPTY/native handle after the complete process tree is terminated.
      if (!terminal.exit) terminal.pty.kill();
      await terminal.completed;
    })().catch((error: unknown) => {
      terminal.killing = undefined;
      throw error instanceof HelixError
        ? error
        : new HelixError('INTERNAL_ERROR', 'Terminal kill failed.');
    });
    await terminal.killing;
  }
  onExit(callback: (sessionId: SessionId, code: number | null) => void): Unsubscribe {
    this.exits.add(callback);
    return () => {
      this.exits.delete(callback);
    };
  }
  list(): SessionId[] {
    return [...this.terminals].filter(([, terminal]) => !terminal.exit).map(([id]) => id);
  }
  /** Drains pending log writes; also reports disk failures to callers. */
  async flush(): Promise<void> {
    try {
      await Promise.all([...this.terminals.values()].map((terminal) => terminal.log.flush()));
    } catch {
      throw new HelixError('INTERNAL_ERROR', 'Terminal log write failed.');
    }
  }
  async close(): Promise<void> {
    await Promise.all(this.list().map((id) => this.kill(id)));
    await this.flush();
  }
}
