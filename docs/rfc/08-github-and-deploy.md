# 08. Deep Dives: GitHub PR Models and Deploy Detection

Flags (`FlagWriter`, flagd, Unleash, the OFREP contract) are in `16-flags.md`.

## 1. ADR-4: Fork Model for Public Repos, Same-Repo Model for Private Repos (decisions 7, 24, 25; decision 37)

**Status: Accepted.** S1 passed every question (`docs/discovery/spikes/S1-fork-pr-permissions.md`).
Decision 24 keeps the fork model and rejects Option B. Decision 25 splits GitHub access into two
Apps. S1-F (`docs/discovery/spikes/S1F-private-repo-followups.md`) then showed that the fork
model **does not work for private repos** (P1, §1.6). Decision 37 (2026-11-14, S1-F)
splits the design by the upstream's visibility:

| Upstream | Model | Apps | Who can merge |
|----------|-------|------|---------------|
| **Public** | Fork model (§1.1 to §1.7), unchanged | PR App upstream, push App on the bot-only fork | No soren-loop credential, whatever the minting code does |
| **Private** | Same-repo ("Dependabot") model (§1.8, §1.9) | One repo App on the owner's repo | GitHub's ruleset stops every merge until a human approves the latest commit (S1-F item 9). soren-loop never calls merge. |

Private forks are dropped from the design. The bot org and the push App apply to public repos
only.

**Context.** GitHub's merge endpoint needs only `Contents: write`, the same permission as a
push. So "may open PRs but never merge" can't be expressed with permissions on a single repo.
S1 established four facts on public repos:

1. A token with only `pull_requests: write` and `metadata: read` on upstream opens a PR whose
   head is on the fork (201), and gets 403 when it tries to merge. A control token that adds
   `contents: write` merged successfully.
2. A fork token with `contents: write` and no `workflows` permission is rejected when it adds or
   modifies `.github/workflows/*`. This holds for both `git push` and the Contents API.
3. CI on the fork PR saw no secrets. A same-repo control PR did.
4. Down-scoping fails closed. An over-grant or an out-of-installation repo returns 422, never a
   silently reduced token.

**Why two Apps (S1 finding F2).** Installation permissions apply App-wide. With one App, the
upstream installation *can* mint a token that merges, so least privilege would rest only on the
minting code and the key. A bug or a leaked key would bring back Option B's merge risk. With
two Apps, **no upstream credential can merge, whatever the minting code does.** The same F2
fact is why the private-repo App is a **separate registration** and not a widened PR App: a PR
App granted `contents: write` would hold it on every public upstream too.

### 1.1 The Apps

| | **PR App** (`soren-loop-pr`), public repos | **Push App** (`soren-loop-push`), public repos | **Repo App** (`soren-loop-repo`), private repos |
|-|--------------------------------|------------------------------------|------------------------------------|
| Installed on | The upstream repo only (`repository_selection: selected`) | The bot-only fork only | The owner's private repo only (`repository_selection: selected`) |
| Permissions | `pull_requests: write`, `metadata: read` (decision 25), plus the read-only and optional additions in §1.2 | `contents: write`, `metadata: read` | `contents: write`, `pull_requests: write`, `metadata: read`, plus `deployments: read` and the optional `issues: write` (§1.2) |
| **Never** | `contents: write`, `workflows`, `administration`, `secrets`, `actions` | `workflows`, `pull_requests`, `administration`, or any upstream installation | `workflows`, `administration`, `secrets`, `actions` |
| Used for | Opening PRs, labels, receiving webhooks, the optional issue projection, ancestry checks | Minting the single-use push token for `submit`; the server's compare re-check of the pushed branch | Everything the other two do, on the one repo: the push token, PRs, labels, webhooks, projection, compare checks, and the ruleset check (§1.9) |
| Webhooks | On: `pull_request` (including `synchronize`, for SR-41 head pinning), `pull_request_review`, `deployment_status`, `installation`, `installation_repositories` | Off (no webhook URL) | On: the same events as the PR App |
| Who uses its key | The outbox workers | Only the token-minting service (`POST /v1/cli/runs/{id}/push-token`) and the compare re-check | The outbox workers and the token-minting service |
| Bot identity | `soren-loop-pr[bot]` authors the PR | `soren-loop-push[bot]` authors the commits pushed to the fork | `soren-loop-repo[bot]` authors the PR and the commits |

A deployment registers only the Apps its bound repos need: the PR App and push App for public
repos, the repo App for private ones. The repo App's name is a placeholder (`13` T31).

