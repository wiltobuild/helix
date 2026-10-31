import { trustedGit } from '@helix/git';
import { get } from 'node:http';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { sessionIdSchema } from '@helix/contracts';
import { createOutputHost, readOutputArtifact, outputCsp } from './output-host.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function artifact() {
  const dir = await mkdtemp(join(tmpdir(), 'helix-output-test-'));
  dirs.push(dir);
  const binary = await trustedGit(dir);
  const git = (...args: string[]) =>
    execFileSync(binary, args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Output Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await mkdir(join(dir, '.helix/output'), { recursive: true });
  await writeFile(
    join(dir, '.helix/output/index.html'),
    '<h1>Fixture application</h1><button onclick="this.textContent=\'Clicked\'">Try me</button>',
  );
  await writeFile(join(dir, 'private.txt'), 'Never serve this');
  git('add', '.');
  git('commit', '-qm', 'Synthetic fixture');
  return { dir, git, sha: git('rev-parse', 'HEAD') };
}

test('hosts only an immutable committed export on a free private loopback listener and stops its own listener', async () => {
  const f = await artifact();
  // Harmless executable shadow must never be selected from the worker checkout.
  await writeFile(join(f.dir, 'git.exe'), 'This is deliberately not an executable.');
  await writeFile(join(f.dir, 'git.com'), 'This is deliberately not an executable.');
  const host = createOutputHost();
  const id = sessionIdSchema.parse('worker-output');
  const signal = new AbortController().signal;
  const preview = await host.start({ workerSessionId: id, path: f.dir, headSha: f.sha, signal });
  try {
    await writeFile(join(f.dir, '.helix/output/index.html'), 'uncommitted changed content');
    const wrapper = await fetch(preview.url);
    expect(wrapper.headers.get('content-security-policy')).toContain(
      `frame-src ${preview.url}app/`,
    );
    expect(wrapper.headers.get('content-security-policy')).toContain("form-action 'none'");
    expect(wrapper.headers.get('content-security-policy')).toContain(
      'sandbox allow-scripts allow-forms',
    );
    expect((await fetch(preview.url + 'app/index.html')).status).toBe(404);
    const wrapperText = await wrapper.text();
    expect(wrapperText).toContain("fetch(frame.src, {method:'HEAD', credentials:'omit'})");
    const nonce = /script nonce="([a-f0-9]+)"/.exec(wrapperText)![1]!;
    // Wrapper launch ticket is single-use; this HTTP test does not prove browser interaction.
    expect(wrapperText).not.toContain('RTCPeerConnection');
    expect(wrapperText).not.toContain('securitypolicyviolation');
    const grant = await fetch(preview.url + 'enable', {
      method: 'POST',
      headers: { Origin: 'null' },
      body: nonce,
    });
    const { capability } = (await grant.json()) as { capability: string };
    expect(
      (
        await fetch(preview.url + 'enable', {
          method: 'POST',
          headers: { Origin: 'null' },
          body: nonce,
        })
      ).status,
    ).toBe(403);
    const response = await fetch(preview.url + 'app/' + capability + '/index.html');
    expect(await response.text()).toContain('Fixture application');
    expect(response.headers.get('content-security-policy')).toBe(outputCsp);
    expect(outputCsp).toContain("form-action 'none'");
    expect(outputCsp).toContain('sandbox allow-scripts allow-forms');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(new URL('/private.txt', preview.url))).status).toBe(403);
    expect((await fetch(`${preview.url}%2e%2e/private.txt`)).status).toBe(403);
    expect((await fetch(`${preview.url}private.txt`)).status).toBe(404);
    expect((await fetch(preview.url, { method: 'POST' })).status).toBe(403);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(preview.url, { headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    expect(hostStatus).toBe(403);
    expect(host.lease(id)).toEqual(preview);
  } finally {
    await host.stop(id);
  }
  await host.stop(id);
  expect(host.lease(id)).toBeUndefined();
  await expect(fetch(preview.url)).rejects.toThrow();
});

