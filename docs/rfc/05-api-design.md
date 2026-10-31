# 05. API Design, Versioning, Rollout, and Deprecation

**Layer: surface design**, over REST and JSON on HTTPS. The machine-readable registries (error
codes, the `suggested_action` enum, the step-up `action` enum, the event→route table, the
idempotency exemptions, the widget JWT schema, and the CLI result schema) all live in
`@sorenai/loop-schema`. The CLI's own contract (exit codes, JSON output) is in `07` §2. Webhook
signing is in `08` §2.1. Postel's review is folded in, and finding IDs are cited inline.

## 1. Surfaces

| Group | Host | Auth | Consumers |
|-------|------|------|-----------|
| `GET /v1/meta` | API host: the full document. Widget host: `{api_version}` only (Postel d5). | None; cacheable | CLI, SDKs (Postel M3) |
| `/v1/widget/*` | Widget host | Host JWT (`sl.widget_jwt.v1`, `06` §1.1) → session bearer in iframe memory | Widget iframe |
| `/v1/owner/*` | Dashboard/API host | `__Host-` session only; CSRF token; exact `Origin`; `Sec-Fetch-Site: same-origin` (SR-29); +SU per action (SR-35) | Dashboard SPA |
| `/v1/cli/*` | Dashboard/API host | CLI bearer (device flow) | Owner CLI |
| `/v1/webhooks/github`, `/v1/webhooks/deploy/{site_id}` | Dashboard/API host | GitHub HMAC; Standard Webhooks (`08` §2.1) | GitHub, owner CD |
| `/internal/flagd/*`, `/metrics` | Internal listener only | Network restriction (S4) | flagd, Prometheus |

The widget host serves only the iframe app, the versioned loader (`/loader/v1.x.y.js`, with
SRI), and `/v1/widget/*` (T1.4).

### 1.1 Widget

| Route | Contract |
|-------|----------|
| `POST /v1/widget/sessions` | → `{session_token, expires_at, expires_in}`. On `401 widget_session_expired`, the widget calls `getToken()` once and re-exchanges. Any other auth failure is a generic `401 widget_auth_failed` (Postel M5). The specific reason (`aud_mismatch`, `iss_unknown`, `kid_unknown`, `typ_missing`, `alg_disallowed`, `exp_too_long`, `expired`, `jti_replay`, `bad_signature`) is recorded against `trace_id` for the owner, never sent to the widget (Postel D-M4). Exempt from idempotency keys. |
| `POST /v1/widget/requests` | `sl.request.v1` fields (or `draft_id`) → `{request_id, stage: "received"}`, whether or not the request is held or throttled |
| `GET /v1/widget/requests`, `GET /v1/widget/requests/{id}` | `{request_id, stage, stage_since, question}` (ST-18 snapshot) |
| `POST …/{id}/reply`, `POST …/{id}/withdraw` | Before merge, `withdraw` closes the request. After merge, it is an opt-out (`03` rows 33 and 43). The widget shows the same confirmation in both cases. |
| `POST /v1/widget/drafts`, `…/turns` | LLM mode (Phase 2, SR-30) |

### 1.2 Owner

| Route | Contract |
|-------|----------|
| `GET /v1/owner/requests?state=&cursor=`, `GET …/{id}` | List envelope (§5); detail includes revisions, specs, review aids, prechecks (offsets only), transitions, `request_prs`, and `version`, plus `ETag: "<version>"` (Postel d4) |
| `POST /v1/owner/stepup/options` | `{action, targets: [{type, id}], content_hash}` → `{challenge_id, publicKey}`. `action` comes from the `04` §3.4 enum, and `type` ∈ `request`, `site`, `verdict`, `owner`, `outbox`. The server recomputes `content_hash` and refuses a mismatch (Postel M1). |
| Every +SU route | The body is `{…payload, stepup: {challenge_id, assertion}}`, the same shape everywhere |
| `POST …/requests/{id}/approve-request` · `/approve-spec` · `/rework` · `/confirm-enablement` · `/rollout` · `/restore` | +SU actions (`03`) |
| `POST …/requests/{id}/holds/{verdict_id}/clear` (+SU) · `/retry` | Hold console |
| `POST …/requests/{id}/reject` · `/plan-feedback` · `/ask-requester` · `/park` · `/retry` · `/kill` · `/retire` · `/cancel-run` | Non-+SU. Each requires `If-Match: "<version>"`. A stale version returns `412 precondition_failed`, and a missing one returns `428 precondition_required` (`refetch_and_retry`); both release the idempotency lock (Postel M2, d4). `…/decline-enablement` (`03` row 48) is in this group. |
| `POST /v1/owner/requests/bulk-reject` | +SU over an enumerated ID set (SR-35) |
| `POST /v1/owner/outbox/{id}/retry` | `retry_effect` (`03` row 38) |
| `PUT /v1/owner/sites/{id}/config/{setting}` | +SU over `sl:site_config:v1` with `base_version`. `setting` ∈ `path_policy`, `jwks`, `trusted_commit`, `smtp`, `flag_credentials`, `enablement_mode`, `requester_email`, `flag_fixture_path` (ST-77). A stale version returns `409` with `current_version`. |
| `GET` · `PUT /v1/owner/sites/{id}/notification-policy`; `POST …/notification-policy/reset` | PUT body `{base_version, override, stepup}`. A stale version returns `409 policy_version_conflict` with `{current_version, effective}`. The reset is a POST, not a DELETE with a body (Postel m2). |
| `GET /v1/owner/sites/{id}/notifications?status=suppressed`, `GET /v1/owner/inbox`, `POST …/inbox/{id}/read` | `14` §4 |
| `PUT /v1/owner/contact` | +SU; notifies the old address (`14` §4.1) |
| `GET /v1/owner/cli-tokens`, `DELETE …/cli-tokens/{tok_id}`, `POST …/cli-tokens/revoke-all` (+SU) | There is no collection DELETE (Postel m7) |
| `POST /v1/owner/device/approve` | +SU, shows client context (T7.1) |
| `POST /v1/owner/sites/{id}/widget-token/check` | `{token}` → `{valid, reason}`: the same verifier, and the reason enum above. Requires the owner session and `Sec-Fetch-Site: same-origin`; rate-limited; never consumes a `jti` or creates a session; rejects other sites' tokens; logs only a token hash (SR-07, ST-79; rated L/L). `doctor` uses it for integrators (Postel D-M4). |

