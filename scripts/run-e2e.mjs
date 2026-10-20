import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const child = spawn(
  process.execPath,
  [require.resolve('turbo/bin/turbo'), 'run', 'test:e2e', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, HELIX_E2E: '1' },
  },
);
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
