// Item 2 (`08` §1.6.2): the org setting "allow forking of private repositories" switched off.
// Records the failure mode for new forks, for the existing bot fork, and for opening PRs from it.
// Changes an org-wide setting, so it only runs with --allow-org-toggle and always reverts.
import { PR_APP_FULL, PUSH_APP_FULL } from '../lib/config.ts';
import { defer, expectStatus, note, type Context } from '../lib/context.ts';
import { openPr, pushForkBranch } from '../lib/fixtures.ts';
import { mint, owner, pick } from '../lib/github.ts';

const KEY = 'members_can_fork_private_repositories';

export async function run(ctx: Context): Promise<void> {
  if (!ctx.cfg.allowOrgToggle) {
    ctx.rows.push({ item: 2, check: 'skipped: pass --allow-org-toggle to run', expected: '-', observed: '-', ok: true });
    return;
  }
  const { org, upstreamPrivate: up, forkPrivate: fork, botOrg } = ctx.cfg;

  // Prepare a fork branch while forking is still allowed.
  const branch = `s1f-item2-${ctx.runId}`;
  expectStatus(ctx, 2, 'before: push App writes fork branch', await pushForkBranch(ctx, fork, branch), [201]);

  const before = owner('GET', `/orgs/${org}`);
  const prev = (before.body as Record<string, unknown>)[KEY];
  note(ctx, 2, 'before: org setting', { [KEY]: prev });
  const off = owner('PATCH', `/orgs/${org}`, { [KEY]: false });
  expectStatus(ctx, 2, 'owner switches private forking off (reverted)', off, [200]);
  defer(ctx, `restore ${org} ${KEY}`, () => {
    owner('PATCH', `/orgs/${org}`, { [KEY]: prev });
    const after = owner('GET', `/repos/${fork}`);
    note(ctx, 2, 'after restore: fork still exists', pick(after, ['full_name', 'visibility', 'message']));
    if (after.status !== 200) throw new Error(`${fork} is gone after the toggle (HTTP ${after.status}); re-create it`);
  });

  note(ctx, 2, 'policy off: org view', pick(owner('GET', `/orgs/${org}`), [KEY]));
  expectStatus(ctx, 2, 'policy off: existing private fork still readable by owner', owner('GET', `/repos/${fork}`), [200]);
  expectStatus(ctx, 2, 'policy off: owner creates a new fork', owner('POST', `/repos/${up}/forks`, {
    organization: botOrg,
    name: `sl-s1f-policy-${ctx.runId}`,
    default_branch_only: true,
  }), [403]);
  expectStatus(ctx, 2, 'policy off: push App mints on the existing fork', (await mint(ctx.cfg, 'push', fork, PUSH_APP_FULL)).evidence, [201]);
  expectStatus(ctx, 2, 'policy off: PR App mints on upstream', (await mint(ctx.cfg, 'pr', up, PR_APP_FULL)).evidence, [201]);
  expectStatus(ctx, 2, 'policy off: PR App opens a PR from the existing fork', await openPr(ctx, up, branch), [422]);
}
