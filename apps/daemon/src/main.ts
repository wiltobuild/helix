import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHelixCore } from '@helix/core';
import { startDaemon } from './lifecycle.js';

const dataDir = process.env.HELIX_DATA_DIR ?? join(homedir(), '.helix');
const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
// INTEGRATION: Claude must compose storage/harness/git/SCM/terminal dependencies here
// if the merged factory accepts CoreDeps rather than the daemon brief's options.
const core = await createHelixCore({ dataDir });
await startDaemon({ core, dataDir, version: manifest.version });
