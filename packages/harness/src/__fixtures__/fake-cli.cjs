const { createInterface } = require('node:readline');
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const claude = args[0] === 'claude';
if (args.includes('--version')) {
  console.log('fixture-cli 1.0.0');
  process.exit(0);
}
if (args.includes('status')) {
  console.log(claude ? JSON.stringify({ loggedIn: true }) : 'Logged in using ChatGPT');
  process.exit(0);
}
if (process.env.HELIX_FAKE_CHILD_FILE) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.HELIX_FAKE_CHILD_FILE, String(child.pid));
}
if (process.env.HELIX_FAKE_ARGS_FILE)
  writeFileSync(process.env.HELIX_FAKE_ARGS_FILE, JSON.stringify(args));
if (process.env.HELIX_FAKE_ENV_FILE)
  writeFileSync(
    process.env.HELIX_FAKE_ENV_FILE,
    JSON.stringify({
      base: process.env.HELIX_FAKE_BASE_VALUE,
      only: process.env.HELIX_FAKE_SESSION_VALUE,
      path: process.env[process.env.HELIX_FAKE_PATH_KEY || 'PATH'] ?? process.env.Path,
      pathKeys: Object.keys(process.env).filter((key) => key.toLowerCase() === 'path'),
    }),
  );
const scenario = process.env.HELIX_FAKE_SCENARIO;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\r\n');
let thread = 'fixture-thread';
let turn = 0;
let timer;
let current;
let awaitingApproval;
function finish(text = 'ok') {
  if (!current) return;
  const id = current;
  current = undefined;
  if (claude) {
    send({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    send({ type: 'result', subtype: 'success', session_id: thread, is_error: false });
  } else {
    send({
      method: 'item/completed',
      params: { threadId: thread, item: { type: 'agentMessage', text } },
    });
    send({
      method: 'turn/completed',
      params: { threadId: thread, turn: { id, status: 'completed' } },
    });
  }
}
function start(text) {
  current = `turn-${++turn}`;
  if (text === 'exit') {
    setTimeout(() => {
      const last = claude
        ? {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'final without newline' }] },
          }
        : {
            method: 'item/completed',
            params: { item: { type: 'agentMessage', text: 'final without newline' } },
          };
      process.stdout.write(JSON.stringify(last), () => process.exit(0));
    }, 50);
    return current;
  }
  if (process.env.HELIX_FAKE_FIXTURE) {
    const data = readFileSync(process.env.HELIX_FAKE_FIXTURE, 'utf8');
    setTimeout(() => {
      for (const row of data.trim().split('\n'))
        send(
          JSON.parse(
            row
              .replaceAll('fixture-codex-thread', thread)
              .replaceAll('fixture-claude-session', thread),
          ),
        );
    }, 20);
    return current;
  }
  if (claude) send({ type: 'system', subtype: 'init', session_id: thread });
  else send({ method: 'turn/started', params: { threadId: thread, turn: { id: current } } });
  if (text === 'noise') {
    // The turn/start reply must be a complete frame before splitting the next
    // frame. Interleaving bytes would corrupt the reply, not test recovery.
    setTimeout(() => {
      process.stdout.write('not json\r\n{"partial":');
      setTimeout(() => {
        process.stdout.write('true}\r\n');
        finish(text);
      }, 5);
    }, 10);
    return current;
  }
  if (text.startsWith('approve')) {
    awaitingApproval = 'server-approval';
    if (claude)
      send({
        type: 'control_request',
        request_id: awaitingApproval,
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' } },
      });
    else
      send({
        id: awaitingApproval,
        method:
          text === 'approve-files'
            ? 'item/fileChange/requestApproval'
            : text === 'approve-permissions'
              ? 'item/permissions/requestApproval'
              : 'item/commandExecution/requestApproval',
        params: {
          threadId: thread,
          turnId: current,
          itemId: 'tool-1',
          command: 'npm test',
          permissions: { network: { enabled: true } },
        },
      });
  } else if (text !== 'hold') timer = setTimeout(() => finish(text), 50);
  return current;
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (process.env.HELIX_FAKE_STDERR) {
    process.stderr.write('discarded diagnostic prefix\n' + 'x'.repeat(8192));
    process.stderr.write('\nfixture handshake diagnostic: UTF-8 hé🙂\n');
  }
  if (process.env.HELIX_FAKE_TRANSCRIPT)
    appendFileSync(process.env.HELIX_FAKE_TRANSCRIPT, line + '\n');
  if (claude) {
    if (message.type === 'control_request') {
      if (message.request.subtype === 'initialize') {
        if (scenario === 'timeout') return;
        if (scenario === 'exit') return process.exit(7);
        send({
          type: 'control_response',
          response: {
            request_id: message.request_id,
            subtype: scenario === 'error' ? 'error' : 'success',
            error: 'Fixture initialization rejected',
            response: {},
          },
        });
        const resume = args.find((value) => value.startsWith('--resume='));
        if (resume) thread = resume.slice('--resume='.length);
      } else if (message.request.subtype === 'interrupt') {
        clearTimeout(timer);
        send({
          type: 'control_response',
          response: { subtype: 'success', request_id: message.request_id, response: {} },
        });
        finish('interrupted');
      }
    } else if (message.type === 'user') start(message.message.content);
    else if (
      message.type === 'control_response' &&
      message.response.request_id === awaitingApproval
    )
      finish('approval handled');
  } else if (message.method === 'initialize') {
    if (scenario === 'timeout') return;
    if (scenario === 'exit') return process.exit(7);
    send(
      scenario === 'error'
        ? { id: message.id, error: { code: -1, message: 'Fixture initialization rejected' } }
        : { id: message.id, result: {} },
    );
  } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    thread = message.params.threadId || thread;
    send({ id: message.id, result: { thread: { id: thread } } });
  } else if (message.method === 'turn/start') {
    const id = start(message.params.input[0].text);
    send({ id: message.id, result: { turn: { id } } });
  } else if (message.method === 'turn/interrupt') {
    clearTimeout(timer);
    send({ id: message.id, result: {} });
    finish('interrupted');
  } else if (message.id === awaitingApproval) finish('approval handled');
});
setInterval(() => {}, 1000);
// A failed test must not leave its synthetic worker running indefinitely.
setTimeout(() => process.exit(99), 60_000).unref();
