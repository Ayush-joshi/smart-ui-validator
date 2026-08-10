import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GeneratedHtmlBundle } from './generation-contracts.js';
import type { GeneratedPreviewProvider, GeneratedPreviewSession } from './generation-providers.js';
import { SmartUiError } from './errors.js';

const CSP = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export class LoopbackGeneratedPreviewProvider implements GeneratedPreviewProvider {
  async serve(bundle: GeneratedHtmlBundle, signal?: AbortSignal): Promise<GeneratedPreviewSession> {
    if (signal?.aborted) throw new SmartUiError('PROVIDER_FAILURE', 'Preview was canceled.');
    const files = new Map(bundle.files.map((file) => [`/${file.relativePath}`, file]));
    const server = createServer((request, response) => {
      response.setHeader('Content-Security-Policy', CSP);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        respond(response, 405, 'Method not allowed');
        return;
      }
      let pathname: string;
      try {
        const parsed = new URL(request.url ?? '/', 'http://127.0.0.1');
        pathname = decodeURIComponent(parsed.pathname);
        if (parsed.search || parsed.hash) throw new Error('query');
      } catch {
        respond(response, 400, 'Invalid URL');
        return;
      }
      if (pathname === '/') pathname = '/index.html';
      if (
        pathname.includes('\\') ||
        pathname.includes('\0') ||
        pathname.split('/').some((segment) => segment === '.' || segment === '..')
      ) {
        respond(response, 403, 'Forbidden');
        return;
      }
      const file = files.get(pathname);
      if (!file) {
        respond(response, 404, 'Not found');
        return;
      }
      response.statusCode = 200;
      response.setHeader('Content-Type', file.mediaType);
      response.setHeader('Content-Length', String(file.bytes.byteLength));
      if (request.method === 'HEAD') response.end();
      else response.end(Buffer.from(file.bytes));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', onAbort);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    };
    const onAbort = () => void close();
    signal?.addEventListener('abort', onAbort, { once: true });
    return { url: `${origin}/index.html`, origin, close };
  }
}

function respond(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(message);
}
