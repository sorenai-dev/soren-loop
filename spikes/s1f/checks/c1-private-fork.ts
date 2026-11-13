// Item 1 (`08` §1.6.1): private upstream + private fork in the bot org. Can the fork exist, who can
// create it, and can the PR App name it as head without any access to it?
import { PR_APP_FULL, PUSH_APP_FULL } from '../lib/config.ts';
import { expectStatus, expectValue, type Context } from '../lib/context.ts';
import { openPr, pushForkBranch } from '../lib/fixtures.ts';
import { api, mint, owner } from '../lib/github.ts';

export async function run(ctx: Context): Promise<void> {
  const { upstreamPrivate: up, forkPrivate: fork, botOrg } = ctx.cfg;

  const forkRepo = owner('GET', `/repos/${fork}`);
  const b = forkRepo.body as { visibility?: string; fork?: boolean; parent?: { full_name?: string } } | null;
  expectValue(ctx, 1, 'private fork exists in bot org (owner view)', { visibility: b?.visibility, fork: b?.fork, parent: b?.parent?.full_name }, [
    { visibility: 'private', fork: true, parent: up },
  ]);

  const push = await mint(ctx.cfg, 'push', fork, PUSH_APP_FULL);
  expectStatus(ctx, 1, 'push App mints {contents:write} on the private fork', push.evidence, [201]);

  // The push App has no installation on upstream, so it should not be able to create a fork itself.
  if (push.token) {
    const forkCreate = await api(push.token, 'POST', `/repos/${up}/forks`, {
      organization: botOrg,
      name: `sl-s1f-probe-${ctx.runId}`,
      default_branch_only: true,
    });
    expectStatus(ctx, 1, 'push App token cannot create a fork of the private upstream', forkCreate, [403, 404]);
  }

  const branch = `s1f-item1-${ctx.runId}`;
  expectStatus(ctx, 1, 'push App writes a branch commit on the private fork', await pushForkBranch(ctx, fork, branch), [201]);

  const pr = await mint(ctx.cfg, 'pr', up, PR_APP_FULL);
  expectStatus(ctx, 1, 'PR App mints its full set on the private upstream', pr.evidence, [201]);
  if (!pr.token) return;

  expectStatus(ctx, 1, 'PR App token cannot read the private fork', await api(pr.token, 'GET', `/repos/${fork}`), [404]);

  // Finding P1 (S1-F write-up): refused with 422 "not all refs are readable". The upstream
  // installation token cannot be given read access to a repo owned by the bot org.
  const opened = await openPr(ctx, up, branch);
  expectStatus(ctx, 1, 'PR App cannot open a PR naming the private fork as head (P1)', opened, [422]);
  const body = opened.body as { number?: number; maintainer_can_modify?: boolean; head?: { repo?: { full_name?: string } | null } };
  if (opened.status === 201 && body.number) {
    ctx.prs.set(up, body.number);
    expectValue(ctx, 1, 'PR head repo is the bot fork; maintainer_can_modify false (F4)', {
      head: body.head?.repo?.full_name ?? null,
      maintainer_can_modify: body.maintainer_can_modify,
    }, [{ head: fork, maintainer_can_modify: false }]);
    return;
  }

  // Controls that locate the refusal: the push App (reads the fork, no upstream install) and the
  // owner (reads both). If only the owner succeeds, the cause is the token's read access to the head.
  if (push.token) {
    const viaPush = await api(push.token, 'POST', `/repos/${up}/pulls`, { title: 's1f push-App route', head: `${botOrg}:${branch}`, base: 'main', maintainer_can_modify: false });
    expectStatus(ctx, 1, 'control: push App token opens the PR upstream', viaPush, [403, 404, 422]);
  }
  expectStatus(ctx, 1, 'control: owner opens the PR from the private fork', await openPr(ctx, up, branch, 'owner'), [201]);
}