### 1.3 CLI

| Route | Contract |
|-------|----------|
| `POST /v1/cli/device/code` · `/device/token` · `/token/refresh` | RFC 8628 shape, rotating refresh. Exempt from idempotency keys. |
| `GET /v1/cli/keys` | Authenticator keys, RP ID, origin (SR-19) |
| `GET /v1/cli/work?ready_for=` | `{data, truncated, total}`, unpaginated and bounded at 200 (Postel m4) |
| `GET /v1/cli/requests/{id}?fields=` | Hash inputs and receipts are **always** included, whatever `fields` says (m4) |
| `POST /v1/cli/requests/{id}/fetch-token` | **Fallback only** (T24, rated H inherent). The default is the owner's own git credential, used only to fetch the exact upstream URL (`07` §1.1). Minting requires a **DPoP-bound** CLI token and a live lease or `owner_approved`/`plan_approved`, one per run, 1 h, audited; it never reaches the sandbox (SR-09, SR-28c, ST-75). |
| `POST /v1/cli/requests/{id}/prechecks` | PC-A, PC-B (also `--recheck`), PC-C records |
| `POST /v1/cli/requests/{id}/runs` | Claim a lease (§1.4) |
| `POST /v1/cli/runs/{run_id}/heartbeat` · `/spec` · `/rate-limited` · `/stopped` · `/checks-passed` | Run lifecycle |
| `POST /v1/cli/runs/{run_id}/push-token` | `{head_sha, replace?: bool}`. Exempt from idempotency keys. Storage, repeat, and replacement rules: `04` §5 (SR-09). |
| `POST /v1/cli/runs/{run_id}/submit` | `{head_sha, risk_summary}` → `202`, with the state moving to `building{submitting}`. The CLI then **waits** for the outcome (`07` §2.1, Postel D-M3). |
| `POST /v1/cli/requests/{id}/mark-deployed` | `{environment, sha}`, audited |

### 1.4 Run Lease (Postel M9)

`POST /runs` → `{run_id, lease_id, lease_expires_at, lease_ttl_seconds: 900,
heartbeat_interval_seconds: 60}`. A heartbeat returns `{lease_expires_at, cancel_requested}`.
`409 lease_lost` (`suggested_action: abort`) means the CLI kills the agent and exits 11. A laptop
that sleeps past the TTL loses the lease, and `--resume` on the preserved tree recovers it
(`07` §1.2).

## 2. Error Envelope (Postel B1)

RFC 9457, `Content-Type: application/problem+json`, on every surface:

```json
{ "type": "https://loop.sorenai.dev/errors/precheck_record_missing",
  "title": "Pre-check record missing", "status": 409,
  "detail": "No PC-B record for H_spec 9f2c…e1 at base 4a1e…77.",
  "code": "precheck_record_missing",
  "suggested_action": "run_command",
  "next": [{ "argv": ["soren-loop", "build", "req_8Hk2QxZ3mN0pL7wR4tY6uV"], "reason": "re-runs PC-C" }],
  "trace_id": "trc_9c1d…", "subject": { "type": "request", "id": "req_8Hk2QxZ3mN0pL7wR4tY6uV" },
  "retry_after_seconds": null, "limit_type": null, "allowed_actions": null,
  "current_state": null, "invalid_params": [] }
```

- `type` is a stable identifier. It doesn't need to resolve for offline self-hosters. `code` is
  the last path segment of `type`.
- `suggested_action` is a closed enum: `retry`, `retry_with_backoff`, `refetch_and_retry`,
  `fix_arguments_and_retry`, `re_authenticate`, `upgrade_cli`, `run_command`,
  `owner_action_required`, `abort`.
