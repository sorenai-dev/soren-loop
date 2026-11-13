// Item 3 (`08` §1.6.3): the private-repo "send write tokens / secrets to fork PR workflows" settings.
// Can they be read via the API, by whom, and does the API reflect them when they are switched on?
import { PR_APP_FULL } from '../lib/config.ts';
import { expectStatus, expectValue, type Context } from '../lib/context.ts';
import { withSetting } from '../lib/fixtures.ts';
import { api, mint, owner } from '../lib/github.ts';

const KEYS = ['run_workflows_from_fork_pull_requests', 'send_write_tokens_to_workflows', 'send_secrets_and_variables', 'require_approval_for_fork_pr_workflows'] as const;

const shape = (body: unknown) => Object.fromEntries(KEYS.map((k) => [k, (body as Record<string, unknown> | null)?.[k]]));

export async function run(ctx: Context): Promise<void> {
  const { upstreamPrivate: up, upstreamPublic: pub, org } = ctx.cfg;
  const repoPath = `/repos/${up}/actions/permissions/fork-pr-workflows-private-repos`;
  const orgPath = `/orgs/${org}/actions/permissions/fork-pr-workflows-private-repos`;

  const repo = owner('GET', repoPath);
  expectStatus(ctx, 3, 'owner reads repo fork-PR workflow settings', repo, [200]);
  expectValue(ctx, 3, 'repo default: write tokens and secrets off', shape(repo.body), [
    { ...shape(repo.body), send_write_tokens_to_workflows: false, send_secrets_and_variables: false },
  ], repo.body);
  expectStatus(ctx, 3, 'owner reads org fork-PR workflow settings', owner('GET', orgPath), [200]);
  expectStatus(ctx, 3, 'the endpoint refuses public repos (not applicable)', owner('GET', `/repos/${pub}/actions/permissions/fork-pr-workflows-private-repos`), [422]);

  // Can `doctor` / the start-up check read it with the PR App rather than the owner's credential?
  const pr = await mint(ctx.cfg, 'pr', up, PR_APP_FULL);
  if (pr.token) {
    expectStatus(ctx, 3, 'PR App token reads repo fork-PR workflow settings', await api(pr.token, 'GET', repoPath), [403, 404]);
  }

  // Switch everything on (repo first, then org + repo) and confirm the API reports it, so a check can detect it.
  const on = { run_workflows_from_fork_pull_requests: true, send_write_tokens_to_workflows: true, send_secrets_and_variables: true, require_approval_for_fork_pr_workflows: true };
  const repoOnly = owner('PUT', repoPath, on);
  expectStatus(ctx, 3, 'repo-level enable while the org disallows it', repoOnly, [409, 422]);
  if (repoOnly.status >= 200 && repoOnly.status < 300) {
    owner('PUT', repoPath, shape(repo.body));
  }

  const orgOn = withSetting(ctx, orgPath, 'PUT', on);
  expectStatus(ctx, 3, 'org-level enable (temporary, reverted)', orgOn, [204]);
  const repoOn = withSetting(ctx, repoPath, 'PUT', on);
  expectStatus(ctx, 3, 'repo-level enable once the org allows (temporary, reverted)', repoOn, [204]);
  expectValue(ctx, 3, 'API reflects the enabled state (detectable)', shape(owner('GET', repoPath).body), [on]);
}
