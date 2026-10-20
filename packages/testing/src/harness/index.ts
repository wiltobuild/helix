import {
  fixtures,
  HelixError,
  type AgentHarness,
  type AgentKind,
  type ApprovalDecision,
  type ApprovalId,
  type ApprovingHarnessSession,
  type HarnessEmission,
  type HarnessStartOptions,
  type MessageMode,
  type Unsubscribe,
} from '@helix/contracts';

export interface FakeHarnessStep {
  /** Delay relative to the previous emission, in milliseconds. */
  delayMs?: number;
  emission: HarnessEmission;
}
export interface FakeHarnessScript {
  kind?: AgentKind;
  /** The first turn runs on start; each subsequent send consumes one turn. */
  turns: readonly (readonly FakeHarnessStep[])[];
}
export type FakeHarness = Omit<AgentHarness, 'start'> & {
  start(options: HarnessStartOptions): Promise<ApprovingHarnessSession>;
};

class FakeSession implements ApprovingHarnessSession {
  readonly resumeToken: string;
  private listeners = new Set<(event: HarnessEmission) => void>();
  private backlog: HarnessEmission[] = [];
  private subscribed = false;
  private stopped = false;
  private busy = false;
  private generation = 0;
  private nextTurn = 0;
  private queued = 0;
  private pending = new Set<ApprovalId>();
  private cancelWait?: () => void;
  private continueApproval?: () => void;

  constructor(
    private script: FakeHarnessScript,
    private options: HarnessStartOptions,
  ) {
    this.resumeToken = options.resumeToken ?? `fake:${options.session.id}`;
    this.emit({ type: 'activity.changed', payload: { activity: 'starting' } });
    this.run();
  }
  onEvent(cb: (event: HarnessEmission) => void): Unsubscribe {
    this.listeners.add(cb);
    if (!this.subscribed) {
      this.subscribed = true;
      const backlog = this.backlog;
      this.backlog = [];
      for (const event of backlog) this.deliver(cb, event);
    }
    return () => {
      this.listeners.delete(cb);
    };
  }
  private deliver(cb: (event: HarnessEmission) => void, event: HarnessEmission): void {
    try {
      cb(structuredClone(event));
    } catch {
      /* Match real harness subscriber isolation. */
    }
  }
  private emit(event: HarnessEmission): void {
    if (!this.subscribed) this.backlog.push(event);
    for (const cb of this.listeners) this.deliver(cb, event);
  }
  private run(): void {
    if (this.busy || this.stopped) return;
    this.busy = true;
    const generation = ++this.generation;
    const turn = this.script.turns[this.nextTurn++] ?? [];
    this.emit({ type: 'activity.changed', payload: { activity: 'active' } });
    void (async () => {
      for (const step of turn) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, step.delayMs ?? 0);
          this.cancelWait = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        if (this.stopped || generation !== this.generation) return;
        delete this.cancelWait;
        const event = structuredClone(step.emission);
        if (event.type === 'approval.requested') {
          event.payload.approval.sessionId = this.options.session.id;
          this.pending.add(event.payload.approval.id);
          const approval = new Promise<void>((resolve) => {
            this.continueApproval = resolve;
          });
          this.emit({ type: 'activity.changed', payload: { activity: 'waiting_input' } });
          this.emit(event);
          await approval;
          if (this.stopped || generation !== this.generation) return;
          delete this.continueApproval;
        } else {
          this.emit(event);
          if (event.type === 'activity.changed' && event.payload.activity === 'exited') {
            this.stopped = true;
            return;
          }
        }
      }
      if (this.stopped || generation !== this.generation) return;
      this.busy = false;
      this.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
      if (this.queued > 0) {
        this.queued--;
        this.run();
      }
    })();
  }
  send(text: string, mode: MessageMode): Promise<void> {
    if (this.stopped)
      return Promise.reject(new HelixError('CONFLICT', 'Fake harness session is closed'));
    if (!text.trim() || !['queue', 'interrupt'].includes(mode))
      return Promise.reject(
        new HelixError('INVALID_REQUEST', 'A nonempty message and valid mode are required'),
      );
    if (mode === 'interrupt') this.cancel();
    if (this.busy) this.queued++;
    else this.run();
    return Promise.resolve();
  }
  private cancel(): void {
    this.generation++;
    this.cancelWait?.();
    this.continueApproval?.();
    this.pending.clear();
    this.busy = false;
    this.emit({ type: 'activity.changed', payload: { activity: 'idle' } });
  }
  interrupt(): Promise<void> {
    if (this.stopped)
      return Promise.reject(new HelixError('CONFLICT', 'Fake harness session is closed'));
    this.cancel();
    if (this.queued > 0) {
      this.queued--;
      this.run();
    }
    return Promise.resolve();
  }
  decide(id: ApprovalId, decision: ApprovalDecision): Promise<void> {
    if (this.stopped)
      return Promise.reject(new HelixError('CONFLICT', 'Fake harness session is closed'));
    if (!['approved', 'rejected', 'changes_requested'].includes(decision))
      return Promise.reject(new HelixError('INVALID_REQUEST', 'Invalid approval decision'));
    if (!this.pending.delete(id))
      return Promise.reject(new HelixError('NOT_FOUND', 'Approval is not pending in this session'));
    this.emit({ type: 'activity.changed', payload: { activity: 'active' } });
    this.continueApproval?.();
    return Promise.resolve();
  }
  stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.generation++;
      this.cancelWait?.();
      this.continueApproval?.();
      this.pending.clear();
      this.queued = 0;
      this.emit({ type: 'activity.changed', payload: { activity: 'exited' } });
    }
    return Promise.resolve();
  }
}

export function createFakeHarness(
  script: readonly FakeHarnessStep[] | FakeHarnessScript,
): FakeHarness {
  const source: FakeHarnessScript = 'turns' in script ? script : { turns: [script] };
  const configuration = structuredClone(source);
  return {
    kind: configuration.kind ?? 'claude-code',
    detect: () =>
      Promise.resolve({
        agent: configuration.kind ?? 'claude-code',
        installed: true,
        version: 'fake-1',
        signedIn: true,
      }),
    start: (options) => Promise.resolve(new FakeSession(configuration, options)),
  };
}

/** The API worker's harness-visible emissions in fixture order; excludes SCM/core facts. */
export const passwordResetApiScript: readonly FakeHarnessStep[] = fixtures.passwordResetRun.flatMap(
  (event) => {
    if (event.sessionId !== fixtures.passwordResetIds.api) return [];
    switch (event.type) {
      case 'chat.item':
      case 'activity.changed':
      case 'reasoning.summary':
      case 'approval.requested':
        return [
          {
            delayMs: 10,
            emission: { type: event.type, payload: event.payload } as HarnessEmission,
          },
        ];
      default:
        return [];
    }
  },
);
