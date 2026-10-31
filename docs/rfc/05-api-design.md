# 05. API Design, Versioning, Rollout, and Deprecation

**Layer under discussion: surface design**, over REST/JSON with HTTPS as the canonical
transport. SDK ergonomics (`@sorenai/loop-node`, `@sorenai/loop-react`) and the CLI's command
surface are in scope only as consumers. Postel owns the deep contract review: exact schemas,
webhook signing for the deploy webhook, the CLI API, and the structured request schema. This
section fixes the shape Postel reviews.

## 1. Surfaces

There are four route groups, on two hostnames (decision 18):

| Group | Host | Auth | Consumers |
|-------|------|------|-----------|
| `/v1/widget/*` | Widget host | Host JWT → widget session (bearer, iframe memory) | Widget iframe |
| `/v1/owner/*` | Dashboard/API host | `__Host-` session cookie only; CSRF token; exact `Origin`; `Sec-Fetch-Site: same-origin` (SR-29); +SU per action | Dashboard SPA |
| `/v1/cli/*` | Dashboard/API host | CLI access token (device flow), `Authorization: Bearer` | Owner CLI |
| `/v1/webhooks/*`, `/internal/flagd/*` | Dashboard/API host; flagd sync on an internal listener only | GitHub HMAC; deploy-webhook HMAC; flagd sync credential or network restriction (S4) | GitHub, owner CD, flagd |

The widget host serves only the iframe app, the versioned loader (`/loader/v1.x.y.js`, with an
SRI hash in the snippet), and `/v1/widget/*`. No owner route is reachable on it. A routing
test enforces this (T1.4).

### Widget

| Method and path | Purpose | Notes |
|-----------------|---------|-------|
| `POST /v1/widget/sessions` | Exchange a host JWT for a session | ST-10, ST-11; returns `session_token`, `expires_in` (≤ 15 min) |
| `POST /v1/widget/requests` | Submit (form fields, or `draft_id` in LLM mode) | Idempotency key required; PC-S inline; returns `{request_id, stage: "received"}` whatever the hold status |
| `GET /v1/widget/requests` | The requester's own requests | `(site, sub)` scope |
| `GET /v1/widget/requests/{id}` | `{request_id, stage, stage_since, question?}` | Schema-snapshot test on the allowed fields (ST-18) |
| `POST /v1/widget/requests/{id}/reply` | Answer `needs_your_input` | Idempotency key |
| `POST /v1/widget/requests/{id}/withdraw` | Withdraw | Idempotency key |
| `POST /v1/widget/drafts`, `POST /v1/widget/drafts/{id}/turns` | LLM-mode chat (Phase 2) | SR-30 caps; no tools |

### Owner (dashboard)

| Method and path | Purpose |
|-----------------|---------|
| `GET /v1/owner/requests?state=&cursor=` | Queue (cursor pagination; grouped by requester for holds) |
| `GET /v1/owner/requests/{id}` | Detail: revisions with the stripped-character report, specs, review aids, prechecks (spans as offsets), transitions |
| `POST /v1/owner/stepup/options` | `{action, request_id, content_hash}` → WebAuthn options with a derived challenge |
| `POST /v1/owner/requests/{id}/approve-request` | G1 / G1′ with an assertion |
| `POST /v1/owner/requests/{id}/approve-spec` | G2 with an assertion |
| `POST /v1/owner/requests/{id}/reject` · `/plan-feedback` · `/rework-feedback` · `/ask-requester` · `/park` · `/retry` | Non-step-up actions |
| `POST /v1/owner/requests/{id}/holds/{verdict_id}/clear` · `/retry` | Hold console |
| `POST /v1/owner/requests/{id}/rollout` · `/kill` · `/restore` · `/retire` | Flag lifecycle |
| `POST /v1/owner/requesters/{id}/block` · `POST /v1/owner/sites/{id}/intake/pause` | Abuse controls (SR-11) |
| `PUT /v1/owner/sites/{id}/policy` · `/jwks` · `/trusted-commit` · `/flag-credentials` | Step-up config changes (SR-10, A23-6) |
| `GET /v1/owner/sites/{id}/notification-policy` | `{defaults, override, effective, locked: [...], version}` (`14` §2) |
| `PUT` · `DELETE /v1/owner/sites/{id}/notification-policy` | Replace or reset the override; +SU over `H(site_id‖base_version‖JCS(override))`; `409 policy_version_conflict`; `422 policy_unknown_key` / `policy_locked_entry` |
| `GET /v1/owner/sites/{id}/notifications?status=suppressed&kind=&cursor=` | Suppressed log for tuning (`14` §4) |
| `GET /v1/owner/inbox?cursor=`, `POST /v1/owner/inbox/{id}/read` | The dashboard inbox channel |
| `PUT /v1/owner/contact`, `PUT /v1/owner/sites/{id}/smtp` | +SU; notifies the old address (`owner.owner_contact_changed`, `14` §4.1) |
| `GET/DELETE /v1/owner/cli-tokens`, `POST /v1/owner/device/approve` | Token management; device approval with +SU and client context (T7.1) |

