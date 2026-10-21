import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  HelixError,
  approvalIdSchema,
  type AgentActivity,
  type Approval,
  type ApprovalDecision,
  type ApprovalId,
  type ApprovingHarnessSession,
  type HarnessEmission,
  type HarnessStartOptions,
  type MessageMode,
  type Unsubscribe,
} from '@helix/contracts';
import type { HarnessOptions } from './options.js';
import { hasExited, killTree, spawnExecutable } from './process.js';
import { JsonLines, compact } from './protocol.js';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: HelixError) => void;
  timer: ReturnType<typeof setTimeout>;
};
type PendingApproval = {
  wireId: string | number;
  respond: (decision: ApprovalDecision) => Promise<void>;
};

/** Shared transport/lifecycle, with protocol-specific turns and requests in each adapter. */
export abstract class ProcessSession implements ApprovingHarnessSession {
  // `declare` preserves the contract's optional property with exactOptionalPropertyTypes.
  declare resumeToken?: string;
  protected child!: ChildProcessWithoutNullStreams;
  protected busy = false;
  protected stopped = false;
  protected approvals = new Map<ApprovalId, PendingApproval>();
  private listeners = new Set<(event: HarnessEmission) => void>();
  private startup: HarnessEmission[] = [];
  private subscribed = false;
  private launching: Promise<void> = Promise.resolve();
  private operation: Promise<void> = Promise.resolve();
  private requests = new Map<string | number, PendingRequest>();
  private stopPromise?: Promise<void>;
  private exitPromise!: Promise<void>;
  private turnWaiters = new Set<() => void>();
  private lastActivity?: AgentActivity;

  constructor(
    protected options: HarnessOptions,
    protected startOptions: HarnessStartOptions,
  ) {
    if (startOptions.resumeToken) this.resumeToken = startOptions.resumeToken;
  }
  protected abstract receive(value: unknown): void;
  protected abstract beginTurn(text: string): Promise<void>;
  protected abstract cancelTurn(): Promise<void>;