test('canceled startups, invalid revisions, unsupported files and git symlinks fail closed', async () => {
  const f = await artifact();
  const abort = new AbortController();
  abort.abort();
  // Harmless executable shadow must never be selected from the worker checkout.
  await writeFile(join(f.dir, 'git.exe'), 'This is deliberately not an executable.');
  await writeFile(join(f.dir, 'git.com'), 'This is deliberately not an executable.');
  const host = createOutputHost();
  const id = sessionIdSchema.parse('worker-output');
  await expect(
    host.start({ workerSessionId: id, path: f.dir, headSha: f.sha, signal: abort.signal }),
  ).rejects.toThrow();
  expect(host.lease(id)).toBeUndefined();
  await expect(
    readOutputArtifact(f.dir, 'HEAD; arbitrary', new AbortController().signal),
  ).rejects.toThrow('Invalid');
  await writeFile(join(f.dir, '.helix/output/secret.env'), 'SECRET');
  f.git('add', '.');
  f.git('commit', '-qm', 'Unsupported fixture');
  await expect(
    readOutputArtifact(f.dir, f.git('rev-parse', 'HEAD'), new AbortController().signal),
  ).rejects.toThrow('unsupported');
  f.git('rm', '.helix/output/secret.env');
  const blob = f.git('rev-parse', `${f.sha}:.helix/output/index.html`);
  f.git('update-index', '--add', '--cacheinfo', `120000,${blob},.helix/output/link.html`);
  f.git('commit', '-qm', 'Symlink fixture');
  await expect(
    readOutputArtifact(f.dir, f.git('rev-parse', 'HEAD'), new AbortController().signal),
  ).rejects.toThrow('symlink');
});

test('fresh and reset wrapper documents wait for application load and fail closed on timeout', async () => {
  const f = await artifact();
  const host = createOutputHost();
  const id = sessionIdSchema.parse('worker-wrapper-lifecycle');
  const preview = await host.start({
    workerSessionId: id,
    path: f.dir,
    headSha: f.sha,
    signal: new AbortController().signal,
  });
  try {
    for (const load of ['#1-0', '#1-1', '#1-2']) {
      const html = await (await fetch(preview.url)).text();
      const script = /<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
      const messages: unknown[] = [];
      const status = { textContent: '', remove() {} };
      const frame = {
        title: '',
        src: '',
        referrerPolicy: '',
        onload: undefined as (() => Promise<void>) | undefined,
        onerror: undefined as (() => void) | undefined,
        removed: false,
        setAttribute() {},
        remove() {
          this.removed = true;
        },
      };
      let appended = false;
      let timeout: (() => void) | undefined;
      let cleared = false;
      // Execute the actual served wrapper script. This tests handshake ordering,
      // not browser document navigation, CSP enforcement or React mounting.
      runInNewContext(script, {
        document: {
          getElementById: () => status,
          createElement: () => frame,
          body: {
            appendChild: () => {
              appended = true;
            },
          },
        },
        location: { hash: load },
        parent: { postMessage: (message: unknown) => messages.push(message) },
        setTimeout: (callback: () => void) => {
          timeout = callback;
          return 1;
        },
        clearTimeout: () => {
          cleared = true;
        },
        fetch: async (url: string, init: RequestInit) =>
          fetch(url, { ...init, headers: { Origin: 'null' } }),
      });
      await expect.poll(() => appended).toBe(true);
      expect(messages).toEqual([]);
      expect(frame.src).toMatch(/\/app\/[a-f0-9]{48}\/index\.html$/);
      if (load === '#1-1') {
        timeout!();
        await frame.onload!();
        expect(frame.removed).toBe(true);
        expect(messages).toEqual([{ type: 'helix-output-unavailable', load }]);
      } else {
        await frame.onload!();
        timeout!();
        expect(frame.removed).toBe(false);
        expect(messages).toEqual([{ type: 'helix-output-ready', load }]);
      }
      expect(cleared).toBe(true);
    }
  } finally {
    await host.stop(id);
  }
});
