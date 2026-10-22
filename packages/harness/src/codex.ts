import path from 'node:path';
import {
  HelixError,
  type AgentActivity,
  type HarnessEmission,
  type HarnessStartOptions,
} from '@helix/contracts';
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
import { insideWorktree } from './worktree-paths.js';
import { HELIX_GIT_INSTRUCTIONS, isGitWriteCommand } from './git-policy.js';

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
  private fileChanges = new Map<string, string[]>();
  private inputRequests: {
    id: string | number;
    questions: Record<string, unknown>[];
    answers: Record<string, { answers: string[] }>;
  }[] = [];
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
        developerInstructions: HELIX_GIT_INSTRUCTIONS,
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
    if (id !== undefined) {
      // Requests (including subagent requests) must always receive a response.
      void this.serverRequest(id, method, params).catch(() => {
        this.note(`Could not handle Codex server request: ${method}`);
        void this.write({
          id,
          error: { code: -32603, message: 'Helix could not handle this request' },
        }).catch(() => this.fail('Could not answer Codex request'));
      });
      return;
    }
    if (
      (method === 'item/started' && record(params.item).type === 'fileChange') ||
      method === 'item/fileChange/patchUpdated'
    ) {
      const item =
        method === 'item/started'
          ? record(params.item)
          : { id: params.itemId, changes: params.changes };
      const paths = array(item.changes).flatMap((value) => {
        const change = record(value);
        const moved = string(record(change.kind).move_path);
        return [string(change.path), ...(moved ? [moved] : [])];
      });
      this.fileChanges.set(JSON.stringify([params.threadId, params.turnId, item.id]), paths);
    }
    if (string(params.threadId) && this.resumeToken && params.threadId !== this.resumeToken) return;
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
      // Complete any outstanding interaction rather than orphaning an RPC at a turn boundary.
      for (const input of this.inputRequests.splice(0))
        void this.write({ id: input.id, result: { answers: input.answers } }).catch(() =>
          this.fail('Could not close Codex question'),
        );
      this.fileChanges.clear();
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
      const removedCurrentQuestion = this.inputRequests[0]?.id === params.requestId;
      this.inputRequests = this.inputRequests.filter((input) => input.id !== params.requestId);
      if (typeof params.requestId === 'string' || typeof params.requestId === 'number')
        this.clearApproval(params.requestId);
      if (removedCurrentQuestion) this.showQuestion();
    } else this.log('Unmapped Codex notification skipped');
  }
  protected override activity(activity: AgentActivity): void {
    super.activity(
      this.inputRequests.length && (activity === 'active' || activity === 'idle')
        ? 'waiting_input'
        : activity,
    );
  }
  protected override async answerInput(text: string): Promise<boolean> {
    const input = this.inputRequests[0];
    if (!input) return false;
    const question = input.questions.shift()!;
    input.answers[string(question.id)] = { answers: [text] };
    if (!input.questions.length) {
      await this.write({ id: input.id, result: { answers: input.answers } });
      this.inputRequests.shift();
    }
    this.showQuestion();
    return true;
  }
  private showQuestion(): void {
    const question = this.inputRequests[0]?.questions[0];
    if (question) {
      const options = array(question.options)
        .map((option) => string(record(option).label))
        .filter(Boolean);
      // CONTRACT-REQUEST: ChatItem.question needs IDs and secret-answer metadata.
      this.emit(
        chat({
          kind: 'question',
          prompt: string(question.question),
          ...(options.length ? { options } : {}),
        }),
      );
      this.activity('waiting_input');
    } else if (!this.approvals.size) this.activity(this.busy ? 'active' : 'idle');
  }
  private async serverRequest(
    id: string | number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const legacy = method === 'applyPatchApproval' || method === 'execCommandApproval';
    const command =
      method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval';
    const file = method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval';
    const permissions = method === 'item/permissions/requestApproval';
    if (command && isGitWriteCommand(params.command)) {
      this.note(`Declined agent Git write: ${HELIX_GIT_INSTRUCTIONS}`);
      await this.write({
        id,
        result: {
          decision: legacy ? { denied: { rejection: HELIX_GIT_INSTRUCTIONS } } : 'decline',
        },
      });
      if (!legacy) {
        // The modern decline enum has no reason field. Steer the active turn with the explanation.
        try {
          await this.rpc('turn/steer', {
            threadId: string(params.threadId),
            expectedTurnId: string(params.turnId),
            input: [{ type: 'text', text: HELIX_GIT_INSTRUCTIONS, text_elements: [] }],
          });
        } catch {
          this.note(
            'Git command declined; the completed turn could not receive the Helix Git reminder.',
          );
        }
      }
      return;
    }
    if (command || file || permissions) {
      const respond = (decision: 'approved' | 'rejected' | 'changes_requested') =>
        this.write({
          id,
          result: permissions
            ? {
                permissions: decision === 'approved' ? record(params.permissions) : {},
                scope: 'turn',
              }
            : {
                decision: legacy
                  ? decision === 'approved'
                    ? 'approved'
                    : decision === 'changes_requested'
                      ? 'abort'
                      : { denied: { rejection: 'Rejected by the user in Helix' } }
                  : decision === 'approved'
                    ? 'accept'
                    : decision === 'changes_requested'
                      ? 'cancel'
                      : 'decline',
              },
        });
      const paths = legacy
        ? Object.entries(record(params.fileChanges)).flatMap(([filename, change]) => [
            filename,
            ...(string(record(change).move_path) ? [string(record(change).move_path)] : []),
          ])
        : (this.fileChanges.get(JSON.stringify([params.threadId, params.turnId, params.itemId])) ??
          []);
      const requestThread = string(params.threadId) || string(params.conversationId);
      const knownCwd =
        !requestThread ||
        requestThread === this.resumeToken ||
        paths.every((filename) => path.isAbsolute(filename));
      if (file && knownCwd && insideWorktree(this.startOptions.cwd, paths)) {
        await respond('approved');
        this.note(
          `Codex ${method}: auto-approved ${paths.length} file path(s) inside the session worktree.`,
        );
        return;
      }
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
            ? string(params.command) ||
              array(params.command).map(string).join(' ') ||
              'Execute command'
            : file
              ? `Apply file changes${string(params.grantRoot) ? ` in ${string(params.grantRoot)}` : ''}`
              : 'Grant additional permissions',
          detail:
            string(params.reason) ||
            (permissions ? inputSummary(params.permissions) : 'Codex requests approval.'),
        },
        respond,
      );
      return;
    }
    if (method === 'item/tool/requestUserInput') {
      const questions = array(params.questions).map(record);
      if (!questions.length) {
        await this.write({ id, result: { answers: {} } });
        return;
      }
      if (questions.some((q) => !string(q.id) || !string(q.question))) {
        await this.write({ id, error: { code: -32602, message: 'Invalid question' } });
        this.note('Codex requestUserInput rejected: missing question ID or prompt.');
        return;
      }
      this.inputRequests.push({ id, questions, answers: {} });
      if (this.inputRequests.length === 1) this.showQuestion();
      return;
    }
    const message = `Helix does not support Codex server request: ${method}`;
    if (method === 'mcpServer/elicitation/request')
      await this.write({ id, result: { action: 'decline', content: null } });
    else if (method === 'item/tool/call')
      await this.write({
        id,
        result: { success: false, contentItems: [{ type: 'inputText', text: message }] },
      });
    else
      await this.write({
        id,
        error: {
          code: ['attestation/generate', 'account/chatgptAuthTokens/refresh'].includes(method)
            ? -32000
            : -32601,
          message,
        },
      });
    this.note(message);
  }
}
