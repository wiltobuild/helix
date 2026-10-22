const { createInterface } = require('node:readline');

// Fill stderr while stdin stays open and idle. Stdout must still progress.
process.stderr.write('e'.repeat(128 * 1024), () => process.stdout.write('ready\n'));
createInterface({ input: process.stdin }).on('line', (line) => {
  process.stdout.write(line + '\n');
});