  protected async connect(bin: string, args: string[]): Promise<void> {
    this.activity('starting');
    this.child = spawnExecutable(
      bin,
      [...(this.options.extraArgs ?? []), ...args],
      this.options,
      this.startOptions.cwd,
    );
    const lines = new JsonLines(
      (value) => {
        if (this.stopped) return;
        try {
          this.receive(value);
        } catch {
          this.invalid('Invalid protocol message skipped');
        }
      },
      (reason) => this.invalid(reason),
    );
    this.child.stdout.on('data', (chunk: Buffer) => lines.push(chunk));
    this.child.stdout.on('end', () => lines.end());
    this.child.stderr.on('data', () => this.log('Harness wrote diagnostic output to stderr'));
    this.child.stdin.on('error', () => {
      if (!this.stopped) this.fail('Harness input stream failed');
    });
    this.child.on('error', () => {
      if (!this.stopped) this.fail('Harness process failed');
    });
    this.exitPromise = new Promise((resolve) => {
      let observedExit = false;
      this.child.once('exit', () => {
        observedExit = true;
      });
      this.child.once('close', () => {
        // `close` follows stdout EOF, so a final JSON line without LF is not lost.
        if (!observedExit) {
          resolve();
          return;
        }
        // Only a real exit event can produce this fact (spawn errors cannot).
        // CONTRACT-REQUEST: an optional lifecycle callback/emission carrying
        // code + signal is needed for core to append an accurate session.exited.
        this.stopped = true;
        this.approvals.clear();
        this.rejectRequests('Harness process exited');
        this.wakeTurnWaiters();
        this.activity('exited');
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', () =>
        reject(new HelixError('HARNESS_UNAVAILABLE', 'Could not start harness process')),
      );
    });
  }
  onEvent(cb: (event: HarnessEmission) => void): Unsubscribe {
    this.listeners.add(cb);
    if (!this.subscribed) {
      this.subscribed = true;
      const pending = this.startup;
      this.startup = [];
      for (const event of pending) this.deliver(cb, event);
    }
    return () => {
      this.listeners.delete(cb);
    };
  }
  protected emit(event: HarnessEmission): void {
    if (!this.subscribed) this.startup.push(event);
    for (const listener of this.listeners) this.deliver(listener, event);
  }
  private deliver(cb: (event: HarnessEmission) => void, event: HarnessEmission): void {
    try {
      cb(structuredClone(event));
    } catch {
      this.log('Harness event subscriber threw');
    }
  }
  protected log(message: string): void {
    try {
      this.options.log?.(message);
    } catch {
      /* Diagnostics are optional. */
    }
  }
  protected activity(activity: AgentActivity): void {
    if (this.lastActivity === activity) return;
    this.lastActivity = activity;
    this.emit({ type: 'activity.changed', payload: { activity } });
  }
  protected invalid(message: string): void {
    this.log(message);
    if (!this.stopped) this.activity('unknown');
  }
  protected fail(message: string): void {
    if (this.stopped) return;
    this.emit({
      type: 'chat.item',
      payload: { item: { kind: 'message', role: 'system', text: compact(message, 400) } },
    });
    this.activity('unknown');
  }
  protected ensureOpen(): void {
    if (this.stopped || !this.child || hasExited(this.child) || this.child.stdin.destroyed) {
      throw new HelixError('CONFLICT', 'Harness session is closed');
    }
  }
  protected write(message: unknown): Promise<void> {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8', (error) =>
        error
          ? reject(new HelixError('HARNESS_UNAVAILABLE', 'Could not write to harness'))
          : resolve(),
      );
    });
  }
  protected request(id: string | number, message: unknown): Promise<unknown> {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        this.invalid('Harness request timed out');
        reject(new HelixError('HARNESS_UNAVAILABLE', 'Harness request timed out'));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.requests.set(id, { resolve, reject, timer });
      void this.write(message).catch(() =>
        this.response(id, undefined, 'Harness input stream failed'),
      );
    });
  }
  protected response(id: string | number, result: unknown, error?: string): void {
    const request = this.requests.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    this.requests.delete(id);
    if (error) request.reject(new HelixError('HARNESS_UNAVAILABLE', compact(error, 400)));
    else request.resolve(result);
  }
  private rejectRequests(message: string): void {
    for (const id of this.requests.keys()) this.response(id, undefined, message);
  }
  private serialize(action: () => Promise<void>): Promise<void> {
    const operation = this.operation.then(action);
    this.operation = operation.catch(() => undefined);
    return operation;
  }
  send(text: string, mode: MessageMode): Promise<void> {
    return this.serialize(async () => {
      this.ensureOpen();
      if (!text.trim() || (mode !== 'queue' && mode !== 'interrupt'))
        throw new HelixError('INVALID_REQUEST', 'A nonempty message and valid mode are required');
      if (mode === 'interrupt') await this.interruptCurrent();
      // Core owns pending turns and calls send only after previous-turn bookkeeping.
      // Reject overlapping queue sends instead of silently starting them at an idle boundary.
      if (this.busy)
        throw new HelixError('CONFLICT', 'A turn is already running; queue messages in core');
      this.busy = true;
      this.activity('active');
      this.launching = this.beginTurn(text).catch((error: unknown) => {
        this.busy = false;
        this.wakeTurnWaiters();
        this.fail('Could not start harness turn');
        throw error;
      });
      await this.launching;
    });
  }
  protected completeTurn(): void {
    this.busy = false;
    this.approvals.clear();
    this.wakeTurnWaiters();
    if (this.stopped) return;
    this.activity('idle');
  }
  private wakeTurnWaiters(): void {
    for (const wake of this.turnWaiters) wake();
    this.turnWaiters.clear();
  }
  interrupt(): Promise<void> {
    return this.serialize(() => this.interruptCurrent());
  }
  private async interruptCurrent(): Promise<void> {
    this.ensureOpen();
    await this.launching;
    if (!this.busy) return;
    let cleanup = () => undefined as void;
    const finished = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new HelixError('HARNESS_UNAVAILABLE', 'Harness did not finish the interrupted turn'),
        );
      }, this.options.requestTimeoutMs ?? 30_000);
      const wake = () => {
        cleanup();
        resolve();
      };
      cleanup = () => {
        clearTimeout(timer);
        this.turnWaiters.delete(wake);
      };
      this.turnWaiters.add(wake);
    });
    // Attach a rejection handler immediately; cancelTurn may itself take time to resolve.
    void finished.catch(() => undefined);
    try {
      await this.cancelTurn();
      await finished;
      this.ensureOpen();
    } finally {
      cleanup();
    }
  }
  protected askApproval(
    wireId: string | number,
    input: Pick<Approval, 'kind' | 'summary' | 'detail'>,
    respond: PendingApproval['respond'],
  ): void {
    if ([...this.approvals.values()].some((value) => value.wireId === wireId)) return;
    const id = approvalIdSchema.parse(randomUUID());
    this.approvals.set(id, { wireId, respond });
    this.emit({
      type: 'approval.requested',
      payload: {
        approval: {
          id,
          sessionId: this.startOptions.session.id,
          ...input,
          summary: compact(input.summary) || 'Permission requested',
          detail: compact(input.detail, 400),
          scope: 'once',
          requestedAt: new Date().toISOString(),
        },
      },
    });
    this.activity('waiting_input');
  }
  protected clearApproval(wireId: string | number): void {
    // CONTRACT-REQUEST: HarnessEmission needs an approval cancellation event so
    // core can clear a pending approval cancelled by the backend or interrupted turn.
    for (const [id, pending] of this.approvals)
      if (pending.wireId === wireId) this.approvals.delete(id);
    if (!this.approvals.size && !this.stopped) this.activity(this.busy ? 'active' : 'idle');
  }
  async decide(approvalId: ApprovalId, decision: ApprovalDecision): Promise<void> {
    this.ensureOpen();
    if (!['approved', 'rejected', 'changes_requested'].includes(decision))
      throw new HelixError('INVALID_REQUEST', 'Invalid approval decision');
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new HelixError('NOT_FOUND', 'Approval is not pending in this session');
    this.approvals.delete(approvalId); // A concurrent decision cannot resolve it twice.
    await approval.respond(decision);
    if (!this.approvals.size && !this.stopped) this.activity(this.busy ? 'active' : 'idle');
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.approvals.clear();
    this.rejectRequests('Harness session stopped');
    this.wakeTurnWaiters();
    this.stopPromise = (async () => {
      if (!this.child) return;
      await killTree(this.child);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.exitPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new HelixError(
                    'INTERNAL_ERROR',
                    'Harness process did not exit after termination',
                  ),
                ),
              10_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.stopPromise;
  }
}
