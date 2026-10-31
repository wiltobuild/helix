import { trustedGit } from '@helix/git';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { SessionId } from '@helix/contracts';
import type { OutputHost } from '@helix/core';

const LIMIT = 32 * 1024 * 1024;
const mime: Record<string, string> = {
  html: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ico: 'image/x-icon',
};
export const outputCsp =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts allow-forms";

async function git(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  maxBuffer = LIMIT,
): Promise<Buffer> {
  // Resolve against the daemon environment, never the untrusted worker cwd.
  const binary = await trustedGit(cwd);
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ['--no-optional-locks', ...args],
      { cwd, signal, timeout: 15000, maxBuffer, encoding: 'buffer', windowsHide: true },
      (error, stdout) =>
        error ? reject(new Error('Could not read committed Output artifact')) : resolve(stdout),
    );
  });
}

/** Read blobs by object ID, never by a caller path, and never follow symlinks/config hooks. */
export async function readOutputArtifact(path: string, headSha: string, signal: AbortSignal) {
  if (!/^[a-f0-9]{40,64}$/.test(headSha)) throw new Error('Invalid Output commit');
  const tree = (
    await git(path, ['ls-tree', '-r', '-z', headSha, '--', '.helix/output'], signal, 512 * 1024)
  ).toString('utf8');
  const entries = tree.split('\0').filter(Boolean);
  if (entries.length > 500) throw new Error('Output exceeds 500 files');
  const files = new Map<string, Buffer>();
  const hash = createHash('sha256');
  let total = 0;
  for (const entry of entries) {
    const match =
      /^(100644|100755) blob ([a-f0-9]{40,64})\t\.helix\/output\/([A-Za-z0-9_./-]+)$/.exec(entry);
    if (!match) throw new Error('Output contains an unsupported path, symlink or submodule');
    const name = match[3]!;
    if (
      name.split('/').some((part) => !part || part.startsWith('.')) ||
      !mime[name.split('.').at(-1)!]
    )
      throw new Error('Output contains an unsupported file');
    const content = await git(path, ['cat-file', 'blob', match[2]!], signal);
    total += content.length;
    if (total > LIMIT) throw new Error('Output exceeds 32 MiB');
    files.set(name, content);
    hash.update(name).update('\0').update(String(content.length)).update('\0').update(content);
  }
  if (!files.has('index.html'))
    throw new Error(
      'No committed .helix/output/index.html yet. Ask the worker for a self-contained static export.',
    );
  return { files, artifactHash: hash.digest('hex') };
}

