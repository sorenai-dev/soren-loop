// Prototype of `createOfrepHandler` (RFC `16` §5, SR-36 as amended) so S4 can test the stock web
// provider against the allowlist-filtered bulk branch. Spike code, not the shipped handler (Task 082).
//
// - Strips any browser-sent evaluation context and injects `targetingKey` from the host session.
// - Single-flag: forwards allowlisted keys only; anything else is 404.
// - Bulk: forwards to flagd, keeps only allowlisted keys, drops every `metadata` field.
// - `eventStreams` (flagd advertises SSE) is dropped unless `sse: 'proxy'`, in which case the SSE
//   route is relayed. S4 measures both, because the web provider prefers SSE when advertised.

export interface SorenLoopUser {
  sub: string;
}

export interface HandlerOptions {
  flagdUrl: string;
  allowlist: string[];
  getUser: (req: Request) => SorenLoopUser | null;
  sse?: 'drop' | 'proxy';
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const BULK = '/ofrep/v1/evaluate/flags';
const SSE = '/ofrep/v1/sse';

function strip(flag: Record<string, unknown>): Record<string, unknown> {
  const { metadata: _drop, ...rest } = flag;
  return rest;
}

export function createOfrepHandler(opts: HandlerOptions): (req: Request) => Promise<Response> {
  const allow = new Set(opts.allowlist);
  return async (req) => {
    const user = opts.getUser(req);
    if (!user) return json(401, { errorCode: 'GENERAL', errorDetails: 'no session' });
    const path = new URL(req.url).pathname;
    // The browser's own context is discarded unread: only the session decides targetingKey.
    const body = JSON.stringify({ context: { targetingKey: user.sub } });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (req.method === 'GET' && path === SSE && opts.sse === 'proxy') {
      const upstream = await fetch(`${opts.flagdUrl}${SSE}`, { headers: { Accept: 'text/event-stream' } });
      return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
    }

    if (req.method === 'POST' && path.startsWith(`${BULK}/`)) {
      const key = decodeURIComponent(path.slice(BULK.length + 1));
      if (!allow.has(key)) return json(404, { key, errorCode: 'FLAG_NOT_FOUND' });
      const r = await fetch(`${opts.flagdUrl}${BULK}/${encodeURIComponent(key)}`, { method: 'POST', headers, body });
      return json(r.status, strip((await r.json()) as Record<string, unknown>));
    }

    if (req.method === 'POST' && path === BULK) {
      const inm = req.headers.get('if-none-match');
      const r = await fetch(`${opts.flagdUrl}${BULK}`, { method: 'POST', headers: inm ? { ...headers, 'If-None-Match': inm } : headers, body });
      const etag = r.headers.get('etag');
      const extra: Record<string, string> = etag ? { ETag: etag } : {};
      if (r.status === 304) return new Response(null, { status: 304, headers: extra });
      const upstream = (await r.json()) as { flags?: Array<Record<string, unknown>>; eventStreams?: unknown };
      const flags = (upstream.flags ?? []).filter((f) => allow.has(String(f.key))).map(strip);
      const out: Record<string, unknown> = { flags };
      if (opts.sse === 'proxy' && upstream.eventStreams) out.eventStreams = upstream.eventStreams;
      return json(r.status, out, extra);
    }

    return json(404, { errorCode: 'FLAG_NOT_FOUND' });
  };
}
