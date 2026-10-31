# Spike S1: Fork-PR Permissions with GitHub App Least-Privilege Tokens

Companion to `03-architecture-and-risks.md` (ADR-4, Phase 0) and `security/06-requirements-tests-spikes.md`
(SR-08, ST-14, S1 row). Date: 2026-10-30. Run against GitHub.com (REST API `2022-11-28`).

## Verdict

**S1 PASSES. ADR-4 (fork model) stands; Option B is not needed.** An App installation token on the
upstream repo with only `pull_requests: write` + `metadata: read` opens a PR from a fork head and
cannot merge it. A fork-side `contents: write` token without `workflows` is rejected when it adds or
modifies `.github/workflows/*` by both `git push` and the Contents API. Fork PR CI gets no secrets.

| # | Question | Result |
|---|----------|--------|
| Q1 | Upstream `pull_requests: write` (no `contents`) can open a PR with a fork head | **PASS**: 201, no extra permission needed |
| Q2 | That token cannot merge | **PASS**: 403 |
| Q3 | Fork `contents: write` without `workflows` cannot add or modify workflow files | **PASS**: rejected by git push (both cases) and Contents API (403, both cases) |
| Q4 | Upstream CI does not expose secrets to the fork PR | **PASS**: `secret_present=false` on the fork PR; `true` on a same-repo control PR |
| Q5 | Per-token down-scoping (`permissions`, `repositories`) works and fails closed | **PASS**: scope honoured; over-grant and out-of-installation repos return 422 |

ST-14 is satisfied: the minted push token cannot write upstream (403 on API and git), cannot write
`.github/workflows/*` on the fork, and the upstream PR token cannot merge.

**Scope caveat:** every repo here was **public** and owned by a personal account. Private repos,
private forks, and org policies were not tested (see Open Items).

## Setup

- App `feature-loop-s1-fcf8`, registered via the manifest flow (`spikes/s1/manifest.mjs`). Public,
  no webhook, no events. App permissions: `contents: write`, `pull_requests: write`, `metadata: read`.
  No `workflows`.
- Upstream: `mandelbro/feature-loop-s1-upstream` (public). Its only contents are a README and a
  `pull_request` workflow that prints `secret_present=true|false` for the repo secret
  `S1_DUMMY_SECRET`, never the value. The fork-PR approval policy was `first_time_contributors`.
- Fork: `sorenai-dev/feature-loop-s1-upstream`.
- Installations (`results/q0-installations.json`): one per account, `repository_selection: selected`,
  each limited to its single repo. Both installations carry the full App permission set
  (`contents: write` on upstream included). Least privilege comes only from how tokens are minted.
- JWT: `jose` `SignJWT` (RS256) with a Node `KeyObject`, made from the PKCS#1 PEM. The key is kept outside
  the repo and iCloud at `~/.feature-loop-spikes/s1/` (0700 dir, 0600 files).
- Raw evidence: `spikes/s1/results/*.json` (tokens redacted; a scan found no `ghs_` or PEM content).

## Evidence

### Q5: Down-scoping (`results/q5-downscoping.json`, `results/q5-supplement.json`)

| Call | Status | Response |
|------|--------|----------|
| Mint upstream `{pull_requests: write, metadata: read}`, `repositories: [upstream]` | 201 | `permissions: {metadata: read, pull_requests: write}`, `repository_selection: selected` |
| `GET /installation/repositories` with that token | 200 | only `mandelbro/feature-loop-s1-upstream` |
| `PUT /contents/q5-probe.txt` upstream with that token | 403 | `Resource not accessible by integration` |
| Mint with `{workflows: write}` (not granted to the App) | 422 | `The permissions requested are not granted to this installation.` |
| Mint with a repo outside the installation | 422 | `There is at least one repository that does not exist or is not accessible to the parent installation.` |

Each installation can only mint tokens for its own repos. So the upstream installation cannot mint a
token for the fork, and the fork installation cannot mint one for upstream.

### Q1 / Q2: Open and merge (`results/q1q2-open-and-merge.json`)

| Call | Token | Status | Response |
|------|-------|--------|----------|
| `POST /repos/mandelbro/feature-loop-s1-upstream/pulls` `head: "sorenai-dev:s1-feature"`, `maintainer_can_modify: false` | upstream `{pull_requests: write, metadata: read}` | **201** | PR #1, author `feature-loop-s1-fcf8[bot]`, head repo `sorenai-dev/feature-loop-s1-upstream` |
| `PUT /pulls/1/merge` | same | **403** | `Resource not accessible by integration` |
| Control: `PUT /pulls/2/merge` (second fork PR) | upstream `{pull_requests: write, contents: write, metadata: read}` | **200** | `merged: true`, `Pull Request successfully merged` |

The `contents: read` fallback variant was never needed. The upstream token did not need any access to
the fork repo to name it as `head` (public fork). The control merge confirms that `contents: write`
grants merge, which is exactly the Option B risk (R5, T10.1).

### Q3: Workflow-file writes on the fork (`results/q3-workflow-push.json`)

Fork token `{contents: write, metadata: read}`:

