// Registers the S1 spike GitHub App via the App Manifest flow.
// Docs: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
// Serves an auto-submitting manifest form on localhost, receives ?code=, exchanges it via
// POST /app-manifests/{code}/conversions, and writes the private key to ~/.feature-loop-spikes/s1/app.pem (0600).
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PORT = 3399;
// Kept outside iCloud Drive so the private key never syncs.
const SECRETS = join(homedir(), '.feature-loop-spikes', 's1');
mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
chmodSync(SECRETS, 0o700);
const state = randomBytes(16).toString('hex');
const suffix = randomBytes(2).toString('hex');

if (existsSync(join(SECRETS, 'app.pem'))) {
  console.error(`${SECRETS}/app.pem already exists; refusing to overwrite. Delete it first to re-register.`);
  process.exit(1);
}

const manifest = {
  name: `feature-loop-s1-${suffix}`,
  url: 'https://github.com/mandelbro/feature-loop-s1-upstream',
  description: 'Throwaway App for feature-loop spike S1 (fork-PR least privilege). Safe to delete.',
  // A webhook is not needed; GitHub requires hook_attributes.url if the object is present.
  hook_attributes: { url: 'https://example.invalid/unused', active: false },
  redirect_url: `http://localhost:${PORT}/callback`,
  public: true,
  default_events: [],
  default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
};

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const formPage = `<!doctype html><meta charset="utf-8"><title>S1 App registration</title>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto">
<h1>Register ${manifest.name}</h1>
<p>Permissions: contents write, pull_requests write, metadata read. No workflows. No webhook.</p>
<form action="https://github.com/settings/apps/new?state=${state}" method="post">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
  <button type="submit" style="font-size:1.2rem;padding:.6rem 1.2rem">Create GitHub App on github.com</button>
</form></body>`;

async function convert(code) {
  const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`conversion failed: HTTP ${res.status} ${body.message ?? ''}`);
  return body;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(formPage);
    return;
  }
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  if (url.searchParams.get('state') !== state) {
    res.writeHead(400).end('state mismatch');
    return;
  }
  try {
    const app = await convert(url.searchParams.get('code') ?? '');
    writeFileSync(join(SECRETS, 'app.pem'), app.pem, { mode: 0o600 });
    const info = { id: app.id, slug: app.slug, client_id: app.client_id, html_url: app.html_url, owner: app.owner?.login, permissions: app.permissions };
    writeFileSync(join(SECRETS, 'app.json'), JSON.stringify(info, null, 2), { mode: 0o600 });
    console.log(`Registered App id=${app.id} slug=${app.slug}. Key written to ${SECRETS}/app.pem (0600).`);
    console.log(`Install it: https://github.com/apps/${app.slug}/installations/new`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      `<p>Registered <b>${app.slug}</b>. Next: <a href="https://github.com/apps/${app.slug}/installations/new">install it</a> on the upstream repo (as mandelbro) and on the fork (as sorenai-dev). You can close this tab.</p>`,
    );
    server.close();
  } catch (err) {
    console.error(err.message);
    res.writeHead(500).end('conversion failed; see terminal');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Open http://localhost:${PORT}/ and click "Create GitHub App on github.com".`);
});
