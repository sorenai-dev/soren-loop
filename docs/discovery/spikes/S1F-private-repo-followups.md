# Spike S1-F: Private-Repo Fork Follow-Ups and the ST-48 Merge-Denial Check

Follow-up to `S1-fork-pr-permissions.md`. Answers `rfc/08` §1.6 items 1–5 and runs ST-48 with the PR
App's **full** decision-26 permission set. Date: 2026-11-13. Run against GitHub.com (REST API
`2022-11-28`) in the `sorenai-dev-sandbox` orgs only (decision 35).

## Verdict

**ST-48 PASSES. The two-App fork model does NOT work for private repos as specified.**

- The PR App, holding `pull_requests: write, issues: write, deployments: read, contents: read,
  metadata: read`, gets 403 on every merge and write path and is rejected by `git push`, on both a
  private and a public upstream. No stop-the-line finding. `contents: read` does not grant merge.
- The PR App **cannot open a PR whose head is a private fork in the bot org**: `422 "not all refs are
  readable"` (P1). This was the `08` §1.4 UNVERIFIED assumption, and it is refuted. Changing the org
  fork policy does not change this (P2). For private repos the fork model therefore needs another
  route, which is the owner's decision (see **Decision Needed**).
- No `pull_requests: write` capability bypasses a required review (P6). The fork-PR approval gate
  does not hold App-authored PRs even under the strictest public policy (P3, confirms F1).

| # | `08` §1.6 item | Result | Key status codes |
|---|----------------|--------|------------------|
| 1 | Private upstream + private fork; PR App names it as head | **FAIL for the design**: the fork exists, the push App writes to it, but the PR App's PR is refused | fork write 201 · PR App reads fork 404 · PR App opens PR **422** · owner opens same PR 201 · push App opens PR 404 · push App creates fork 404 |
| 2 | Org "allow forking of private repositories" off | Existing fork survives and stays writable; new forks refused | new fork **403** "The repository exists, but forking is disabled." · push mint on existing fork 201 · PR App PR 422 (as item 1) · fork present after restore 200 |
| 3 | Private-repo "send write tokens / secrets to fork PR workflows" | Detectable via the API, **but only with the owner's credential**; the org policy caps the repo | owner read 200 (repo and org) · PR App read **403** · repo enable while org forbids 422 · public repo 422 (endpoint is private-only) · enabled state reads back 200 |
| 4 | "Require approval for all external contributors" holds App fork PRs? | **No** (public). Private: moot, the App cannot author a private-fork PR | policy set 204 · App PR 201 · run `queued` at once, no approval (one run followed to `completed/success`) · private App PR 422 |
| 5 | ST-48: full PR App set, merge and push upstream | **PASS** on private and public | merge (merge, squash) 403 · `POST /merges` 403 · contents PUT 403 · ref create 403 · `git push` main and new branch rejected (exit 128) · `git clone` with `contents: read` works (exit 0) |
| 6 | `update-branch`, self-approve, close/reopen bypass required review? | **PASS**: none bypass it | ruleset 201 · update-branch **403** · self-approve **422** · close 200 · reopen 200 · afterwards `REVIEW_REQUIRED` / `BLOCKED` · merge 403 |

Raw evidence: `spikes/s1f/results/run-20261113T212143.json` (59 rows, all matching the recorded
baseline; tokens redacted, scanned for `ghs_`, PEM and encoded `x-access-token` material).

## Setup

- Upstreams `sorenai-dev-sandbox/sl-upstream-private` (private) and `sl-upstream-public`; forks of
  both in the bot-only org `sorenai-dev-sandbox-bot` (created by the owner in Task 003-1).
- PR App `sl-sandbox-pr-abad` (ID 5590874), registered on the sandbox org with exactly the SR-08 set,
  installed on both upstreams only. Push App `sl-sandbox-push-abad` (ID 5590892), registered on the
  bot org with `contents: write` + `metadata: read`, installed on both forks only. No webhooks.
- Tokens are minted per call, down-scoped to one repo. App JWTs are signed with `node:crypto`
  (RS256); keys at `~/.soren-loop-sandbox/{pr,push}/app.pem` (0600), outside the repo and iCloud.
- Owner-side setup (settings, rulesets, the probe workflow) goes through `gh` with the owner's login,
  so that credential never enters the harness process. Every change is reverted after its item and
  verified by reading the value back.

## Findings

**P1. The PR App cannot open a PR from a private fork in the bot org.** `POST /pulls` with
`head: sorenai-dev-sandbox-bot:<branch>` returns `422 Validation Failed` / `not all refs are readable`.
The two controls locate the cause. The owner, who can read both repos, opens the identical PR (201).
The push App, which can read the fork but has no upstream installation, gets 404. GitHub requires the
caller to read the head repo. An installation token belongs to one installation, and the PR App's
upstream installation cannot cover a repo owned by the bot org, so no token the design allows can
satisfy both sides. On public repos the head is world-readable, which is why S1 passed.

**P2. Switching off private forking does not delete or disable existing forks.** With
`members_can_fork_private_repositories: false`, the owner still reads the bot fork (200), the push App
still mints on it (201), and a new fork is refused with `403 "The repository exists, but forking is
disabled."`. The fork was intact after the setting was restored. `doctor` cannot rely on the policy
to detect a stale fork; it must check the fork itself.

