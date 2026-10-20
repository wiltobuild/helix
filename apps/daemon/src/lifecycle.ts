import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, parsePort, type ServerOptions } from './server.js';

export type DaemonOptions = ServerOptions & { dataDir: string; version: string };

/** Owns core startup, the loopback listener, run file and signal handlers. */
export async function startDaemon(options: DaemonOptions) {
  const app = await createServer(options);
  const runPath = join(options.dataDir, 'run.json');
  const startedAt = new Date().toISOString();
  let runContents: string | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= app.close());
  const onSignal = () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  };
  const signals: NodeJS.Signals[] = [
    'SIGINT',
    'SIGTERM',
    ...(process.platform === 'win32' ? ['SIGBREAK' as const] : []),
  ];
  app.addHook('onClose', async () => {
    for (const signal of signals) process.off(signal, onSignal);
    // Do not remove a successor daemon's run file.
    if (runContents && (await readFile(runPath, 'utf8').catch(() => undefined)) === runContents)
      await unlink(runPath).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      });
  });
  try {
    await options.core.start();
    await app.listen({
      host: '127.0.0.1',
      port: parsePort(options.port ?? process.env.HELIX_PORT),
    });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    await mkdir(options.dataDir, { recursive: true });
    runContents = JSON.stringify({
      pid: process.pid,
      port: address.port,
      startedAt,
      version: options.version,
    });
    await writeFile(runPath, runContents, 'utf8');
    for (const signal of signals) process.on(signal, onSignal);
    return { server: app, port: address.port, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
