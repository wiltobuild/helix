import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HelixError } from '@helix/contracts';

const execute = promisify(execFile);
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
function signal(pid: number, value: NodeJS.Signals): void {
  try {
    process.kill(pid, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
    throw new HelixError('INVALID_REQUEST', 'Invalid terminal process ID.');
  try {
    if (process.platform === 'win32') {
      try {
        await execute('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          shell: false,
        });
      } catch (error) {
        if (alive(pid)) throw error;
      }
      return;
    }
    // Freeze the root while discovering descendants so it cannot fork during teardown.
    signal(pid, 'SIGSTOP');
    const { stdout } = await execute('ps', ['-A', '-o', 'pid=,ppid='], { shell: false });
    const children = new Map<number, number[]>();
    for (const line of stdout.replace(/\r\n/g, '\n').trim().split('\n')) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (child && parent) children.set(parent, [...(children.get(parent) ?? []), child]);
    }
    const descendants: number[] = [];
    const visit = (parent: number) => {
      for (const child of children.get(parent) ?? []) {
        signal(child, 'SIGSTOP');
        descendants.push(child);
        visit(child);
      }
    };
    visit(pid);
    // node-pty creates a session/process group; this also catches late children in that group.
    signal(-pid, 'SIGKILL');
    for (const child of descendants.reverse()) signal(child, 'SIGKILL');
    signal(pid, 'SIGKILL');
  } catch (error) {
    if (process.platform !== 'win32') {
      try {
        signal(pid, 'SIGCONT');
      } catch {
        /* Preserve the kill failure. */
      }
    }
    throw new HelixError(
      'INTERNAL_ERROR',
      `Unable to terminate terminal process tree (${pid}): ${error instanceof Error ? error.message : String(error)}`,
      {
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  }
}