### 1.2 PR App Permissions Beyond Decision 25 (decision 26)

Decision 25 lists `pull_requests: write` and `metadata: read`. Three existing features need
more from the upstream installation. None of these grants push or merge.

| Addition | Needed for | If not granted |
|----------|-----------|----------------|
| `contents: read` | The ancestry check before `deployed`: `GET /compare/{merge_sha}...{deploy_sha}` reads commits (SR-08, T10.6) | The ancestry check can't run, so a deploy can't be verified. Not acceptable. |
| `deployments: read` | Receiving `deployment_status` webhooks | Only the signed deploy webhook and `mark-deployed` remain (§2) |
| `issues: write` | Issue projection (SR-17), and only when it's turned on | No projection, which is the default for public repos anyway |

`contents: read` was the one to watch. S1 showed that `contents: write` grants merge. **S1-F
verified** (P5, item 5) that the PR App's full installed set (`pull_requests: write`,
`issues: write`, `deployments: read`, `contents: read`, `metadata: read`) gets 403 on every
merge and write path: merge and squash merge, `POST /merges`, a Contents `PUT`, ref creation,
and `git push` to the default branch or a new branch. A `git clone` with that token works,
which is what the SR-09 fallback fetch token needs. ST-48 passes in the sandbox, and the S1-F
harness becomes its regression test. SR-08 names this exact set. The backend start-up check
(§1.4a) and `doctor` both **fail on `contents: write` for the PR App**, and on any permission
outside the set above. Decision 26 accepts this set. The repo App holds `contents: write` by
design (§1.9); its `contents: read` needs are covered by that.

### 1.3 Owner Setup (Public Repos)

Private repos skip steps 1 and 3 and use §1.9 instead.

1. **Create a bot-only fork owner.** This is a dedicated GitHub organization (decision 29, Q15), such as `<owner>-soren-loop-bot`. It must have no human members with push
   access (F1, below). The owner may be the org's sole owner, but **must not push to the fork**.
2. **Register the Apps** from the dashboard setup wizard, using the GitHub manifest flow once
   per App. The manifests are `github/pr-app.manifest.json`, `github/push-app.manifest.json`
   and, for private repos, `github/repo-app.manifest.json` in Repo 1, under CODEOWNERS and a
   security-review label (SC8). The push App is registered under the bot org; the PR App and
   the repo App under the owner's account or org.
3. **Fork and install.** The wizard creates the fork **with the owner's credential** (or guides
   the owner to fork into the bot org): the push App can't, because it has no read access to
   upstream (`POST /forks` returns 404, S1-F P7). The PR App goes on the upstream repo only.
   The push App goes on the bot org, limited to the fork repo. The wizard records both
   installation IDs.
4. **Keys.** The manifest conversion returns each App's private key once. In `--setup` mode
   only, the server writes the keys to `SL_SECRETS_DIR/github-pr-app.pem`,
   `SL_SECRETS_DIR/github-push-app.pem` and `SL_SECRETS_DIR/github-repo-app.pem` (as
   registered) with mode `0400`. It never stores or returns them again (§1.5). The setup role
   then exits, and the normal `web` and `worker` roles mount the directory read-only.
