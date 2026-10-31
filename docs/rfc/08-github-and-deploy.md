# 08. Deep Dives: GitHub Fork Model and Deploy Detection

Flags (`FlagWriter`, flagd, Unleash, the OFREP contract) are in `16-flags.md`.

## 1. ADR-4: Fork Model with Two GitHub Apps (decisions 7, 24, 25)

**Status: Accepted.** S1 passed every question (`docs/discovery/spikes/S1-fork-pr-permissions.md`).
Decision 24 keeps the fork model and rejects Option B. Decision 25 splits GitHub access into two
Apps.

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
two Apps, **no upstream credential can merge, whatever the minting code does.**

### 1.1 The Two Apps

| | **PR App** (`soren-loop-pr`) | **Push App** (`soren-loop-push`) |
|-|--------------------------------|------------------------------------|
| Installed on | The upstream repo only (`repository_selection: selected`) | The bot-only fork only |
| Permissions | `pull_requests: write`, `metadata: read` (decision 25), plus the read-only and optional additions in §1.2 | `contents: write`, `metadata: read` |
| **Never** | `contents: write`, `workflows`, `administration`, `secrets`, `actions` | `workflows`, `pull_requests`, `administration`, or any upstream installation |
| Used for | Opening PRs, labels, receiving webhooks, the optional issue projection, ancestry checks | Minting the single-use push token for `submit`; the server's compare re-check of the pushed branch |
| Webhooks | On: `pull_request` (including `synchronize`, for SR-41 head pinning), `pull_request_review`, `deployment_status`, `installation`, `installation_repositories` | Off (no webhook URL) |
| Who uses its key | The outbox workers | Only the token-minting service (`POST /v1/cli/runs/{id}/push-token`) and the compare re-check |
| Bot identity | `soren-loop-pr[bot]` authors the PR | `soren-loop-push[bot]` authors the commits pushed to the fork |

### 1.2 PR App Permissions Beyond Decision 25 (decision 26)

Decision 25 lists `pull_requests: write` and `metadata: read`. Three existing features need
more from the upstream installation. None of these grants push or merge.

| Addition | Needed for | If not granted |
|----------|-----------|----------------|
| `contents: read` | The ancestry check before `deployed`: `GET /compare/{merge_sha}...{deploy_sha}` reads commits (SR-08, T10.6) | The ancestry check can't run, so a deploy can't be verified. Not acceptable. |
| `deployments: read` | Receiving `deployment_status` webhooks | Only the signed deploy webhook and `mark-deployed` remain (§2) |
| `issues: write` | Issue projection (SR-17), and only when it's turned on | No projection, which is the default for public repos anyway |

`contents: read` is the one to watch. S1 showed that `contents: write` grants merge. It didn't
test `contents: read` together with `pull_requests: write`. That this combination still gets
403 on merge is **UNVERIFIED**. ST-48 tests it with the PR App's full installed set, against a
sandbox org, before Phase 1 exits. SR-08 now names this exact set. The backend start-up check
(§1.4a) and `doctor` both **fail on `contents: write`**, and on any permission outside the set
above. Decision 26 accepts this set.

### 1.3 Owner Setup

1. **Create a bot-only fork owner.** This is a dedicated GitHub organization (decision 29, Q15), such as `<owner>-soren-loop-bot`. It must have no human members with push
   access (F1, below). The owner may be the org's sole owner, but **must not push to the fork**.
2. **Register both Apps** from the dashboard setup wizard, using the GitHub manifest flow twice.
   The manifests are `github/pr-app.manifest.json` and `github/push-app.manifest.json` in
   Repo 1, under CODEOWNERS and a security-review label (SC8). The push App is registered
   under the bot org, and the PR App under the owner's account or org.
3. **Install.** The PR App goes on the upstream repo only. The push App goes on the bot org,
   limited to the fork repo. The wizard creates the fork with the push App (or guides the owner
   to fork into the bot org) and records both installation IDs.
4. **Keys.** The manifest conversion returns each App's private key once. In `--setup` mode
   only, the server writes the keys to `SL_SECRETS_DIR/github-pr-app.pem` and
   `SL_SECRETS_DIR/github-push-app.pem` with mode `0400`. It never stores or returns them
   again (§1.5). The setup role then exits, and the normal `web` and `worker` roles mount the
   directory read-only.
