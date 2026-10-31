import type { GetTransport } from './types.js';
import { ReadError } from './errors.js';

/** Optional loopback reader. No redirects, credentials, arbitrary origins or caller headers. */
export function createLoopbackTransport(port = 4317): GetTransport {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
  return async ({ method, path, signal, maxBytes }) => {
    if (
      method !== 'GET' ||
      !/^\/api\/(?:health|projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/(?:intake|events\?since=\d+&limit=\d+)|sessions\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/(?:design|diff\?scope=workspace))$/.test(
        path,
      )
    )
      throw new Error('invalid_route');
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('read_failed');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new ReadError('oversize');
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };
}
