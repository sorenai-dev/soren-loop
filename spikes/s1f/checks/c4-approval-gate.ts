// Item 4 (`08` §1.6.4, F1): does "require approval for all external contributors" hold App-authored
// fork PRs? Public repos use `approval_policy`; private repos use `require_approval_for_fork_pr_workflows`.
// Finding P3: it does not. Under the strictest public policy the App's fork PR run starts at once.
import { expectStatus, expectValue, note, type Context } from '../lib/context.ts';
import { ensureWorkflow, openPr, pushForkBranch, waitForRun, withSetting } from '../lib/fixtures.ts';

interface Run {
  status?: string;
  actor?: { login?: string };
  triggering_actor?: { login?: string };
}

export async function run(ctx: Context): Promise<void> {
  const { upstreamPublic: pub, forkPublic, upstreamPrivate: priv, forkPrivate } = ctx.cfg;

  ensureWorkflow(ctx, pub);
  const policy = withSetting(ctx, `/repos/${pub}/actions/permissions/fork-pr-contributor-approval`, 'PUT', {
    approval_policy: 'all_external_contributors',
  });
  expectStatus(ctx, 4, 'public: set approval_policy=all_external_contributors (reverted)', policy, [204]);

  const branch = `s1f-item4-public-${ctx.runId}`;
  expectStatus(ctx, 4, 'public: push App writes fork branch', await pushForkBranch(ctx, forkPublic, branch), [201]);
  const pr = await openPr(ctx, pub, branch);
  expectStatus(ctx, 4, 'public: PR App opens fork PR', pr, [201]);
  const sha = (pr.body as { head?: { sha?: string } } | null)?.head?.sha;
  if (sha) {
    const runs = await waitForRun(pub, sha);
    note(ctx, 4, 'public: runs for head', runs.body);
    const first = ((runs.body as { workflow_runs?: Run[] } | null)?.workflow_runs ?? [])[0];
    const seen = first ? { status: first.status, actor: first.actor?.login, triggering_actor: first.triggering_actor?.login } : { status: 'no-run' };
    expectValue(ctx, 4, 'public: App fork PR run starts WITHOUT approval (P3, F1)', seen.status, ['queued', 'in_progress', 'completed'], seen);
  }

  // Private: the App cannot author a private-fork PR at all (P1), so the private approval flag never
  // gets an App-authored PR to gate. Recorded so the dependency on P1 is explicit.
  const privBranch = `s1f-item4-private-${ctx.runId}`;
  expectStatus(ctx, 4, 'private: push App writes fork branch', await pushForkBranch(ctx, forkPrivate, privBranch), [201]);
  expectStatus(ctx, 4, 'private: PR App fork PR refused, so approval gating is moot (P1)', await openPr(ctx, priv, privBranch), [422]);
}