5. **`doctor` checks**, which block builds until they pass:
   - The PR App's installed permissions are inside §1.2, and it has no `contents` permission
     above read.
   - The push App's installation covers exactly one repo, the fork, and the push App has no
     installation on upstream.
   - The fork's collaborators and teams have no human push access (F1).
   - `maintainer_can_modify` is false on any open soren-loop PR (F4).
   - No `pull_request_target` or `workflow_run` workflow checks out a PR head (SR-08, T10.3, F1).
   - For private repos, the private-fork policy, and "send secrets / write tokens to fork PR
     workflows" is off (an untested area, §1.6).

### 1.4a Backend Start-Up Check (SR-08, T10.12)

`doctor` runs on the owner's machine, and only when invoked. The server must not depend on it.
So at every start, and hourly after that, the `web` and `worker` roles each mint an App JWT for
both Apps and call `GET /app` and `GET /app/installations`, plus
`GET /installation/repositories` per installation. They compare the result with the expected
manifest:

- the PR App's permissions are exactly the SR-08 set, with no `contents: write`;
- the push App's permissions are exactly `contents: write` and `metadata: read`;
- the PR App is installed only on the bound upstream repo, and the push App only on the fork;
- neither App holds `workflows`, `administration`, `secrets`, or `actions`.

**Anything extra fails closed.** The server refuses to boot. If the extra permission appears at
runtime, the server stops minting tokens for that App, marks the GitHub outbox effects
`blocked_config`, and sends the owner one alert. A missing permission degrades only the feature
that needs it. The check is about not holding more than it should (ST-48).

### 1.4 Token Minting and PR Creation

| Operation | App | Mint request | Lifetime |
|-----------|-----|--------------|----------|
| Open PR, label, project issue | PR App | `repositories: [upstream]`, `permissions: {pull_requests: write, metadata: read}` (plus `issues: write` for projection) | Minted per effect, 1 h, never leaves the worker |
| Ancestry compare | PR App | `{contents: read, metadata: read}`, upstream | Per call |
| CLI fetch of a private upstream (`07` §1.1), **fallback only** | PR App | `{contents: read, metadata: read}`, upstream, via the CLI-owned `GIT_ASKPASS` | 1 h, one per run, audited; requires a DPoP-bound CLI token (SR-09, T24, ST-75). The default uses the owner's own git credential, so nothing is minted. |
| CLI fetch of a recorded rework head SHA (`07` §1.4) | Push App | **down-scoped at mint** to `{contents: read, metadata: read}`, fork | 1 h, one per run, audited (Zod m5) |
| Push for `submit` | Push App | `repositories: [fork]`, `{contents: write, metadata: read}` | One per run (at most one `replace`), 1 h. Stored encrypted only until expiry, for revocation, and never returned again. The CLI revokes it after the push, and the server revokes any leftover when the request leaves `building` (SR-09). |
| Compare re-check of the pushed branch | Push App | `{contents: read, metadata: read}`, fork | Per call |

- **F3:** any mint response other than **201** is a hard error. That includes a 422 from an
  over-grant or a wrong repo. The server records an audit event, sets the outbox effect to
  `dead` (or refuses the CLI request with `code: token_mint_failed`), and never retries with a
  broader scope.
- **F4:** `POST /pulls` always sends `maintainer_can_modify: false`, so upstream maintainers
  can't push onto the bot's branch, and the branch content stays attributable to the pipeline.
- **SR-41 head pinning.** When the PR is opened or updated, the server records `pinned_head_sha`
  in `request_prs`. A `synchronize` event or fork head that matches neither the pin nor the
  in-flight run's declared `expected_head` moves the request to `stalled{head_tampered}`, adds
  `soren-loop:do-not-merge`, and raises the locked `owner.pr_head_changed` (`03` row 47). A
  merge of a superseded PR raises the same locked kind (row 46).
- The PR head is `<bot-org>:soren-loop/<public_ref>/<chain>`. `public_ref` is a separate opaque random
  ID that can't be linked to the widget `request_id` (SR-40a). On a public repo, a requester can
  then never find their own PR, diff, or risk summary. S1 showed that the upstream token needs no
  fork access to name a public fork as the head. Whether that holds for a **private** fork is
  **UNVERIFIED** (§1.6).