**P3. The fork-PR approval gate never holds App-authored PRs.** With `approval_policy:
all_external_contributors`, the App's fork PR started its `pull_request` run at once (actor and
triggering actor `sl-sandbox-pr-abad[bot]`), with no approval. In the run that was followed to the
end (run 43509742249), the job executed and concluded `success` 7 seconds after creation. This confirms F1 on the strictest public setting. Approval settings stay out of the control
set, as `12` §5 already assumes. The policy only exists for public repos (`422 "Fork PR approval is
not allowed for private repositories."`); private repos use `require_approval_for_fork_pr_workflows`,
which P1 makes moot for soren-loop.

**P4. Only the owner's credential can read the private-repo fork-PR workflow settings.**
`GET /repos/{r}/actions/permissions/fork-pr-workflows-private-repos` returns 200 for the owner and
403 for the PR App's full set. The backend start-up check (`08` §1.4a), which uses App JWTs and
installation tokens, cannot verify them; only `doctor` can, with the owner's credential. The org-level
setting caps the repo (a repo-level enable is refused with 422 while the org forbids it), so `doctor`
should read both. All four flags were `false` on the sandbox org and repo, which were left at
GitHub's settings. The endpoint returns 422 for public repos.

**P5. ST-48 holds for the widened set; `contents: read` is clone-capable.** Every write path tried
returns 403 and `git push` is rejected, on both visibilities. A `git clone` with the PR App's
`contents: read` token succeeds, which matches the intended SR-09 fallback fetch token.

**P6. No PR-App capability bypasses a required review.** Under a ruleset requiring one approving
review with no bypass actors: `update-branch` is 403 (it needs write on the head), the App cannot
approve its own PR (422), and close and reopen succeed but leave the PR `REVIEW_REQUIRED` /
`BLOCKED`, with merge still 403. Run on the public upstream, because P1 prevents an App-authored PR on
the private one; rulesets apply the same way to both.

**P7. The push App cannot create the fork.** `POST /repos/{upstream}/forks` with a push App token
returns 404: it has no read access to the private upstream. The setup wizard must fork with the
owner's credential.

## Decision Needed (decision 29, Q1)

P1 means a private upstream cannot use the fork model as `08` §1 specifies. Options for the owner:

1. **Private repos use same-repo mode only** (`08` §1.8). This is the existing opt-in path, widened
   from "orgs that forbid private forks" to "all private repos". Cost: it gives up the two-App
   guarantee for those repos (upstream `contents: write`, R5 and T10.1 back to H) and depends on
   `doctor`-verified rulesets.
2. **Private repos are out of MVP scope.** The MVP supports public upstreams only; private repos wait
   for a design that keeps a no-merge upstream credential.
3. **Owner-credential PR creation for private repos.** The PR is opened with the owner's own token.
   Cost: the PR is no longer bot-authored, and the server would hold or borrow an owner credential,
   which SR-09 and T24 avoid.

Untested: whether installing the PR App on the bot org as well changes P1. A PR still needs one token
that reads both repos, and tokens are per installation, so this is unlikely to help. Checking it
needs the sandbox PR App made installable on a second org.

## RFC Sections This Changes (for Arendt)

| Section | Change |
|---------|--------|
| `08` §1.2 | `contents: read` with `pull_requests: write` still gets 403 on merge: UNVERIFIED → verified (P5) |
| `08` §1.3 step 3 | The push App cannot create the fork (P7); the wizard forks with the owner's credential |
| `08` §1.3 `doctor` | Private-repo checks read org **and** repo fork-PR settings with the owner's credential (P4); the fork-policy check is not a stale-fork check (P2) |
| `08` §1.4 | "Name a private fork as head": UNVERIFIED → refuted (P1) |
| `08` §1.4a | The start-up check cannot verify the private-repo fork-PR settings (P4); record as a `doctor`-only check |
| `08` §1.6 | Items 1–5 answered; item 6 (human-merge ruleset) stays a setup recommendation |
| `08` §1.7 | F1 confirmed under `all_external_contributors` (P3) |
| `08` §1.8, `13` Q1 | Scope of same-repo mode, per the decision above |
| `12` §5 | S1-F row → Done, with the P1 disposition |
| `06` ST-48 | Passes in the sandbox; the harness becomes the regression test (Tasks 057, 061) |

## Reproduce

```bash
cd soren-loop/spikes/s1f        # Node 24; needs the two keys and `gh` with admin:org, repo, workflow
node run.ts --org sorenai-dev-sandbox                      # items 1, 3, 4, 5, 6
node run.ts --org sorenai-dev-sandbox --allow-org-toggle   # adds item 2 (toggles an org setting)
node run.ts --org sorenai-dev-sandbox --only 5             # ST-48 alone
```

Exit 0: every row matches the recorded baseline. Exit 1: something changed; read the table. Exit 2:
a 2xx on a merge or upstream write (stop the line before Tasks 060–066). The expected values encode the
GitHub behaviour above, so a change in GitHub's behaviour surfaces as a failure.

## Cleanup

The harness reverts everything it changes. The sandbox Apps, forks and keys stay for Tasks 057, 061
and 065. To retire them: delete each App's key on its settings page and
`rm -rf ~/.soren-loop-sandbox`.