### CLI

| Method and path | Purpose |
|-----------------|---------|
| `POST /v1/cli/device/code`, `POST /v1/cli/device/token`, `POST /v1/cli/token/refresh` | Device flow (RFC 8628 shape) with rotating refresh |
| `GET /v1/cli/keys` | Authenticator public keys, RP ID, and origin to pin (SR-19) |
| `GET /v1/cli/work?ready_for=plan,build,rework` | Pull: requests the owner can act on |
| `GET /v1/cli/requests/{id}` | Revision (normalized fields), approvals with receipts, current spec, feedback, policy, flag key |
| `POST /v1/cli/requests/{id}/prechecks` | Post a PC-A, PC-B, or PC-C record |
| `POST /v1/cli/requests/{id}/runs` | Claim a plan or build lease (`start_plan`, `start_build`, `resume`) |
| `POST /v1/cli/runs/{run_id}/heartbeat` · `/spec` · `/rate-limited` · `/stopped` · `/checks-passed` | Run lifecycle |
| `POST /v1/cli/runs/{run_id}/push-token` | Single-use fork push token (state-gated, ST-15) |
| `POST /v1/cli/runs/{run_id}/submit` | `{head_sha, risk_summary}`; the server re-checks via compare |
| `POST /v1/cli/requests/{id}/mark-deployed` | Manual deploy fallback (audited) |

## 2. Error Shape

Every non-2xx response, on every surface:

```json
{
  "error": {
    "code": "precheck_record_missing",
    "message": "No pre-check record for H_spec 9f2c... at base 4a1e....",
    "suggested_action": "Run `soren-loop build req_8Hk2...` again; it runs PC-C before claiming.",
    "request_id": "req_8Hk2...",
    "retry_after_seconds": null,
    "docs": "https://loop.sorenai.dev/errors/precheck_record_missing"
  }
}
```

- `code` is a stable snake_case enum, published in `packages/schema`. Renaming a code is a
  breaking change (§4).
- Rate limits return `429` with `retry_after_seconds` and `limit_type`
  (`per_sub_open_requests`, `per_site_daily`, `intake_llm_monthly`), the semantic rate-limit
  rule.
- **Widget errors are deliberately less specific.** A paused site and an ordinary cap return
  `limit_reached` with the same message. A throttled requester gets no error at all: their
  submissions are shadow-accepted as `received` (A23-8, SR-40b, `03` §3). No widget response
  ever mentions holds, flags, repos, or reasons.
- Every response carries `X-Request-Id`. The owner can look up any request ID in the
  dashboard's trace view.

## 3. Idempotency

- Every mutating endpoint on `/v1/widget`, `/v1/owner`, and `/v1/cli` **requires**
  `Idempotency-Key` (a missing key returns `400 idempotency_key_required`). The SDKs and the
  CLI generate one per logical operation, and a retry reuses it.
