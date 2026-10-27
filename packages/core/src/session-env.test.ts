import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createHelixCore, type CoreDeps } from './index.js';
import { fixture } from './test-support.js';

const request = { title: 'Task', prompt: 'Plan it', agent: 'codex', interface: 'chat' } as const;

test.each([true, false])(
  'session env reaches chat launch and resume (orchestrator=%s)',
  async (orchestrator) => {
    let revision = 0;
    const sessionEnv = vi.fn<NonNullable<CoreDeps['sessionEnv']>>(({ project, session }) => ({
      SESSION: session.id,
      PROJECT: project.id,
      ROLE: session.role,
      REVISION: String(++revision),
    }));
    const f = fixture({ sessionEnv });
    try {
      const project = await f.add();
      const session = await f.core.createSession(
        project.id,
        {
          ...request,
          planWithOrchestrator: orchestrator,
        },
        'env',
      );
      expect(sessionEnv).toHaveBeenCalledExactlyOnceWith({ project, session });
      expect(f.harness.start).toHaveBeenLastCalledWith(
        expect.objectContaining({
          env: { SESSION: session.id, PROJECT: project.id, ROLE: session.role, REVISION: '1' },
        }),
      );
      const restarted = createHelixCore(f.deps);
      await restarted.start();
      await restarted.shutdown();
      expect(sessionEnv).toHaveBeenCalledTimes(2);
      expect(f.harness.start).toHaveBeenLastCalledWith(
        expect.objectContaining({
          resumeToken: `resume-${session.id}`,
          env: { SESSION: session.id, PROJECT: project.id, ROLE: session.role, REVISION: '2' },
        }),
      );
    } finally {
      await f.core.shutdown();
    }
  },
);

test.each([true, false])(
  'session env merges over terminal options (orchestrator=%s)',
  async (orchestrator) => {
    const terminalEnv = { KEEP: 'base', OVERRIDE: 'base', Path: 'base-path' };
    const f = fixture({
      terminalOptions: (s) => ({
        command: process.execPath,
        args: [],
        cwd: s.worktreePath ?? path.resolve('.'),
        env: terminalEnv,
      }),
      sessionEnv: ({ session }) => ({ OVERRIDE: session.role, PATH: 'session-path' }),
    });
    try {
      const p = await f.add();
      const s = await f.core.createSession(
        p.id,
        {
          ...request,
          interface: 'terminal',
          planWithOrchestrator: orchestrator,
        },
        'terminal-env',
      );
      const options = f.terminals.spawn.mock.calls.at(-1)![1];
      expect(options.env).toMatchObject({ KEEP: 'base', OVERRIDE: s.role, PATH: 'session-path' });
      if (process.platform === 'win32')
        expect(Object.keys(options.env!).filter((key) => key.toLowerCase() === 'path')).toEqual([
          'PATH',
        ]);
      expect(terminalEnv).toEqual({ KEEP: 'base', OVERRIDE: 'base', Path: 'base-path' });
    } finally {
      await f.core.shutdown();
    }
  },
);

test('undefined session env preserves existing terminal environment', async () => {
  const env = { KEEP: 'base' };
  const f = fixture({
    terminalOptions: (s) => ({ command: process.execPath, args: [], cwd: s.worktreePath!, env }),
    sessionEnv: () => undefined,
  });
  try {
    const p = await f.add();
    await f.core.createSession(p.id, { ...request, interface: 'terminal' }, 'unchanged');
    expect(f.terminals.spawn.mock.calls.at(-1)![1].env).toEqual(env);
  } finally {
    await f.core.shutdown();
  }
});