- `next[].argv` always carries **full** IDs.
- `trace_id` equals the `X-Request-Id` header. The domain object is `subject`, never
  `request_id` (rule 5).
- `invalid_params[]` is `{name, pointer, reason}`.
- On `409 invalid_transition`, the error carries `current_state` and `allowed_actions:
  [{event, method, path, requires_stepup}]`, taken from the event→route table in `loop-schema`
  (Postel M2).
- `429` carries `retry_after_seconds` and `limit_type`.
- `allowed_actions[].path` is **concrete**, with IDs filled in (Postel d4).
- **Widget restrictions (Postel m5, SR-40b):** the widget gets only `limit_reached`,
  `widget_session_expired`, `widget_auth_failed`, `invalid_request` (renamed from
  `invalid_params` to avoid colliding with the envelope member, Postel d7), and `not_found`.
  Every `limit_reached` (a cap, a paused site, the intake budget) has an identical body and
  headers and `retry_after_seconds: null` (confirmed by Sentinel), so it is not an oracle. No widget response mentions holds,
  flags, repos, or reasons.

## 3. Idempotency (Postel B2)

The full contract is in `04` §5. In summary: every mutating route requires `Idempotency-Key`
(UUIDv7), except the exempt routes listed in `loop-schema`. The scope is
`(principal, route template)`, and that scope survives token refresh. Only `2xx` and final `4xx`
responses are stored. `409`, `412`, `429`, and `5xx` release the lock row. The CLI persists one
key per logical operation in `~/.soren-loop/ops/` (`07` §2). WebAuthn routes are single-use by
challenge. GitHub webhooks dedup on `X-GitHub-Delivery`, and the deploy webhook dedups on
`webhook-id`.

## 4. Versioning, Rollout, and Deprecation

| Contract | Versioning |
|----------|------------|
| HTTP `/v1/*` | URL major. Additive changes stay within `v1`. |
| `@sorenai/loop-schema` (schemas, hashes, vectors, enums) | semver. Changing a test vector is a major release **and** a new hash prefix (`04` §3.5). |
| `@sorenai/loop-node`, `-react`, the loader | semver. Immutable loader URLs. |
| `FlagWriter` | `FLAG_WRITER_API = 1`, treated as public (`16` §1) |
| CLI flags, exit codes, `sl.cli.result.v1` | ≥ 1 CLI major deprecation window |
| Vendored outcome `schema_version` | Pinned. An unknown version counts as a missing outcome (`15` §4). |

**Breaking changes** (the rubric):
- a new required request field, or a tightened request enum;
- a changed default;
- a removed or renamed response field, or a renamed `code`;
- any change to hashing or challenge derivation;
- a new **requester stage** (this also needs a security review).

**Response enums are open; request enums are closed (Postel M4).** `loop-schema` exports
`openEnum()`, which yields a known value or `{unknown: string}`. Clients MUST:
- fall back on the status class plus `suggested_action` for an unknown `code`;
- render an unknown stage as "in progress";
- ignore unknown `channel`, `limit_type`, and outbox `status` values.

Adding a response enum value is a **minor** change, conditional on this fallback rule.

**Negotiation (Postel M3).** `GET /v1/meta` → `{server_version, api_version, min_cli,
unicode_version, hash_prefixes: [...], outcome_schema_versions: [1], capabilities: ["receipts",
"notification_policy", "fetch_token", ...]}`.
- The CLI gates features on `capabilities`, never by comparing versions. A missing capability
  is exit 13 with `server_too_old`.
- Below `min_cli`, the CLI exits 13 with `cli_too_old`.
- **Compatibility promise:** CLI major N works with every `v1` server release still inside its
  deprecation window.
- The CLI sends `User-Agent: soren-loop-cli/<ver> (node/<v>; <os>)` and `X-SL-CLI-Version`.

**Rollout.** Behaviour changes ship behind site config that defaults to the old behaviour for
one minor release. Migrations are expand/contract (`10` §4).

**Deprecation.** The lifecycle is `active` → `deprecated` (`Deprecation` and `Sunset` headers,
RFC 9745 and RFC 8594, plus a CLI stderr warning) → `removed`. HTTP routes get ≥ 2 server minor
releases, and CLI surfaces get ≥ 1 CLI major. The prerequisite is local per-consumer
telemetry, by route, CLI version, and SDK version (`X-SL-SDK`). It is never phoned home, and
`doctor` reports it.

## 5. Agent-Facing Conventions

- **Lists:** `{data: [...], next_cursor: string | null}`, opaque cursors, `limit ≤ 100`
  (Postel m4).
- **IDs:** typed IDs are first-class fields, never parsed out of URLs.
- **Time naming (Postel m1):** instants are `*_at` (RFC 3339 UTC), and durations are
  `*_seconds`. `expires_in` exists only in OAuth-shaped token responses. The feed field is
  `stage_since` everywhere, including event payloads and the relay.
- **The CLI's agent surface** (`--output json`, `--agent`, `soren-loop schema`) is `07` §2.
