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
  fork policy does not change this (P2). **Owner decision (2026-11-14): private forks are dropped;
  private repos use a same-repo ("Dependabot") model, public repos keep the fork model.** The
  same-repo model was tested the same day (items 7–12): its ruleset control holds, with two costs to
  design for (S1–S5).
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

## Decision (owner, 2026-11-14; extends decision 29, Q1)

P1 means a private upstream cannot use the fork model as `08` §1 specifies. The options were: (1)
same-repo mode for private repos, (2) private repos out of MVP scope, (3) owner-credential PR creation.
The owner chose **(1), framed as the Dependabot model**: an App installed on the owner's repo pushes a
`soren-loop/*` branch and opens the PR, and a repo member reviews and merges it. It applies to
**private repos only**; public repos keep the two-App fork model, which gives the stronger guarantee
(no merge-capable credential, no secrets in fork-PR CI). Private forks are dropped from the design.
The untested variant (installing the PR App on the bot org too) is no longer needed.

## Same-Repo Model for Private Repos (items 7–12, 2026-11-14)

The sandbox PR App was widened to `contents: write` for this run; tokens were minted with
`{contents: write, pull_requests: write, metadata: read}` on a private upstream. The control under test
is a default-branch ruleset with no bypass actors: `pull_request` (1 approving review, dismiss stale
reviews, `require_last_push_approval`), `deletion`, `non_fast_forward`. A repo Actions secret held a
random UUID so CI could report only whether it was present.

| # | Question | Result | Key status codes and messages |
|---|----------|--------|------------------|
| 7 | Can the App do its job? | **Yes** | mint 201 · create `soren-loop/*` branch 201 · commit 201 · open PR 201 |
| 8 | Can the App write `main` directly? | **No** | contents PUT **409** "Changes must be made through a pull request." · `git push` rejected (GH013) |
| 9 | Can the App merge without a human review of its latest commit? | **No** | self-approve **422** · merge before review **405** "New changes require approval from someone other than the last pusher." · after a human approval plus a late bot push, merge **405** (same message, twice, after 30 s and 45 s) |
| 9b | Once a human approves the App's latest commit, can the App press merge? | **Yes** | merge **200** "Pull Request successfully merged" |
| 10 | Can the App weaken or read the control? | Cannot weaken; can read the rules but **not the bypass list** (S9) | delete ruleset **403** · disable ruleset **403** · `GET /rules/branches/main` 200 · `GET /rulesets` 200 |
| 11 | Can the App edit workflows? | **No** | contents PUT on `.github/workflows/*` **403** |
| 12 | Does CI on the App's PR see repo secrets before review? | **Yes** (the risk) | run by `sl-sandbox-pr-abad[bot]`, `success`, `probe_present=true` |

Evidence: `spikes/s1f/results/run-20261114T205450.json` (authoritative) and
`run-20261114T205341.json` (the first run, kept for S3). No stop-the-line finding.

**S1. The ruleset is the control, and it holds against the App.** With `contents: write`, nothing
but the ruleset stops a merge (S1 showed 200 on an unprotected repo). With it, every merge and direct
write the App tried before a human had approved its latest commit was refused, and the App could not
delete or disable the ruleset (no `administration` permission).

**S2. "A human presses merge" is not enforceable by GitHub.** Once a human approves the App's latest
commit, the App's own merge succeeds. Only soren-loop's code (it never calls merge) and the protection
of the App's key stand in the way; a leaked key can merge any PR a human has approved. Under the fork
model it cannot. This is the residual R5/T10.1 risk for private repos.

**S3. Don't read `reviewDecision` right after a push.** In the first run, immediately after the late
bot push GitHub still reported `APPROVED` / `CLEAN`, while the merge was already refused (405, generic
"Pull Request is not mergeable"). In the second run, read 30 seconds after the same kind of push, it
reported `REVIEW_REQUIRED` / `BLOCKED` and the merge failed with the explicit rule message. The
server must not use `reviewDecision` as a merge or state signal without waiting for it to settle.

**S4. The start-up check can verify the ruleset's rules with the App's own token.** Unlike P4,
`GET /repos/{r}/rules/branches/main` and `GET /rulesets` return 200 for the App, so the backend check
(`08` §1.4a) can confirm the required rules without the owner's credential. An earlier draft said it
could also confirm an empty bypass list; it can't (S9).

**S5. Same-repo PR CI gets repo secrets before review (confirms S1 Q4 for App-authored PRs).**
Agent-written code runs in CI with secrets before a human has looked at it. GitHub gives Dependabot's
own PRs fork-like treatment; a third-party App's PRs do not get it. The mitigation must come from the
setup: `doctor` refuses to run unless `pull_request` workflows use no secrets, or secrets sit behind
environments with required reviewers (`08` §1.8 already sketches the first).

## Same-Repo Gaps (items 13–15, 2026-11-14, before the G03 PR)

Three questions the RFC revision left open (`13` T33, and Arendt's open items on branch scope and
`maintainer_can_modify`), run on a fresh private upstream with the same widened App and the S1
default-branch ruleset. Evidence: `spikes/s1f/results/run-20261114T224202.json` (items 7 and 8 both
re-run; every item 7 result reproduced).

