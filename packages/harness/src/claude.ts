import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, HarnessEmission, HarnessStartOptions } from '@helix/contracts';
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
import { HELIX_GIT_INSTRUCTIONS, isGitWriteCommand } from './git-policy.js';

/** State is only protocol correlation, never a stored display status. */
export class ClaudeMessages {
  private tools = new Map<string, { tool: string; inputSummary: string }>();
  parse(value: unknown): HarnessEmission[] {
    const message = record(value);
    const emissions: HarnessEmission[] = [];
    if (message.type === 'assistant' || message.type === 'user') {
      for (const raw of array(record(message.message).content)) {
        const block = record(raw);
        if (block.type === 'text' && message.type === 'assistant') {
          emissions.push(chat({ kind: 'message', role: 'assistant', text: string(block.text) }));
        } else if (block.type === 'thinking' && string(block.thinking)) {
          emissions.push({
            type: 'reasoning.summary',
            payload: { text: reasoning(string(block.thinking)), source: 'agent' },
          });
        } else if (block.type === 'tool_use') {
          const tool = {
            tool: string(block.name) || 'tool',
            inputSummary: inputSummary(block.input),
          };
          this.tools.set(string(block.id), tool);
          emissions.push(chat({ kind: 'tool_call', ...tool, status: 'running' }));
        } else if (block.type === 'tool_result') {
          const id = string(block.tool_use_id);
          const tool = this.tools.get(id) ?? { tool: 'tool', inputSummary: 'Earlier tool call' };
          emissions.push(
            chat({
              kind: 'tool_call',
              ...tool,
              outputSummary: outputSummary(block.content),
              status: block.is_error ? 'failed' : 'succeeded',
            }),
          );
          this.tools.delete(id);
        }
      }
    }
    if (message.type === 'result') this.tools.clear();
    return emissions;
  }
}

export class ClaudeSession extends ProcessSession {
  private messages = new ClaudeMessages();
  /** Establish the session only. Core delivers the initial prompt with the first send(). */
  static async start(
    bin: string,
    options: HarnessOptions,
    start: HarnessStartOptions,
  ): Promise<ClaudeSession> {
    const session = new ClaudeSession(options, start);
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--append-system-prompt',
      HELIX_GIT_INSTRUCTIONS,
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      options.claudePermissionMode ?? 'manual',
    ];
    if (start.resumeToken) args.push(`--resume=${start.resumeToken}`);
    if (start.session.model) args.push('--model', start.session.model);
    try {
      await session.connect(bin, args);
      await session.control({ subtype: 'initialize', hooks: null });
      session.activity('idle');
      return session;
    } catch (error) {
      await session.stop();
      throw error;
    }
  }
  private control(request: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID();
    return this.request(id, { type: 'control_request', request_id: id, request });
  }
  protected beginTurn(text: string): Promise<void> {
    return this.write({
      type: 'user',
      session_id: this.resumeToken ?? '',
      parent_tool_use_id: null,
      message: { role: 'user', content: text },
    });
  }
  protected async cancelTurn(): Promise<void> {
    await this.control({ subtype: 'interrupt' });
  }
  protected receive(value: unknown): void {
    const message = record(value);
    if (string(message.session_id)) this.resumeToken = string(message.session_id);
    if (message.type === 'control_response') {
      const response = record(message.response);
      this.response(
        string(response.request_id),
        response.response,
        response.subtype === 'error'
          ? string(response.error) || 'Claude control request failed'
          : undefined,
      );
    } else if (message.type === 'control_request') {
      const request = record(message.request);
      const id = string(message.request_id);
      if (!id) {
        this.invalid('Claude control request has no ID');
        return;
      }
      if (request.subtype !== 'can_use_tool') {
        void this.write({
          type: 'control_response',
          response: { subtype: 'error', request_id: id, error: 'Unsupported control request' },
        }).catch(() => this.fail('Could not answer Claude control request'));
        this.invalid('Unsupported Claude control request');
        return;
      }
      const tool = string(request.tool_name);
      const input = record(request.input);
      if (/bash|shell|command/i.test(tool) && isGitWriteCommand(input.command)) {
        this.note(`Declined agent Git write: ${HELIX_GIT_INSTRUCTIONS}`);
        void this.write({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: id,
            response: { behavior: 'deny', message: HELIX_GIT_INSTRUCTIONS },
          },
        }).catch(() => this.fail('Could not decline Claude Git command'));
        return;
      }
      const respond = (decision: ApprovalDecision) =>
        this.write({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: id,
            response:
              decision === 'approved'
                ? { behavior: 'allow', updatedInput: input }
                : {
                    behavior: 'deny',
                    message:
                      decision === 'changes_requested'
                        ? 'Changes requested by the user. Revise this action.'
                        : 'Denied by the user.',
                  },
          },
        });
      if (/bash|shell|command/i.test(tool) && this.autoApprove(input.command, respond)) return;
      this.askApproval(
        id,
        {
          kind: /bash|shell|command/i.test(tool)
            ? 'command'
            : /write|edit/i.test(tool)
              ? 'file_write'
              : 'other',
          summary: `${tool || 'Tool'}: ${inputSummary(input)}`,
          detail:
            string(request.decision_reason) ||
            'Claude Code requests permission for this tool call.',
        },
        respond,
      );
    } else if (message.type === 'control_cancel_request') {
      this.clearApproval(string(message.request_id));
    } else if (message.type === 'result') {
      if (message.is_error || (string(message.subtype) && message.subtype !== 'success')) {
        const errors = array(message.errors).map(string).filter(Boolean).join('; ');
        this.fail(compact(errors || string(message.result) || 'Claude turn failed', 400));
      }
      this.messages.parse(message);
      this.completeTurn();
    } else if (message.type === 'error') {
      this.fail(
        string(message.message) ||
          string(record(message.error).message) ||
          'Claude reported an error',
      );
    } else if (message.type === 'assistant' || message.type === 'user') {
      if (!Array.isArray(record(message.message).content)) {
        this.invalid('Invalid Claude message content');
        return;
      }
      for (const emission of this.messages.parse(message)) this.emit(emission);
    } else if (message.type !== 'system' && message.type !== 'stream_event') {
      this.log('Unknown Claude message type skipped');
    }
  }
}
