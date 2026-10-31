// Shared helpers for spike S1: App JWT, installation-token minting, REST calls, redacted evidence.
import { SignJWT } from 'jose';
import { createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HERE = import.meta.dirname;
const RESULTS = join(HERE, 'results');
const SECRETS = join(homedir(), '.feature-loop-spikes', 's1');
export const UPSTREAM = 'mandelbro/feature-loop-s1-upstream';
export const FORK = 'sorenai-dev/feature-loop-s1-upstream';

const app = JSON.parse(readFileSync(join(SECRETS, 'app.json'), 'utf8'));
// GitHub issues PKCS#1 PEMs; jose accepts a Node KeyObject directly.
const key = createPrivateKey(readFileSync(join(SECRETS, 'app.pem'), 'utf8'));
const secrets = new Set();

export async function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .setIssuer(String(app.id))
    .sign(key);
}

function redact(value) {
  let text = JSON.stringify(value, (k, v) => (k === 'token' ? '[redacted]' : v));
  for (const s of secrets) text = text.split(s).join('[redacted]');
  return JSON.parse(text);
}

export async function api(auth, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${auth}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

export async function installationId(repo) {
  const r = await api(await appJwt(), 'GET', `/repos/${repo}/installation`);
  if (r.status !== 200) throw new Error(`App is not installed on ${repo}: HTTP ${r.status}`);
  return r.body.id;
}

// Mints a down-scoped installation token. Returns the token separately so it never lands in evidence.
export async function mint(repo, permissions) {
  const id = await installationId(repo);
  const r = await api(await appJwt(), 'POST', `/app/installations/${id}/access_tokens`, {
    repositories: [repo.split('/')[1]],
    permissions,
  });
  if (r.body?.token) secrets.add(r.body.token);
  return { token: r.body?.token, evidence: summarize(r, ['permissions', 'repository_selection', 'expires_at']) };
}

export function summarize(r, keep = ['message', 'errors', 'documentation_url']) {
  const body = r.body && typeof r.body === 'object' && !Array.isArray(r.body)
    ? Object.fromEntries(keep.filter((k) => k in r.body).map((k) => [k, r.body[k]]))
    : r.body;
  return redact({ status: r.status, body });
}

export function trackSecret(s) { secrets.add(s); }
export const scrub = (text) => redact(text);

export function record(name, evidence) {
  mkdirSync(RESULTS, { recursive: true });
  const clean = redact(evidence);
  writeFileSync(join(RESULTS, `${name}.json`), JSON.stringify(clean, null, 2) + '\n');
  console.log(`\n== ${name}\n${JSON.stringify(clean, null, 2)}`);
  return clean;
}
