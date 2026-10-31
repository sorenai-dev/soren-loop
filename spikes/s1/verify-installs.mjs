// Verifies each installation of the S1 App and the repositories it can reach.
import { api, appJwt, record } from './lib.mjs';

const jwt = await appJwt();
const app = await api(jwt, 'GET', '/app');
const list = await api(jwt, 'GET', '/app/installations');
const installs = [];
for (const i of list.body ?? []) {
  const t = await api(jwt, 'POST', `/app/installations/${i.id}/access_tokens`, {});
  const repos = await api(t.body.token, 'GET', '/installation/repositories');
  installs.push({ account: i.account.login, repository_selection: i.repository_selection, permissions: i.permissions, repos: repos.body.repositories.map((r) => r.full_name) });
}
record('q0-installations', { app: { slug: app.body.slug, permissions: app.body.permissions, events: app.body.events }, installations: installs });
