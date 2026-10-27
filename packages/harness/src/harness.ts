import {
  HelixError,
  isHelixError,
  type AgentHarness,
  type AgentKind,
  type ApprovingHarnessSession,
  type HarnessInfo,
  type HarnessStartOptions,
  type KnownAgentKind,
} from '@helix/contracts';
import { ClaudeSession } from './claude.js';
import { CodexSession } from './codex.js';
import type { HarnessOptions } from './options.js';
import { environment, probe, resolveExecutable } from './process.js';
import { record } from './protocol.js';

class CliHarness implements AgentHarness {
  constructor(
    readonly kind: KnownAgentKind,
    private options: HarnessOptions,
  ) {}
  private executable(options = this.options): Promise<string | undefined> {
    return resolveExecutable(
      options.bin ?? (this.kind === 'claude-code' ? 'claude' : 'codex'),
      environment(options),
      options.cwd,
    );
  }
  async detect(): Promise<HarnessInfo> {
    const info: HarnessInfo = { agent: this.kind, installed: false, signedIn: 'unknown' };
    try {
      const bin = await this.executable();
      if (!bin) return info;
      info.installed = true;
      const version = await probe(bin, ['--version'], this.options);
      if (version.code === 0 && version.text) info.version = version.text.split(/\r?\n/)[0];
      try {
        const auth = await probe(
          bin,
          this.kind === 'claude-code' ? ['auth', 'status'] : ['login', 'status'],
          this.options,
        );
        if (this.kind === 'claude-code') {
          const value = record(JSON.parse(auth.text) as unknown).loggedIn;
          if (typeof value === 'boolean') info.signedIn = value;
        } else if (/not logged in/i.test(auth.text)) info.signedIn = false;
        else if (auth.code === 0 && /logged in/i.test(auth.text)) info.signedIn = true;
      } catch {
        /* Best-effort authentication probing; never inspect credential files. */
      }
    } catch {
      /* Detection must never throw, including permissions and malformed output. */
    }
    return info;
  }
  /** Connect/initialize without starting a turn; the caller owns initial prompt delivery. */
  // CONTRACT-REQUEST: document AgentHarness.start as initialization-only and
  // HarnessSession.send as one explicit turn with caller-owned pending messages.
  async start(options: HarnessStartOptions): Promise<ApprovingHarnessSession> {
    if (options.session.interface !== 'chat')
      throw new HelixError('INVALID_REQUEST', 'Harness adapters support chat sessions only');
    try {
      const sessionOptions = {
        ...this.options,
        env: Object.fromEntries(
          Object.entries(environment(this.options, options.env)).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      };
      const bin = await this.executable(sessionOptions);
      if (!bin)
        throw new HelixError('HARNESS_UNAVAILABLE', `${this.kind} executable was not found`);
      return await (this.kind === 'claude-code' ? ClaudeSession : CodexSession).start(
        bin,
        sessionOptions,
        options,
      );
    } catch (error) {
      if (isHelixError(error)) throw error;
      throw new HelixError('HARNESS_UNAVAILABLE', `Could not start ${this.kind}`, String(error));
    }
  }
}

export function createHarness(
  kind: AgentKind,
  options: HarnessOptions = {},
): Omit<AgentHarness, 'start'> & {
  start(options: HarnessStartOptions): Promise<ApprovingHarnessSession>;
} {
  if (kind !== 'claude-code' && kind !== 'codex')
    throw new HelixError('HARNESS_UNAVAILABLE', `Unsupported harness: ${kind}`);
  return new CliHarness(kind, options);
}

export function detectAll(
  options: Partial<Record<KnownAgentKind, HarnessOptions>> = {},
): Promise<HarnessInfo[]> {
  return Promise.all(
    (['claude-code', 'codex'] as const).map((kind) => createHarness(kind, options[kind]).detect()),
  );
}
