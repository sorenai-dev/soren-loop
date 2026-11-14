// Stand-in for the server's internal flagd sync endpoint (RFC `16` §2). Renders one flagd document
// from an in-memory flag table, requires a bearer credential, honours ETag, and logs every poll
// (whether credentials were present and correct, never their value).
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export interface FlagRow {
  targets: string[];
  all?: boolean;
}

export interface Poll {
  t: number;
  authorization: 'missing' | 'correct' | 'wrong';
  ifNoneMatch: boolean;
  status: number;
}

// The document shape from RFC `16` §2.
export function render(flags: Record<string, FlagRow>): string {
  const out: Record<string, unknown> = {};
  for (const [key, row] of Object.entries(flags)) {
    out[key] = {
      state: 'ENABLED',
      variants: { on: true, off: false },
      defaultVariant: row.all ? 'on' : 'off',
      targeting: { if: [{ in: [{ var: 'targetingKey' }, row.targets] }, 'on', 'off'] },
    };
  }
  return JSON.stringify({ $schema: 'https://flagd.dev/schema/v0/flags.json', flags: out });
}

export class SyncStub {
  readonly polls: Poll[] = [];
  private flags: Record<string, FlagRow>;
  private server: Server | null = null;
  // When set, the stub accepts any request (ST-19 counter-case: an unauthenticated endpoint).
  requireAuth = true;

  private token: string;

  constructor(token: string, initial: Record<string, FlagRow>) {
    this.token = token;
    this.flags = structuredClone(initial);
  }

  // Simulates rotating the sync credential on the server while flagd still holds the old one.
  rotate(token: string): void {
    this.token = token;
  }

  set(key: string, row: FlagRow): number {
    this.flags[key] = row;
    return performance.now();
  }

  listen(port: number): Promise<void> {
    this.server = createServer((req, res) => {
      const auth = req.headers.authorization;
      const authorization = !auth ? 'missing' : auth === `Bearer ${this.token}` ? 'correct' : 'wrong';
      const body = render(this.flags);
      const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
      let status = 200;
      if (req.url !== '/flags.json') status = 404;
      else if (this.requireAuth && authorization !== 'correct') status = 401;
      else if (req.headers['if-none-match'] === etag) status = 304;
      this.polls.push({ t: performance.now(), authorization, ifNoneMatch: Boolean(req.headers['if-none-match']), status });
      res.writeHead(status, status === 200 ? { 'Content-Type': 'application/json', ETag: etag } : { ETag: etag });
      res.end(status === 200 ? body : undefined);
    });
    return new Promise((resolve) => this.server?.listen(port, '127.0.0.1', resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
