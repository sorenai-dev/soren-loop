// A minimal "host app" for S4: serves the test page and mounts the OFREP handler at /ofrep/*,
// as a host backend would. The session is a cookie `s4user=<sub>` set by the test.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { createOfrepHandler, type HandlerOptions } from './ofrep-handler.ts';

const PAGE = join(import.meta.dirname, '..', 'page');

export interface Hit {
  method: string;
  path: string;
  status: number;
}

function toRequest(req: IncomingMessage, body: Buffer, port: number): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const init: RequestInit = { method: req.method ?? 'GET', headers };
  if (req.method === 'POST') init.body = new Uint8Array(body);
  return new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, init);
}

export function sessionFromCookie(req: Request): { sub: string } | null {
  const m = /(?:^|;\s*)s4user=([^;]+)/.exec(req.headers.get('cookie') ?? '');
  return m?.[1] ? { sub: decodeURIComponent(m[1]) } : null;
}

export class Host {
  readonly hits: Hit[] = [];
  private server: Server | null = null;
  private readonly handler: (req: Request) => Promise<Response>;
  private readonly port: number;

  constructor(port: number, opts: Omit<HandlerOptions, 'getUser'>) {
    this.port = port;
    this.handler = createOfrepHandler({ ...opts, getUser: sessionFromCookie });
  }

  listen(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        if (path === '/' || path === '/app.js') {
          const file = path === '/' ? 'index.html' : join('dist', 'app.js');
          res.writeHead(200, { 'Content-Type': path === '/' ? 'text/html' : 'text/javascript' });
          res.end(readFileSync(join(PAGE, file)));
          return;
        }
        const r = await this.handler(toRequest(req, Buffer.concat(chunks), this.port));
        this.hits.push({ method: req.method ?? '', path, status: r.status });
        res.writeHead(r.status, Object.fromEntries(r.headers));
        if (r.body) {
          for await (const chunk of r.body) res.write(chunk);
        }
        res.end();
      });
    });
    return new Promise((resolve) => this.server?.listen(this.port, '127.0.0.1', resolve));
  }

  close(): Promise<void> {
    this.server?.closeAllConnections();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
