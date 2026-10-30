// Deterministic local app-server fixture; no model or network access.
const fs = require('node:fs');
const readline = require('node:readline');
const log = process.argv[2];
const record = (value) => fs.appendFileSync(log, JSON.stringify(value) + '\n');
record({
  spawnedEnvironment: {
    forbiddenKeys: Object.keys(process.env).filter((key) => /^(HELIX_|GIT_)/i.test(key)),
    safe: process.env.DISCOVERY_SAFE_TEST,
    temp: process.env.TEMP,
  },
});
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  record(frame);
  if (frame.id !== undefined) {
    const result =
      frame.method === 'config/read'
        ? { config: {} }
        : frame.method === 'thread/start'
          ? { thread: { id: 'synthetic-discovery' } }
          : {};
    process.stdout.write(JSON.stringify({ id: frame.id, result }) + '\n');
  }
});