| Path | Action | Result |
|------|--------|--------|
| Contents API | create branch `s1-feature`, `PUT feature.txt` | 201, 201 (control) |
| Contents API | `PUT .github/workflows/evil.yml` (add) | **403** `Resource not accessible by integration` |
| Contents API | `PUT .github/workflows/secret-check.yml` (modify, with sha) | **403** `Resource not accessible by integration` |
| git push (HTTPS, `x-access-token`) | normal file to `s1-git-normal` | exit 0 (control) |
| git push | add `.github/workflows/evil2.yml` | **rejected**: `refusing to allow a GitHub App to create or update workflow .github/workflows/evil2.yml without workflows permission` |
| git push | modify `.github/workflows/secret-check.yml` | **rejected**: same message |
| Contents API | `PUT` on upstream with fork token | **403** |
| git push | to upstream with fork token | **403** `Permission to mandelbro/feature-loop-s1-upstream.git denied to feature-loop-s1-fcf8[bot]` |

GitHub enforces the rejection server-side on both write paths. The SR-04 deny-list is defence in
depth, not the only control.

### Q4: Secrets on fork PR CI (`results/q4-fork-pr-secrets.json`)

| PR | Head | Run | Report |
|----|------|-----|--------|
| #1 (App, fork) | `sorenai-dev/feature-loop-s1-upstream` | 41129784873, `pull_request`, success | `is_fork=true secret_present=false` |
| #3 (mandelbro, same-repo control) | `mandelbro/feature-loop-s1-upstream` | 41129894855, `pull_request`, success | `is_fork=false secret_present=true` |

**Unexpected:** the fork PR run **did not stop at `action_required`**, even though the upstream policy
was `first_time_contributors`. It started immediately, with actor and triggering actor both
`feature-loop-s1-fcf8[bot]`. The approval gate does not appear to cover App-authored fork PRs (observed
once; the cause is not confirmed). See Findings F1.

## Findings That Change or Sharpen the Design

**F1. The fork PR approval gate is not a control for the bot's PRs.** Fork PR CI ran without approval.
For `pull_request` events the workflow definition comes from the PR merge ref. So fork-side workflow
edits execute upstream, without secrets and with a read-only `GITHUB_TOKEN`. Q3 stops the *App* from
writing workflows. Any human or other credential with push access to the fork does not go through
the App and is not stopped. Recommendation: the fork account must be bot-only (no human pushers). `doctor`
should keep blocking `pull_request_target` and `workflow_run` workflows that check out PR heads
(SR-08). Test whether `all_external_contributors` gates App PRs before relying on it.

**F2. Installation permissions are App-wide, so the upstream installation *can* mint a merge-capable
token.** Least privilege today rests on the backend's minting code and on protecting the private key. A
leaked key or a bug restores Option B's merge risk (the control merge proves it). Recommended
hardening for ADR-4/SR-08: **split into two Apps**. A *PR App* with `pull_requests: write` +
`metadata: read` only, installed on upstream. A *push App* with `contents: write` +
`metadata: read`, installed only on the fork. Q1 shows the upstream token needs no access to the fork
to open the PR, so the split is feasible. After the split, no upstream credential can merge, whatever
the minting code does. Cost: two registrations and two keys for the owner to manage.

**F3. Down-scoping fails closed.** Over-grants and out-of-installation repos return 422 instead of a
silently reduced token. The backend can treat any non-201 mint as a hard error.

**F4. Set `maintainer_can_modify: false` explicitly.** It was honoured (PR #1 shows `false`). Upstream
maintainers then cannot push onto the bot's fork branch, which keeps that branch's content attributable
to the bot pipeline.

## Design Branch

From the S1 row in `06-requirements-tests-spikes.md`: the "if no" branch does **not** apply.

- ADR-4 is unblocked; Option B stays a documented fallback only.
- R5 and T10.1 are not launch blockers under the fork model. Residual risk is key or minting compromise
  (F2), mitigated by the two-App split.
- The SR-04 workflow deny-list stays as defence in depth. GitHub rejects workflow pushes without
  `workflows` on both git and the Contents API.
- SR-08 minimum upstream permission set: **`pull_requests: write` + `metadata: read`**.

## Open Items (not tested here)

1. Private upstream with a private fork (the stated ADR-4 trade-off), including org fork policy and the
   "send secrets / write tokens to workflows from fork pull requests" settings for private repos.
   `doctor` should verify both are off.
2. Whether `all_external_contributors` approval holds App-authored fork PRs (F1).
3. Other `pull_requests: write` capabilities on upstream: `PUT /pulls/{n}/update-branch`, review
   submission (an App approving its own PR), closing or reopening. Confirm none can bypass required review.
4. Whether a ruleset or branch protection is still needed upstream to stop *humans* merging unreviewed
   bot PRs. This is out of S1's scope.

## Reproduce

```bash
cd soren-loop/spikes/s1
node manifest.mjs            # browser: create App, install on upstream and fork
node verify-installs.mjs     # q0: installations and repo scope
node run-spike.mjs all       # q5, q3, q1q2 (includes the control merge)
node run-spike.mjs q4        # after CI completes
node supplement.mjs          # 422 messages and token-scope evidence
```

## Cleanup (manual, by the owner)

1. Delete repos: `gh repo delete mandelbro/feature-loop-s1-upstream --yes` and, as sorenai-dev,
   `gh repo delete sorenai-dev/feature-loop-s1-upstream --yes` (needs the `delete_repo` scope:
   `gh auth refresh -h github.com -s delete_repo`, or delete via Settings → Danger Zone).
2. Uninstall the App from both accounts (Settings → Applications → Installed GitHub Apps), then delete
   it: github.com/settings/apps/feature-loop-s1-fcf8 → Advanced → Delete GitHub App. Deleting the App
   also revokes its keys and installations.
3. Delete local secrets: `rm -rf ~/.feature-loop-spikes/s1`.
4. Optional: delete the local scratch clone and `spikes/s1/.work-*` and `node_modules/`.
