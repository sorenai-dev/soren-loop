// Item 6 (`08` §1.6.5): with a ruleset requiring one approving review on upstream main, none of the
// PR App's other `pull_requests: write` capabilities (update-branch, self-approve, close/reopen)
// bypasses the review requirement.
import { PR_APP_FULL } from '../lib/config.ts';
import { defer, expectStatus, expectValue, type Context } from '../lib/context.ts';
import { sharedPr } from '../lib/fixtures.ts';
import { api, mint, owner } from '../lib/github.ts';

function addRuleset(ctx: Context, upstream: string): void {
  const res = owner('POST', `/repos/${upstream}/rulesets`, {
    name: `s1f-require-review-${ctx.runId}`,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: true,
          required_review_thread_resolution: false,
        },
      },
    ],
  });
  expectStatus(ctx, 6, 'owner adds a require-1-review ruleset (reverted)', res, [201]);
  const id = (res.body as { id?: number } | null)?.id;
  if (id) defer(ctx, `delete ruleset ${id}`, () => void owner('DELETE', `/repos/${upstream}/rulesets/${id}`));
}

interface Decision {
  reviewDecision?: string;
  mergeStateStatus?: string;
  state?: string;
}

// mergeStateStatus is computed asynchronously and reads UNKNOWN right after a reopen, so poll.
async function reviewDecision(upstream: string, n: number): Promise<Decision | null> {
  const [o, r] = upstream.split('/');
  const q = `query { repository(owner: "${o}", name: "${r}") { pullRequest(number: ${n}) { reviewDecision mergeStateStatus state } } }`;
  let pr: Decision | null = null;
  for (let i = 0; i < 10; i++) {
    const res = owner('POST', '/graphql', { query: q });
    pr = (res.body as { data?: { repository?: { pullRequest?: Decision } } } | null)?.data?.repository?.pullRequest ?? null;
    if (pr?.mergeStateStatus && pr.mergeStateStatus !== 'UNKNOWN') return pr;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return pr;
}

export async function run(ctx: Context): Promise<void> {
  // Public upstream: self-approval needs an App-authored PR, which item 1 shows is impossible from a
  // private fork. The review rules under test are the same for both visibilities.
  const up = ctx.cfg.upstreamPublic;
  addRuleset(ctx, up);
  const n = await sharedPr(ctx, 'public');
  const t = await mint(ctx.cfg, 'pr', up, PR_APP_FULL);
  if (!t.token) throw new Error('PR App mint failed');
  const tok = t.token;
  const pr = `/repos/${up}/pulls/${n}`;

  expectStatus(ctx, 6, 'PUT update-branch (writes to the fork head)', await api(tok, 'PUT', `${pr}/update-branch`, {}), [403, 422]);
  expectStatus(ctx, 6, 'App approves its own PR', await api(tok, 'POST', `${pr}/reviews`, { event: 'APPROVE', body: 's1f self-approve probe' }), [422]);
  expectStatus(ctx, 6, 'App closes its PR', await api(tok, 'PATCH', pr, { state: 'closed' }), [200]);
  expectStatus(ctx, 6, 'App reopens its PR', await api(tok, 'PATCH', pr, { state: 'open' }), [200]);

  // The observable that matters: GitHub still says review is required, and the App still can't merge.
  const decision = await reviewDecision(up, n);
  expectValue(ctx, 6, 'reviewDecision after all of the above', decision?.reviewDecision, ['REVIEW_REQUIRED'], decision);
  expectValue(ctx, 6, 'mergeStateStatus after all of the above', decision?.mergeStateStatus, ['BLOCKED'], decision);
  expectStatus(ctx, 6, 'merge after the above still denied', await api(tok, 'PUT', `${pr}/merge`, { merge_method: 'merge' }), [403], { denialGuard: true });
}