| # | Question | Result | Key status codes and messages |
|---|----------|--------|-------------------------------|
| 13 | T33: does a `push` workflow on `soren-loop/**` see repo secrets when the App pushes? | **Yes** (the risk) | push run by the App, `probe_present=true` |
| 14a | Can the App's token write branches outside `soren-loop/*`? | **Yes** (a gap) | create `feature/*` 201 · `git push` to `release/*` exit 0 |
| 14b | Does a branch ruleset confine it? | **Yes** | see S7 |
| 15 | Does `maintainer_can_modify: false` mean anything on a same-repo PR? | No; GitHub reports `false` | PR 201, field `false` |

**S6. Push workflows on the App's branches get secrets too (T33 verified).** `doctor`'s
no-secrets-or-gated-environment rule must cover `push` workflows matching `soren-loop/**` as well as
`pull_request` workflows; SR-08 already says so, and the RFC's UNVERIFIED marker can go.

**S7. A second ruleset confines the App to `soren-loop/**`.** Without it, the App (and its 1 h push
token) can create and update any branch other than the protected default branch. A branch ruleset on
`~ALL`, excluding `refs/heads/soren-loop/**` and `~DEFAULT_BRANCH`, with the `creation`, `update` and
`deletion` rules and the repository **admin** role as the only bypass actor, blocks it: create
`feature/*` 422 "Reference update failed", update an existing `feature/*` branch 409 "Cannot update
this protected ref", `git push` to `release/*` rejected (GH013). The App still creates `soren-loop/*`
branches (201), and the owner, an admin, still creates `feature/*` branches (201). The default branch
is excluded, so merges keep going through the S1 ruleset alone. **Cost:** with an admin-only bypass, non-admin human
collaborators can't create or update other branches either. **Owner decision (2026-11-14): this
ruleset is required, with the built-in write, maintain and admin roles as its bypass list.** Bypass is
per role, not hierarchical, so maintain needs its own entry. The role IDs are undocumented and not
sequential (write 4, maintain 2, admin 5; GitHub's rest-api-description issue 4406). With that bypass
list the App is still confined: `feature/*` create 422, `soren-loop/*` create 201, owner create 201
(item 16, `run-20261114T230245.json`). That a non-admin writer gets through rests on GitHub's
documented bypass behaviour; the sandbox has no second human account to show it.

**S8. `maintainer_can_modify` is a fork-PR setting.** On a same-repo PR GitHub reports `false`, and
there is no fork for maintainers to push to. ST-49's narrowing to fork PRs (decision 37) is correct.

**S9. The App's token cannot read ruleset bypass lists.** `GET /repos/{r}/rulesets/{id}` returns 200
for the App (with `contents: write` or `contents: read`) but omits `bypass_actors`; the owner's
credential sees them. The response does carry `current_user_can_bypass` for the caller: `"never"` for
the App normally, and `"always"` after the App is added as an `Integration` bypass actor (both checked
2026-11-14 on the public upstream). So the start-up check verifies the rules and that the App itself
cannot bypass, and only `doctor` can verify the full bypass lists. A human bypass actor added later to
the default-branch ruleset (which would let that person merge without review) is visible only to
`doctor`.

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
| `08` §1.8, `13` Q1 | Same-repo mode becomes **the** model for private repos (not an opt-in for orgs that forbid forks); private forks are removed. Its controls: the S1 ruleset verified by the start-up check (S4) and `doctor`, the no-secrets CI rule (S5), never calling merge (S2), settled reads of `reviewDecision` (S3) |
| `08` §1.1–1.3 | The bot org and push App apply to public repos only; private repos need one App with `contents: write`, `pull_requests: write`, never `workflows` or `administration` |
| `03` R5, T10.1 | Rated H again for private repos (S2), as `08` §1.8 already anticipated |
| `12` §5 | S1-F row → Done, with the P1 disposition |
| `06` ST-48 | Passes in the sandbox; the harness becomes the regression test (Tasks 057, 061) |

## Reproduce

```bash
cd soren-loop/spikes/s1f        # Node 24; needs the two keys and `gh` with admin:org, repo, workflow
node run.ts --org sorenai-dev-sandbox             # items 4, 5, 6 on the public upstream (fork model)
node run.ts --org sorenai-dev-sandbox --only 5    # ST-48 alone
node run.ts --org sorenai-dev-sandbox --only 7    # items 7-12 (same-repo model); see below
```

Exit 0: every row matches the recorded baseline. Exit 1: something changed; read the table. Exit 2:
a 2xx on a merge or upstream write (stop the line before Tasks 060–066). The expected values encode the
GitHub behaviour above, so a change in GitHub's behaviour surfaces as a failure.

Items 1–3 and the private halves of 4 and 5 were removed from the harness once private forks were
dropped; their code is in commit `1ef94c9`. Item 7 needs a private upstream named
`sorenai-dev-sandbox/sl-upstream-private` and the PR App widened to `contents: write`; both were
removed after the 2026-11-14 run.

## Cleanup

The harness reverts everything it changes. After the runs, the private fork and the private upstream
were deleted (owner instruction, 2026-11-14), and the PR App's Contents permission goes back to Read so
it matches SR-08 again. The public upstream and fork, both Apps and the keys stay for Tasks 057, 061
and 065. To retire them: delete each App's key on its settings page and `rm -rf ~/.soren-loop-sandbox`.
