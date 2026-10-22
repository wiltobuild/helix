import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRealCore } from './real-core.js';
import { startDaemon } from './lifecycle.js';

const dataDir = process.env.HELIX_DATA_DIR ?? join(homedir(), '.helix');
const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
const core = await createRealCore({ dataDir, env: process.env });
await startDaemon({ core, dataDir, version: manifest.version });