- Tokens are never minted inside the sandbox.

### 1.5 Key Storage (SR-14)

- Two separate files under `SL_SECRETS_DIR`: mode `0400`, owned by the server's user, on a
  volume separate from Postgres. Never in the DB, environment variables, logs, or backups made
  by `pg_dump`.
- Each key is loaded into its own signer module. Only the minting service imports the push
  App's signer, and a lint rule enforces this. A bug elsewhere then can't mint push tokens.
- Rotation: the dashboard gives the steps for each App (generate a new key on GitHub, drop the
  file, reload, revoke the old key on GitHub). Both Apps support two active keys during the
  overlap. Changing key files requires a +SU `key.change` audit event (SR-10).
- Hosted (Phase 3): both keys go into KMS. App JWTs are signed by KMS, and the key never enters
  process memory (SR-34).
- Compromise impact after the split: a leaked **PR App** key can open PRs and comment upstream,
  but can't push or merge. A leaked **push App** key can write to the fork's branches, which
  only reach upstream through a PR the owner must review and merge (G3). Neither key alone can
  change the default branch.

### 1.6 Areas S1 Did Not Test

S1 used public repos owned by personal accounts. These go into Phase 0 follow-ups (`12` §5), as
decision 29 (Q1) requires:

1. A private upstream with a private fork. This includes whether a private fork can be created
   in the bot org, and whether the PR App can name a private fork as the head without access to
   it.
2. Org fork policies ("allow forking of private repositories").
3. For private repos, the settings for sending secrets and write tokens to fork-PR workflows.
   `doctor` must verify both are off.
4. Whether the stricter "require approval for all external contributors" setting holds
   App-authored fork PRs. Under the `first_time_contributors` setting, the fork PR's CI started
   without approval (F1).
5. Other `pull_requests: write` capabilities upstream: `update-branch`, an App approving its own
   PR, close and reopen. None should bypass required review; to be confirmed.
6. Whether owners still need a ruleset requiring review before *humans* merge bot PRs. This is
   recommended in the setup docs, but outside soren-loop's enforcement.

### 1.7 F1: The Fork PR Approval Gate Is Not a Control

The CI run on S1's App-authored fork PR started immediately under `first_time_contributors`.
`pull_request` runs use the **PR's version** of the workflow files. The push App can't write
workflows (fact 2), but any human or other credential with push access to the fork bypasses that.
Such a person could change workflows that then run in upstream CI, with no secrets and a
read-only `GITHUB_TOKEN`. Hence:

- The fork must be **bot-only**, and `doctor` enforces that (§1.3).
- `doctor` keeps **blocking** `pull_request_target` and `workflow_run` workflows that check out
  PR heads. Those are the triggers that do get secrets.
- The SR-04 deny-list on `.github/**` stays, as defense in depth behind GitHub's own rejection.

### 1.8 Rejected Alternative: Same-Repo Branch Plus Rulesets (Option B)

Rejected by decision 24. It would need upstream `contents: write`, which S1's control merge showed
grants merge. Same-repo PRs also receive secrets (S1 Q4), and safety would depend on rulesets
the owner configures and soren-loop can't enforce.

**Kept only as an opt-in path for orgs that forbid private forks (decision 29, Q1).** It is off
by default and enabled per repo binding with +SU. `doctor`
refuses to enable it until a default-branch ruleset verifies (PR required, one approving review,
the App not on the bypass list) and `pull_request` workflows on `soren-loop/*` use no secrets.
The PR body carries a visible "same-repo mode" note. This mode gives up the two-App guarantee:
the upstream installation holds `contents: write`, so R5 and T10.1 return to H for those repos.

## 2. Deploy Detection

**Default: GitHub `deployment_status`.** Ingestion verifies `X-Hub-Signature-256` over the raw
bytes, routes the delivery by `installation.id`, persists it, and returns `202` well inside
GitHub's 10 s timeout. **Every** verified `success` for the site's production environment is
stored in the **site-scoped** `deployments` table, whatever state the requests are in (Zod M1).

**Matching (Zod D2): one deploy can satisfy many requests.** Each evaluation is a
`deployment_evaluations` row from `GET /repos/{o}/{r}/compare/{merge_sha}...{deploy_sha}`,
made with the PR App's `contents: read` token. `ahead` or `identical` → `deployment_succeeded`
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
