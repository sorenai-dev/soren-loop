// Re-captures mint evidence that the first q5/q1q2 run trimmed (422 message, control token scope). No writes.
import { api, appJwt, installationId, mint, record, summarize, UPSTREAM } from './lib.mjs';

const id = await installationId(UPSTREAM);
const over = await api(await appJwt(), 'POST', `/app/installations/${id}/access_tokens`, { repositories: ['feature-loop-s1-upstream'], permissions: { workflows: 'write' } });
const otherRepo = await api(await appJwt(), 'POST', `/app/installations/${id}/access_tokens`, { repositories: ['not-installed-repo'], permissions: { pull_requests: 'write' } });
const control = await mint(UPSTREAM, { pull_requests: 'write', metadata: 'read', contents: 'write' });
const prOnly = await mint(UPSTREAM, { pull_requests: 'write', metadata: 'read' });
record('q5-supplement', {
  mint_permission_app_lacks_workflows: summarize(over),
  mint_repo_outside_installation: summarize(otherRepo),
  control_token_scope_used_for_merge: control.evidence,
  pr_only_token_scope_used_for_q1_q2: prOnly.evidence,
});