export function createOutputHost(): OutputHost {
  const owned = new Map<SessionId, { server: Server; artifactHash: string; url: string }>();
  let pending = 0;
  return {
    lease: (id) => {
      const item = owned.get(id);
      return item ? { artifactHash: item.artifactHash, url: item.url } : undefined;
    },
    async stop(id) {
      const item = owned.get(id);
      if (!item) return;
      owned.delete(id);
      item.server.closeAllConnections();
      await new Promise<void>((resolve) => item.server.close(() => resolve()));
    },
    async start(input) {
      if (owned.size + pending >= 3 || owned.has(input.workerSessionId))
        throw new Error('Output limit reached or worker already has a preview (maximum 3).');
      pending++;
      try {
        const { files, artifactHash } = await readOutputArtifact(
          input.path,
          input.headSha,
          input.signal,
        );
        input.signal.throwIfAborted();
        const token = randomBytes(24).toString('hex');
        const prefix = `/${token}/`;
        const launchTickets = new Set<string>();
        const capabilities = new Set<string>();
        const server = createServer((req, res) => {
          const address = server.address();
          const port = address && typeof address === 'object' ? address.port : 0;
          res.setHeader('Content-Security-Policy', outputCsp);
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('X-DNS-Prefetch-Control', 'off');
          res.setHeader('Referrer-Policy', 'no-referrer');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader(
            'Permissions-Policy',
            'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          );
          if (req.headers.host !== `127.0.0.1:${port}` || !req.url?.startsWith(prefix)) {
            res.writeHead(403).end();
            return;
          }
          const raw = req.url.slice(prefix.length).split('?')[0]!;
          if (raw === 'enable' && req.method === 'POST' && req.headers.origin === 'null') {
            let body = '';
            req.on('data', (chunk: Buffer) => {
              body += chunk.toString();
              if (body.length > 100) req.destroy();
            });
            req.on('end', () => {
              if (launchTickets.delete(body)) {
                if (capabilities.size >= 16)
                  capabilities.delete(capabilities.values().next().value!);
                const capability = randomBytes(24).toString('hex');
                capabilities.add(capability);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ capability }));
              } else res.writeHead(403).end();
            });
            return;
          }
          if (!['GET', 'HEAD'].includes(req.method ?? '')) {
            res.writeHead(403).end();
            return;
          }
          // Trusted outer document confines ALL inner-frame navigations, not only fetch().
          if (!raw) {
            if (launchTickets.size >= 16)
              launchTickets.delete(launchTickets.values().next().value!);
            const nonce = randomBytes(24).toString('hex');
            launchTickets.add(nonce);
            const appRoot = 'http://127.0.0.1:' + port + prefix + 'app/';
            res.setHeader(
              'Content-Security-Policy',
              "default-src 'none'; script-src 'nonce-" +
                nonce +
                "'; style-src 'unsafe-inline'; connect-src " +
                'http://127.0.0.1:' +
                port +
                '; frame-src ' +
                appRoot +
                "; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-forms",
            );
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(req.method === 'HEAD' ? undefined : outputWrapper(appRoot, nonce));
            return;
          }
          if (!raw.startsWith('app/') || !capabilities.has(raw.split('/')[1] ?? '')) {
            res.writeHead(404).end();
            return;
          }
          const name = raw.split('/').slice(2).join('/') || 'index.html';
          if (
            !/^[A-Za-z0-9_./-]+$/.test(name) ||
            name.split('/').some((s) => !s || s.startsWith('.'))
          ) {
            res.writeHead(404).end();
            return;
          }
          const content = files.get(name);
          if (!content) {
            res.writeHead(404).end();
            return;
          }
          res.setHeader('Content-Type', mime[name.split('.').at(-1)!]!);
          res.setHeader('Content-Length', content.length);
          res.end(req.method === 'HEAD' ? undefined : content);
        });
        server.maxConnections = 16;
        server.requestTimeout = 5000;
        server.headersTimeout = 5000;
        server.keepAliveTimeout = 1000;
        try {
          // Port 0 reserves a free OS-selected loopback port atomically; never steal a port.
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
          });
          input.signal.throwIfAborted();
          const address = server.address();
          if (!address || typeof address === 'string')
            throw new Error('Output listener unavailable');
          const url = `http://127.0.0.1:${address.port}${prefix}`;
          owned.set(input.workerSessionId, { server, artifactHash, url });
          return { artifactHash, url };
        } catch (error) {
          server.closeAllConnections();
          server.close();
          throw error;
        }
      } finally {
        pending--;
      }
    },
  };
}

/** Trusted wrapper owns navigation and readiness; no privileged bridge to the application.
 * Standard browser isolation does not claim complete network confinement. */
function outputWrapper(appRoot: string, nonce: string): string {
  return `<!doctype html><html><head><title>Helix Output</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}p{padding:24px;font:16px system-ui;color:#444}</style></head><body><p id="status">Loading application.</p><script nonce="${nonce}">
  const status = document.getElementById('status');
  let frame; let finished = false;
  const fail = () => {
    if(finished) return;
    finished = true; clearTimeout(timer); if(frame) frame.remove();
    status.textContent = 'Application could not be loaded. Check the preview connection and retry.';
    parent.postMessage({type:'helix-output-unavailable',load:location.hash}, '*');
  };
  const timer = setTimeout(fail, 10000);
  (async () => {
    try {
      const response = await fetch('${appRoot.slice(0, -4)}enable', {method:'POST', body:'${nonce}', credentials:'omit'});
      if(!response.ok) throw Error('Preview lease unavailable');
      const {capability} = await response.json();
      if(finished) return;
      frame = document.createElement('iframe'); frame.title = 'Generated application'; frame.setAttribute('sandbox','allow-scripts allow-forms'); frame.referrerPolicy='no-referrer'; frame.src='${appRoot}' + capability + '/index.html';
      frame.onload = () => {
        if(finished) return;
        finished = true; clearTimeout(timer); status.remove();
        parent.postMessage({type:'helix-output-ready',load:location.hash}, '*');
      };
      frame.onerror = fail;
      document.body.appendChild(frame);
    } catch { fail(); }
  })();
  </script></body></html>`;
}
