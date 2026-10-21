import { HelixError, type HarnessEmission, type HarnessStartOptions } from '@helix/contracts';
import type { HarnessOptions } from './options.js';
import {
  array,
  chat,
  compact,
  inputSummary,
  outputSummary,
  reasoning,
  record,
  string,
} from './protocol.js';
import { ProcessSession } from './session.js';

/** Completed items are canonical; deltas are not emitted a second time as duplicate chat. */
export function codexItem(value: unknown, completed: boolean): HarnessEmission[] {
  const item = record(value);
  if (item.type === 'agentMessage' && completed)
    return [chat({ kind: 'message', role: 'assistant', text: string(item.text) })];
  if (item.type === 'reasoning' && completed) {
    const summary = array(item.summary).map(string).join(' ').trim();
    return summary
      ? [{ type: 'reasoning.summary', payload: { text: reasoning(summary), source: 'agent' } }]
      : [];
  }
  if (
    !['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(
      string(item.type),
    )
  )
    return [];
  const failed =
    ['failed', 'declined'].includes(string(item.status)) ||
    (typeof item.exitCode === 'number' && item.exitCode !== 0) ||
    item.success === false;
  const summary =
    item.type === 'commandExecution'
      ? compact(string(item.command))
      : item.type === 'fileChange'
        ? compact(
            array(item.changes)
              .map((change) => string(record(change).path))
              .join(', '),
          )
        : inputSummary(item.arguments);
  const tool = string(item.tool) || string(item.type);
  return [
    chat({
      kind: 'tool_call',
      tool,
      inputSummary: summary,
      ...(completed
        ? {
            outputSummary:
              item.type === 'commandExecution'
                ? `Exit ${typeof item.exitCode === 'number' ? item.exitCode : 'unknown'}; ${outputSummary(item.aggregatedOutput)}`
                : item.type === 'fileChange'
                  ? `${array(item.changes).length} file change(s): ${failed ? 'failed' : 'completed'}`
                  : outputSummary(item.result ?? item.contentItems),
          }
        : {}),
      status: completed ? (failed ? 'failed' : 'succeeded') : 'running',
    }),
  ];
}

export class CodexSession extends ProcessSession {
  private nextId = 1;
  private turnId?: string;
  /** Establish the session only. Core delivers the initial prompt with the first send(). */
  static async start(
    bin: string,
    options: HarnessOptions,
    start: HarnessStartOptions,
  ): Promise<CodexSession> {
    const session = new CodexSession(options, start);
    try {
      await session.connect(bin, ['app-server', '--listen', 'stdio://']);
      await session.rpc('initialize', {
        clientInfo: { name: 'helix', title: 'Helix', version: '0.0.0' },
      });
      await session.write({ method: 'initialized', params: {} });
      const params = {
        cwd: start.cwd,
        approvalPolicy: options.codexApprovalPolicy ?? 'on-request',
        sandbox: options.codexSandbox ?? 'workspace-write',
        ...(start.session.model ? { model: start.session.model } : {}),
        ...(start.resumeToken ? { threadId: start.resumeToken } : {}),
      };
      const response = record(
        await session.rpc(start.resumeToken ? 'thread/resume' : 'thread/start', params),
      );
      const id = string(record(response.thread).id);
      if (!id) throw new HelixError('HARNESS_UNAVAILABLE', 'Codex did not return a thread ID');
      session.resumeToken = id;
      session.activity('idle');
      return session;
    } catch (error) {
      await session.stop();
      throw error;
    }
  }
  private rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return this.request(id, { id, method, params });
  }
  protected async beginTurn(text: string): Promise<void> {
    const response = record(
      await this.rpc('turn/start', {
        threadId: this.resumeToken,
        input: [{ type: 'text', text, text_elements: [] }],
        summary: 'concise',
      }),
    );
    const turn = record(response.turn);
    if (!string(turn.id))
      throw new HelixError('HARNESS_UNAVAILABLE', 'Codex did not return a turn ID');
    // A fast turn can complete before its start response arrives.
    if (this.busy) this.turnId = string(turn.id);
  }
  protected async cancelTurn(): Promise<void> {
    if (this.turnId)
      await this.rpc('turn/interrupt', { threadId: this.resumeToken, turnId: this.turnId });
  }
  protected receive(value: unknown): void {
    const message = record(value);
    const id =
      typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
    const method = string(message.method);
    if (!method && id !== undefined) {
      this.response(
        id,
        message.result,
        message.error ? string(record(message.error).message) || 'Codex request failed' : undefined,
      );
      return;
    }
    const params = record(message.params);
    if (string(params.threadId) && this.resumeToken && params.threadId !== this.resumeToken) return;
    if (id !== undefined) {
      this.serverRequest(id, method, params);
      return;
    }
    if (method === 'thread/started') {
      const threadId = string(record(params.thread).id);
      // Subagent thread notifications must never replace this session's root thread.
      if (threadId && !this.resumeToken) this.resumeToken = threadId;
    } else if (method === 'turn/started') {
      this.turnId = string(record(params.turn).id);
      this.activity('active');
    } else if (method === 'turn/completed') {
      const turn = record(params.turn);
      if (this.turnId && string(turn.id) && turn.id !== this.turnId) return;
      if (turn.status === 'failed')
        this.fail(string(record(turn.error).message) || 'Codex turn failed');
      delete this.turnId;
      this.completeTurn();
    } else if (method === 'item/started' || method === 'item/completed') {
      if (!string(record(params.item).type)) {
        this.invalid('Invalid Codex item');
        return;
      }
      for (const emission of codexItem(params.item, method === 'item/completed'))
        this.emit(emission);
    } else if (method === 'error') {
      this.fail(string(record(params.error).message) || 'Codex reported an error');
    } else if (method === 'serverRequest/resolved') {
      if (typeof params.requestId === 'string' || typeof params.requestId === 'number')
        this.clearApproval(params.requestId);
    } else this.log('Unmapped Codex notification skipped');
  }
  private serverRequest(
    id: string | number,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const command = method === 'item/commandExecution/requestApproval';
    const file = method === 'item/fileChange/requestApproval';
    const permissions = method === 'item/permissions/requestApproval';
    if (command || file || permissions) {
      this.askApproval(
        id,
        {
          kind: command
            ? 'command'
            : file
              ? 'file_write'
              : record(params.permissions).network
                ? 'network'
                : 'other',
          summary: command
            ? string(params.command) || 'Execute command'
            : file
              ? `Apply file changes${string(params.grantRoot) ? ` in ${string(params.grantRoot)}` : ''}`
              : 'Grant additional permissions',
          detail:
            string(params.reason) ||
            (permissions ? inputSummary(params.permissions) : 'Codex requests approval.'),
        },
        (decision) =>
          this.write({
            id,
            result: permissions
              ? {
                  permissions: decision === 'approved' ? record(params.permissions) : {},
                  scope: 'turn',
                }
              : {
                  decision:
                    decision === 'approved'
                      ? 'accept'
                      : decision === 'changes_requested'
                        ? 'cancel'
                        : 'decline',
                },
          }),
      );
      return;
    }
    // Fail unknown requests explicitly so an unsupported interactive tool cannot deadlock.
    void this.write({
      id,
      error: { code: -32601, message: 'Helix does not support this server request' },
    }).catch(() => this.fail('Could not answer Codex request'));
    this.fail(`Unsupported Codex request: ${method}`);
  }
}