5. **`doctor` checks**, which block builds until they pass:
   - The PR App's installed permissions are inside §1.2, and it has no `contents` permission
     above read.
   - The push App's installation covers exactly one repo, the fork, and the push App has no
     installation on upstream.
   - The fork's collaborators and teams have no human push access (F1).
   - `maintainer_can_modify` is false on any open soren-loop PR (F4).
   - No `pull_request_target` or `workflow_run` workflow checks out a PR head (SR-08, T10.3, F1).

   The earlier private-fork checks (org fork policy, the private-repo "send secrets / write
   tokens to fork PR workflows" settings) are dropped with private forks. S1-F showed that only
   the owner's credential can read those settings (P4) and that turning off private forking
   doesn't remove an existing fork (P2); neither matters once no private fork exists.

### 1.4a Backend Start-Up Check (SR-08, T10.12)

`doctor` runs on the owner's machine, and only when invoked. The server must not depend on it.
So at every start, and hourly after that, the `web` and `worker` roles each mint an App JWT for
every registered App and call `GET /app` and `GET /app/installations`, plus
`GET /installation/repositories` per installation. They compare the result with the expected
manifest:

- the PR App's permissions are exactly the SR-08 set, with no `contents: write`;
- the push App's permissions are exactly `contents: write` and `metadata: read`;
- the repo App's permissions are exactly its §1.1 set;
- the PR App is installed only on bound public upstreams, the push App only on the fork, and
  the repo App only on bound private repos;
- no App holds `workflows`, `administration`, `secrets`, or `actions`;
- for each private-repo binding, the default-branch ruleset passes the §1.9 check, read with
  the repo App's own installation token (S1-F S4).

**Anything extra fails closed.** The server refuses to boot. If the extra permission appears at
runtime, the server stops minting tokens for that App, marks the GitHub outbox effects
`blocked_config`, and sends the owner one alert. A missing permission degrades only the feature
that needs it. The check is about not holding more than it should (ST-48). A failed ruleset
check is treated the same way for that binding.

The check reads only what an App token can read. S1-F P4 showed that the private-repo fork-PR
workflow settings need the owner's credential; with private forks dropped, nothing in the
design depends on them.

### 1.4 Token Minting and PR Creation

| Operation | App | Mint request | Lifetime |
|-----------|-----|--------------|----------|
| Open PR, label, project issue | PR App | `repositories: [upstream]`, `permissions: {pull_requests: write, metadata: read}` (plus `issues: write` for projection) | Minted per effect, 1 h, never leaves the worker |
| Ancestry compare | PR App | `{contents: read, metadata: read}`, upstream | Per call |
| CLI fetch of a private upstream (`07` §1.1), **fallback only** | Repo App | `{contents: read, metadata: read}`, the private repo, via the CLI-owned `GIT_ASKPASS` | 1 h, one per run, audited; requires a DPoP-bound CLI token (SR-09, T24, ST-75). The default uses the owner's own git credential, so nothing is minted. |
| CLI fetch of a recorded rework head SHA (`07` §1.4) | Push App (public) or repo App (private) | **down-scoped at mint** to `{contents: read, metadata: read}`, the fork or the private repo | 1 h, one per run, audited (Zod m5) |
| Push for `submit` | Push App (public) or repo App (private) | `repositories: [fork]` or `[private repo]`, `{contents: write, metadata: read}` | One per run (at most one `replace`), 1 h. Stored encrypted only until expiry, for revocation, and never returned again. The CLI revokes it after the push, and the server revokes any leftover when the request leaves `building` (SR-09). |
| Compare re-check of the pushed branch | Push App (public) or repo App (private) | `{contents: read, metadata: read}`, the fork or the private repo | Per call |
| Open PR, label, project issue, ancestry compare (private) | Repo App | As the PR App rows, on the private repo; never with `contents: write` | As the PR App rows |

- **F3:** any mint response other than **201** is a hard error. That includes a 422 from an
  over-grant or a wrong repo. The server records an audit event, sets the outbox effect to
  `dead` (or refuses the CLI request with `code: token_mint_failed`), and never retries with a
  broader scope.
- **F4:** `POST /pulls` always sends `maintainer_can_modify: false`, so upstream maintainers
  can't push onto the bot's fork branch, and the branch content stays attributable to the
  pipeline. The flag only has an effect on fork PRs; on same-repo PRs, SR-41 head pinning and
  the ruleset's `require_last_push_approval` cover the same ground.
- **SR-41 head pinning.** When the PR is opened or updated, the server records `pinned_head_sha`
  in `request_prs`. A `synchronize` event or PR head that matches neither the pin nor the
  in-flight run's declared `expected_head` moves the request to `stalled{head_tampered}`, adds
  `soren-loop:do-not-merge`, and raises the locked `owner.pr_head_changed` (`03` row 47). A
  merge of a superseded PR raises the same locked kind (row 46).
- The PR head is `<bot-org>:soren-loop/<public_ref>/<chain>` on public repos and
  `soren-loop/<public_ref>/<chain>` on the repo itself for private repos. `public_ref` is a
  separate opaque random ID that can't be linked to the widget `request_id` (SR-40a). On a
  public repo, a requester can then never find their own PR, diff, or risk summary. S1 showed
  that the upstream token needs no fork access to name a public fork as the head. For a
  **private** fork this is **refuted** (S1-F P1): `POST /pulls` returns 422 "not all refs are
  readable", because the caller must read the head repo and no PR App installation can cover a
  repo in the bot org. That finding is why private repos use §1.9.
- Tokens are never minted inside the sandbox.

### 1.5 Key Storage (SR-14)

- One file per registered App under `SL_SECRETS_DIR`: mode `0400`, owned by the server's user,
  on a volume separate from Postgres. Never in the DB, environment variables, logs, or backups
  made by `pg_dump`.
- Each key is loaded into its own signer module. Only the minting service imports the push
  App's signer, and a lint rule enforces this. A bug elsewhere then can't mint push tokens. The
  repo App's signer is imported by the minting service and the outbox workers; the workers'
  mint calls are restricted by the same lint rule to permission sets without `contents: write`.
- Rotation: the dashboard gives the steps for each App (generate a new key on GitHub, drop the
  file, reload, revoke the old key on GitHub). Every App supports two active keys during the
  overlap. Changing key files requires a +SU `key.change` audit event (SR-10).
- Hosted (Phase 3): the keys go into KMS. App JWTs are signed by KMS, and the key never enters
  process memory (SR-34).
- Compromise impact after the split: a leaked **PR App** key can open PRs and comment upstream,
  but can't push or merge. A leaked **push App** key can write to the fork's branches, which
  only reach upstream through a PR the owner must review and merge (G3). Neither key alone can
  change the default branch. A leaked **repo App** key can push branches, open PRs, and
  **merge any PR whose latest commit a human has approved** (S1-F S2). It can't write the
  default branch directly, merge before that approval, or weaken the ruleset (S1-F items 8 to
  10). This is the private-repo residual risk (§1.9).

### 1.6 Areas S1 Did Not Test: S1-F Results

S1 used public repos owned by personal accounts. Decision 29 (Q1) sent these to Phase 0
follow-ups (`12` §5). S1-F answered them on 2026-11-13 and 2026-11-14:

1. **Private upstream with a private fork: fails for the design (P1).** The fork can be created
   and the push App writes to it, but the PR App's PR from it returns 422. The push App can't
   create the fork (P7). Disposition: private forks are dropped; private repos use §1.9.
2. **Org fork policy (P2).** Turning off "allow forking of private repositories" refuses new
   forks (403) but leaves existing forks intact and writable, so the policy is not a stale-fork
   check. Disposition: moot with private forks dropped.
3. **Private-repo "send secrets / write tokens to fork PR workflows" (P4).** Readable only with
   the owner's credential, at org and repo level (the org setting caps the repo). Disposition:
   moot; the `doctor` checks are dropped (§1.3).
4. **"Require approval for all external contributors" (P3).** It does **not** hold App-authored
   fork PRs (§1.7). Disposition: approval settings stay out of the control set.
5. **Other `pull_requests: write` capabilities (P6).** Under a required-review ruleset with no
   bypass actors, `update-branch` is 403, self-approval is 422, and close and reopen leave the
   PR `REVIEW_REQUIRED` / `BLOCKED` with merge still 403. None bypasses required review. ST-48
   passes for the full PR-App set (§1.2).
6. **A ruleset requiring review before *humans* merge bot PRs.** For public repos this stays a
   setup recommendation, outside soren-loop's enforcement. For private repos it is the control
   and is checked (§1.9).

### 1.7 F1: The Fork PR Approval Gate Is Not a Control (Public Repos)

The CI run on S1's App-authored fork PR started immediately under `first_time_contributors`.
S1-F confirmed this under the strictest public setting, `all_external_contributors` (P3): the
run started at once, with no approval, and completed. `pull_request` runs use the **PR's
version** of the workflow files. The push App can't write workflows (fact 2), but any human or
other credential with push access to the fork bypasses that. Such a person could change
workflows that then run in upstream CI, with no secrets and a read-only `GITHUB_TOKEN`. Hence:

- The fork must be **bot-only**, and `doctor` enforces that (§1.3).
- `doctor` keeps **blocking** `pull_request_target` and `workflow_run` workflows that check out
  PR heads. Those are the triggers that do get secrets.
- The SR-04 deny-list on `.github/**` stays, as defense in depth behind GitHub's own rejection.

### 1.8 Option B (Same-Repo Branch Plus Rulesets): Rejected for Public Repos, the Model for Private Repos

Rejected for public repos by decision 24. It would need upstream `contents: write`, which S1's
control merge showed grants merge. Same-repo PRs also receive secrets (S1 Q4), and safety would
depend on rulesets the owner configures and soren-loop can only check. The fork model gives the
stronger guarantee: no merge-capable credential and no secrets in fork-PR CI.

For private repos, S1-F P1 rules the fork model out. Decision 29 (Q1) had kept Option B as an
opt-in, off by default, for orgs that forbid private forks. Decision 37 (2026-11-14,
S1-F) replaces that: Option B, framed as the Dependabot model, is **the** model for every
private repo. It is not an opt-in, and there is no private-fork path to opt out to. §1.9
specifies it.

### 1.9 Same-Repo Model for Private Repos (decision 37, S1-F)

**Flow.** The repo App, installed on the owner's private repo, mints the `submit` push token
(§1.4). The CLI pushes the chain branch `soren-loop/<public_ref>/<chain>` to the repo itself.
The server re-checks the diff and opens the PR with the repo App, and a repo member reviews and
merges it (G3). S1-F item 7 showed the App can do each step (branch 201, commit 201, PR 201).
Everything else in this RFC (SR-04, SR-41 head pinning, branch chains, deploy matching) is
unchanged; "the fork" reads as "the repo's `soren-loop/*` branches".

**The control is two rulesets.** First, a default-branch ruleset with no bypass actors:

| Rule | Setting |
|------|---------|
| `pull_request` | 1 approving review; dismiss stale reviews on push; `require_last_push_approval` |
| `deletion` | On |
| `non_fast_forward` | On |
| Bypass list | Empty |

S1-F showed it holds against the App (S1): a direct write to `main` is 409 or rejected (item
8); a self-approval is 422; a merge before a human approves the App's latest commit is 405,
including after a late bot push following an approval (item 9); the App can't delete or disable
the ruleset (403, item 10) or write `.github/workflows/*` (403, item 11).

Second, a **branch-confinement ruleset** (owner decision 2026-11-14, S1-F S7), because without it the
App and its push token can create and update any non-default branch (S1-F item 14a):

| Rule | Setting |
|------|---------|
| Target | `~ALL`, excluding `refs/heads/soren-loop/**` and `~DEFAULT_BRANCH` |
| Rules | `creation`, `update`, `deletion` |
| Bypass list | Exactly the built-in repository roles write (4), maintain (2) and admin (5); nothing else, never an `Integration` |

With it, the App's `feature/*` create is 422, an update is 409 and a `git push` to `release/*` is
rejected (GH013), while `soren-loop/*` branches and the owner still work (S1-F items 14b and 16).
Human writers keep working through the role bypass (GitHub's documented behaviour; S1-F had no
non-admin account to show it). The role IDs are undocumented and not sequential: write is 4, not 3.

**Checks.**

- **Start-up check (S4, S9).** The repo App can read both rulesets' rules with its own token
  (`GET /repos/{r}/rules/branches/{branch}`, `GET /repos/{r}/rulesets/{id}`, 200), but **not their
  bypass lists**: GitHub omits `bypass_actors` without Administration access. It does report
  `current_user_can_bypass` for the App itself (`"never"`, or `"always"` once the App is a bypass
  actor). So the §1.4a check confirms every rule above and `current_user_can_bypass: "never"` on both
  rulesets, at start and hourly, and fails closed for that binding.
- **`doctor`** checks what only the owner's credential can see: the default-branch ruleset's bypass
  list is empty and the confinement ruleset's is exactly roles 4, 2 and 5. It also runs the
  CI-secrets rule below and the `pull_request_target` / `workflow_run` scan from §1.3.
- **Visibility.** The binding's model is fixed by the repo's visibility when it is bound. The
  start-up check also compares the repo's current `private` flag with the binding's model and
  fails closed on a mismatch (`13` T35, confirmed by the owner 2026-11-14).

**CI secrets before review (S5).** Same-repo PR CI receives repo secrets before any human has
looked at the agent's code (S1-F item 12, `probe_present=true`). GitHub gives Dependabot's own
PRs fork-like treatment; a third-party App's PRs don't get it. So `doctor` **refuses to run**
for a private-repo binding unless every workflow that runs on `pull_request` either references
no secrets, or references them only inside jobs bound to an environment with required
reviewers. Workflows triggered by `push` on `soren-loop/**` branches get the same treatment
(they run with repo secrets too: S1-F item 13 saw `probe_present=true` on the App's push; `13` T33).

**soren-loop never calls merge (S2).** Once a human approves the App's latest commit, the App's
own merge call succeeds (S1-F item 9b, 200). GitHub can't enforce "a human presses merge". The
only things standing in the way are soren-loop's code, which has no merge call, and the
protection of the repo App's key and of the 1 h push token (both carry `contents: write`). A
lint rule keeps `PUT /pulls/{n}/merge` and `POST /merges` out of the codebase. A merge whose
merger is `soren-loop-repo[bot]` raises the locked `owner.bot_merged_pr` alert and blocks enablement (confirmed;
needs a `03` row 25 guard, `13` T34). This is the residual R5/T10.1 risk for private repos,
rated **H** again for them (it was L under the fork model).

**Settled review reads (S3).** Right after a push, GitHub can still report `reviewDecision:
APPROVED` and a `CLEAN` merge state while the merge is already refused. In a second run, read
30 seconds after the same kind of push, the PR reported `REVIEW_REQUIRED` / `BLOCKED`. So no state-machine transition takes
`reviewDecision` or the merge state as input; review state comes from `pull_request_review`
webhooks (`03` row 24) and merges from `pull_request` `closed` events (row 25). Anything that
displays those fields re-reads them after the latest `synchronize` has settled. The settle time
is **UNVERIFIED** beyond the one observation (stale at once, correct after 30 s).

**PR note.** The PR body carries a visible "same-repo mode" note, so a reviewer knows the CI
on this PR ran with secrets and that approving the latest commit makes the PR mergeable by the
App.

## 2. Deploy Detection

**Default: GitHub `deployment_status`.** Ingestion verifies `X-Hub-Signature-256` over the raw
bytes, routes the delivery by `installation.id`, persists it, and returns `202` well inside
GitHub's 10 s timeout. **Every** verified `success` for the site's production environment is
stored in the **site-scoped** `deployments` table, whatever state the requests are in (Zod M1).

**Matching (Zod D2): one deploy can satisfy many requests.** Each evaluation is a
`deployment_evaluations` row from `GET /repos/{o}/{r}/compare/{merge_sha}...{deploy_sha}`,
made with a `contents: read` token from the PR App (the repo App on private repos). `ahead` or `identical` → `deployment_succeeded`
for that request (`03` row 27). Anything else is logged (ST-13, T10.6).

- **On deployment arrival:** enqueue one evaluation per request currently in `merged` at that
  site.
- **On a request's entry to `merged`:** evaluate only deployments with
  `received_at ≥ merged_at − 10 min`, newest first, and **stop at the first match**. The work is
  bounded, and never all deploys ever.
- Evaluations are idempotent per (deployment, request), and they go through the per-request
  `gh.*` serialization (`04` §5).
- A test: two requests merged before one deploy both enable, with one compare call each.

Where possible, the server also checks that the deployment's creator is the configured deploy
actor.

### 2.1 Signed Deploy Webhook (Postel M7: Standard Webhooks)

`POST /v1/webhooks/deploy/{site_id}` from the owner's CD. The body is `{environment, sha}`,
where `sha` is 40 lowercase hex characters.

- **Headers:** `webhook-id` (the event ID), `webhook-timestamp` (Unix seconds), and
  `webhook-signature: v1,<base64(HMAC-SHA256(secret, id + "." + timestamp + "." + body))>`.
  Several signatures can be listed, space-separated, so a secret can be rotated: two secrets
  are valid during the overlap.
- **Secrets** use the `whsec_<base64>` format that the Standard Webhooks reference libraries
  decode (Postel d6).
- **Responses:**
  - `202` when accepted;
  - `200` for a duplicate `webhook-id`;
  - `400` for a timestamp more than 5 minutes off;
  - **one uniform `401`** for a bad signature *or* an unknown `site_id`, so sites can't be
    enumerated;
  - `202` for a non-production `environment`, which is logged and then ignored.

  Every body is a problem document with no detail. Ancestry is still checked through the compare
  API.
- **Reuse:** the Phase 2 outbound `webhook` channel (`14` §6) uses this exact scheme.

### 2.2 Manual Fallback

`soren-loop mark-deployed <id> --sha <sha>` is an owner CLI action. Ancestry is checked, and an
audit row is written.

**Alternative.** Poll the host's deployment API (Vercel, Netlify, Render, Fly) with
vendor-specific adapters. Rejected for V1: too many adapters, and which hosts emit GitHub
deployments by default is **UNVERIFIED**.

**Second-order cost.** Hosts that never emit deployments leave requests in `merged`. Mitigation:
the 7-day `deploy_wait_exceeded` alert, setup docs for the deploy webhook, and the
`requests_in_merged_age_days` metric (R7).

**Enablement after deploy.** With `enablement_mode = auto`, `deployed{queued}` writes the flag.
Under `dashboard_confirm`, or under `merger_must_be_owner_login` when the merger isn't the
owner's login, the request waits in `deployed{awaiting_confirm}` until the owner confirms with
+SU (`03` rows 25, 27, 42; decision 29, Q2). The requester sees `shipping` throughout.
