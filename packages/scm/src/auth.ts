import { spawn } from 'node:child_process';
import { HelixError } from '@helix/contracts';

const unauthorized = () =>
  new HelixError(
    'UNAUTHORIZED',
    'GitHub authentication is unavailable; set GH_TOKEN or GITHUB_TOKEN, or run `gh auth login`.',
  );

/** Resolve credentials without a shell, logging, or including child stderr in errors. */
export async function resolveGitHubToken(explicit?: string): Promise<string> {
  const token =
    explicit?.trim() || process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (token) return token;
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['auth', 'token'], {
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
      if (value) resolve(value);
      else reject(unauthorized());
    };
    const kill = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      kill();
      finish();
    }, 10_000);
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
    child.on('close', (code) =>
      finish(code === 0 ? output.replace(/\r\n/g, '\n').trim() : undefined),
    );
  });
}
