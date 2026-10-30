import { spawn } from 'node:child_process';
// CONTRACT-REQUEST: export token discovery from @helix/scm so composition can
// decide whether SCM is available without duplicating its credential lookup.
export function resolveGitHubToken(
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (token) return Promise.resolve(token);
  return new Promise((resolve) => {
    const child = spawn('gh', ['auth', 'token'], {
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const kill = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          shell: false,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      kill();
      finish();
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 16_384) {
        kill();
        finish();
      }
    });
    child.on('error', () => finish());
    child.on('close', (code) => finish(code === 0 ? output.trim() || undefined : undefined));
  });
}
