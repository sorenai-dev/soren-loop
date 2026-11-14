// GitHub access for S1-F: App JWTs (node:crypto RS256), installation tokens, REST calls as an App
// token or as the owner (via `gh`, so the owner credential never enters this process), and git.
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { AppName, Config } from './config.ts';

export interface Res {
  status: number;
  body: unknown;
}

const secrets = new Set<string>();
const keys = new Map<AppName, KeyObject>();

export function redact<T>(value: T): T {
  let text = JSON.stringify(value, (k, v: unknown) => (k === 'token' ? '[redacted]' : v));
  for (const s of secrets) text = text.split(s).join('[redacted]');
  return JSON.parse(text) as T;
}

function loadKey(cfg: Config, app: AppName): KeyObject {
  const cached = keys.get(app);
  if (cached) return cached;
  const { keyPath } = cfg.apps[app];
  const mode = statSync(keyPath).mode & 0o777;
  if (mode & 0o077) throw new Error(`${keyPath} is mode ${mode.toString(8)}; expected 0600 or 0400`);
  const key = createPrivateKey(readFileSync(keyPath, 'utf8'));
  keys.set(app, key);
  return key;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export function appJwt(cfg: Config, app: AppName): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(cfg.apps[app].id) }));
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), loadKey(cfg, app));
  return `${header}.${payload}.${b64url(signature)}`;
}

export async function api(auth: string, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${auth}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body: keep the text */
  }
  return { status: res.status, body: parsed };
}

// Owner-authenticated call through `gh api`. `-i` gives us the real status line.
export function owner(method: string, path: string, body?: unknown): Res {
  const args = ['api', '-i', '-X', method, path.replace(/^\//, '')];
  if (body !== undefined) args.push('--input', '-');
  const r = spawnSync('gh', args, {
    encoding: 'utf8',
    ...(body === undefined ? {} : { input: JSON.stringify(body) }),
  });
  const [head = '', ...rest] = r.stdout.split(/\r?\n\r?\n/);
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(head)?.[1] ?? 0);
  const text = rest.join('\n\n').trim();
  let parsed: unknown = text || null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status, body: parsed };
}

export async function installationId(cfg: Config, app: AppName, repo: string): Promise<number> {
  const r = await api(appJwt(cfg, app), 'GET', `/repos/${repo}/installation`);
  if (r.status !== 200) throw new Error(`${cfg.apps[app].slug} is not installed on ${repo}: HTTP ${r.status}`);
  return (r.body as { id: number }).id;
}

export interface Minted {
  token: string | undefined;
  evidence: Res;
}

// Mints a token down-scoped to one repo. The token never appears in evidence.
export async function mint(cfg: Config, app: AppName, repo: string, permissions: object): Promise<Minted> {
  const id = await installationId(cfg, app, repo);
  const r = await api(appJwt(cfg, app), 'POST', `/app/installations/${id}/access_tokens`, {
    repositories: [repo.split('/')[1]],
    permissions,
  });
  const token = (r.body as { token?: string } | null)?.token;
  if (token) {
    secrets.add(token);
    secrets.add(Buffer.from(`x-access-token:${token}`).toString('base64'));
  }
  return { token, evidence: pick(r, ['permissions', 'repository_selection', 'message']) };
}

export function pick(r: Res, keep = ['message', 'errors']): Res {
  const b = r.body;
  const body =
    b && typeof b === 'object' && !Array.isArray(b)
      ? Object.fromEntries(keep.filter((k) => k in b).map((k) => [k, (b as Record<string, unknown>)[k]]))
      : b;
  return redact({ status: r.status, body });
}

export interface GitResult {
  code: number | null;
  stderr: string;
}

export function git(cwd: string, args: string[], token?: string): GitResult {
  const auth = token
    ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]
    : [];
  const r = spawnSync('git', [...auth, ...args], { cwd, encoding: 'utf8' });
  return redact({ code: r.status, stderr: (r.stderr ?? '').trim() });
}