- Keys are scoped per principal. The server stores `key → (request_digest, response)` for
  24 h, taking a lock row before processing. The same key with the same body replays the
  response. The same key with a different body returns `422 idempotency_key_reused`.
- WebAuthn-bound endpoints are naturally single-use (the challenge is consumed). The key covers
  network retries of the same assertion.
- Webhooks dedup on `X-GitHub-Delivery` (T10.5). The deploy webhook requires an `event_id`.

## 4. Versioning, Rollout, and Deprecation

The project publishes six contract surfaces with different consumers:

| Contract | Consumers | Versioning |
|----------|-----------|------------|
| HTTP API `/v1/*` | Widget, dashboard (same release), CLI (independent release), owner CD (deploy webhook) | URL major version; additive changes within `v1` |
| `@sorenai/loop-schema` | Server, CLI, SDKs | semver; the CLI pins a compatible major |
| `@sorenai/loop-node`, `@sorenai/loop-react`, widget loader | Host apps | semver; the loader at immutable versioned URLs, never "latest" (SC5) |
| Hash and challenge formats | Server, dashboard, CLI | Domain-separated prefixes (`sl:req:v1`); a new prefix means a new version, and both are verified during the overlap |
| Flag document / `FlagWriter` | flagd, vendors | Internal port; the flagd document format follows flagd's schema |
| Vendored tdd-pair outcome (`schema_version: 1`) | CLI | Pinned by commit; a version bump is a CLI release |

**What counts as breaking**, using the rubric from api-design-principles:

- adding a required request field, or tightening an enum on input;
- changing a default (for example, `issue_projection` default or the throttle threshold);
- removing or renaming a response field, or renaming an error `code`;
- changing hash normalization or challenge derivation (it breaks receipt verification for
  older CLIs);
- adding a **requester stage**. This one is easy to miss: older widgets would render an unknown
  stage, and a new stage could also reintroduce a hold oracle. Stage additions need a security
  review.

**Rollout.**

- The server sends `X-SL-Min-CLI` and `X-SL-API-Version`. The CLI refuses to run below the
  minimum, with `code: cli_too_old` and an upgrade command.
- The CLI sends `X-SL-CLI-Version` on every call. The server keeps per-version request counts
  (the telemetry prerequisite below).
- Server-side behaviour changes ship behind config flags in `sites.config` (for example
  `require_receipts`) that default to the old behaviour for one minor release, then flip.
- DB migrations are expand/contract: add the column, dual-write, backfill, switch reads, drop
  in a later release. No migration both adds and drops in one release (`10` §4).

**Deprecation.**

- Lifecycle: `active` → `deprecated` (responses carry `Deprecation` and `Sunset` headers, RFC
  9745 / RFC 8594) → `removed`. The minimum window is 90 days or two minor releases, whichever
  is longer. Self-hosters upgrade on their own schedule, so the window is measured in releases,
  not wall time.
- **Prerequisite:** nothing is deprecated until per-consumer telemetry exists. That means the
  server's own counters by `X-SL-CLI-Version`, SDK version (from the loader path and the
  `X-SL-SDK` header), and route. The counters are local to each self-hosted install and are
  never phoned home. `doctor` prints the local deprecation report.
- The vendored outcome schema is never deprecated in place. A new upstream `schema_version`
  means a new vendored pin, and the CLI accepts exactly the versions it ships with.

## 5. Agent-Facing Consumers

The CLI is the main programmatic client today, and a future MCP or agent wrapper around the CLI
is plausible. So:

- every list endpoint uses cursor pagination with `limit ≤ 100`;
- responses carry typed IDs as first-class fields, never only inside URLs;
- `GET /v1/cli/requests/{id}` has a `?fields=` projection so an agent can avoid pulling large
  specs into context;
- every `409 invalid_transition` names the current state and the events allowed from it
  (`allowed_events: [...]`), so a client can recover without guessing.
