# Postel Contract Review: soren-loop RFC

**Reviewer:** Postel (contract layer). **Date:** 2026-10-31. **Scope:** contracts only.
Zod covers architecture in parallel. Security hardening beyond contract shape is handed to
Sentinel where noted.

**Inputs:** `rfc/02`–`08`, `rfc/14`, `discovery/00-project-brief.md` (decisions 1–31),
`security/06-requirements-tests-spikes.md`.

## Design Review

**Verdict:** Request Changes. Not ready for task breakdown until B1–B4 land.
**Confidence:** High on B1–B4 and M1–M4. Medium on M6 (OFREP provider behaviour needs S4).

### Layers affected

| Layer | In scope | Why |
|-------|----------|-----|
| Transport | Error media type, webhook signing, version headers | Decision 31 fixed the error-type URIs, but `05` §2 isn't problem+json |
| Surface | `/v1/widget`, `/v1/owner`, `/v1/cli`, `/v1/webhooks` | Idempotency, step-up binding, `allowed_events`, pagination |
| SDK/client | `@sorenai/loop-node`, `-react`, `-schema`, `FlagWriter`, CLI | Hash determinism, OFREP provider fit, exit codes and JSON output |
| Tool definitions | None yet. The CLI *is* the agent surface (`05` §5) | B4 is what a future MCP wrapper would be built on |

### What is already right

Keep these as the pattern for everything else: typed-prefix IDs with 128-bit randomness and no sequential IDs (`04` intro). The idempotency lock row taken *before* the work (`04` §5). That is the crash-window fix. `422` on the same key with a different body (`05` §3). Absolute-semantics `setTargets` (`08` §2.1). Domain-separated hash prefixes (`04` §3). `allowed_events` on `409` (`05` §5). Semantic `limit_type` on `429`. Requester stage additions classified as breaking (`05` §4). That one is easy to miss. `evaluationContext(user)` returning the same ID as the JWT `sub` (`02` table, `packages/node`). The outcome JSON treated as advisory only (`07` §5).

## Blockers

### B1. The error envelope contradicts decision 31 and isn't agent-actionable

**Ref:** `05` §2, brief decision 31.
**Problems:**
- Decision 31 fixes error-type URIs under `https://loop.sorenai.dev/errors/`. `05` §2 instead ships a bespoke `{error:{…, docs}}` wrapper, so every client would parse a one-off shape.
- `suggested_action` is prose ("Run `soren-loop build req_8Hk2...` again…"). An agent can't branch on prose, and it will paste the truncated ID it sees.
- The body's `request_id` holds the *domain* request (`req_…`), while `X-Request-Id` is the *trace* ID. One name for two concepts violates rule 5. An agent that greps logs for the body
  `request_id` won't find the trace.

**Proposed contract.** Use RFC 9457, `Content-Type: application/problem+json`, on every
surface:

```json
{ "type": "https://loop.sorenai.dev/errors/precheck_record_missing",
  "title": "Pre-check record missing", "status": 409,
  "detail": "No PC-B record for H_spec 9f2c…e1 at base 4a1e…77.",
  "code": "precheck_record_missing",
  "suggested_action": "run_command",
  "next": [{ "argv": ["soren-loop","build","req_8Hk2Qx…"], "reason": "re-runs PC-C" }],
  "trace_id": "trc_…", "subject": { "type": "request", "id": "req_8Hk2Qx…" },
  "retry_after_seconds": null, "limit_type": null, "allowed_actions": null,
  "invalid_params": [] }
```

- `type` is an identifier. It must be stable, and it doesn't need to resolve for offline self-hosters. `code` is exactly the last path segment of `type`.
- `suggested_action` is a closed enum published in `loop-schema`: `retry`,
  `retry_with_backoff`, `refetch_and_retry`, `fix_arguments_and_retry`, `re_authenticate`,
  `upgrade_cli`, `run_command`, `owner_action_required`, `abort`.
- `next[].argv` is structured and holds full IDs, never truncated ones.
- `trace_id` equals `X-Request-Id`. Rename the domain field to `subject`.
- `invalid_params[]` uses `{name, pointer, reason}` for validation errors.
- Widget responses use the same envelope, restricted to the codes allowed there (see m5).

### B2. Idempotency contract: scope, key derivation, credential endpoints, cached failures

**Ref:** `05` §3, `04` §2 (`idempotency_keys.scope`), `07` §1.
**Problems:**
1. **Scope drift.** `05` says keys are scoped "per principal", but `04` scopes them
   `widget:<session>` and `cli:<token>`.
   - Widget sessions expire within 15 minutes and CLI access tokens rotate. A retry that spans
     a refresh lands in a new scope and runs twice. The result is a double submit, which also
     burns one of the requester's three open slots.
2. **Deterministic CLI keys.** The CLI derives keys from `(command, request_id, run_id)`.
   - `run_id` doesn't exist before `POST /runs`.
   - A deliberate re-run within 24 h, such as `submit` after the owner fixes the tree (new
     `head_sha`), reuses the key and gets `422 idempotency_key_reused`. That is the most common
     recovery path, and it breaks.
3. **Credential-issuing endpoints.** "Every mutating endpoint requires a key" covers
   `/widget/sessions`, `/cli/device/token`, `/cli/token/refresh` and
   `/runs/{id}/push-token`.
   - Caching their responses stores live credentials in `idempotency_keys.response` for 24 h.
   - A replay of the "single-use" push token contradicts ST-15.
4. **Failure caching.** The spec doesn't say whether failures are cached. If a `5xx`, `409` or `429` is cached, the key is poisoned for 24 h.

**Proposed contract.**
- **Scope.** Key scope is `(principal, route template)`. The widget principal is
  `widget:<site_id>:<sub>`. The CLI principal is `cli:<family_id>` (the refresh family). The owner principal is `owner:<owner_id>`.
- **Key generation.** The CLI generates a UUIDv7 per *logical operation* and persists it in
  `~/.soren-loop/ops/<op>.json` until the operation reaches a terminal response.
  - In-process retries and `--resume` of an interrupted operation reuse the key.
  - A fresh invocation of the same command mints a new key.
- **What is stored.** Only `2xx` and final `4xx` (`400`, `403`, `404`, `422`) responses are stored. A `409`, `429` or `5xx` releases the lock row, and the key can be retried.
- **Exempt endpoints.** These four endpoints are exempt, and the exemption is listed in
  `loop-schema`:
  - `/widget/sessions` and the device-flow token routes are protected by `jti` and refresh-family rotation.
  - `push-token` stores `{token_id, minted_at}` only. A repeat call returns
    `409 push_token_already_minted`.
  - `POST /runs/{id}/push-token {replace: true}` revokes the prior installation token (`DELETE /installation/token`) and mints a new one. It is audited and capped at 2 per run. *Sentinel to confirm the cap and the revocation story.*

### B3. The hash and challenge contract can't yet be implemented identically twice

**Ref:** `04` §3, `06` §4 (hold clear), `14` §5. Receipts are MUST-MVP with no escape hatch
(SR-19), so any ambiguity here surfaces in the field as `receipt_invalid`.
**Problems:**
- `sl.request.v1` lists `fields: {title, problem, acceptance_criteria[], ...}`. The `...` leaves the key set open, and the "where in the app" field has no name.
- Absent vs `null` for `owner_context` and `eligibility_class` changes the JCS bytes, and the spec doesn't say which applies.
- `eligibility_class` is inside `H_req`, but nothing says who sets it or when. If the owner sets it at G1, the PC-S hash and the G1 hash differ.
- **Hold-clear hash.** `H(verdict_id‖content_hash‖l2_fingerprint)` has no domain prefix and no length prefixing.
- **Rollout digest.** "Digest of the target set" is undefined: ordering, deduplication and encoding are all open.
- **Notification-policy hash.** `14` §5 uses `"sl:notification_policy:v1" ‖ …` with no `\n` terminator, a third framing style.
- Hex case isn't stated.
- A rule for unassigned code points is missing. Without one, a CLI and a server on different ICU versions can disagree at the edges.

**Proposed contract** (`loop-schema/hash.ts`):
- Every content hash is `SHA256(LP(prefix) ‖ LP(f1) ‖ … )`, the same LP framing as the challenge, rendered as lowercase hex. Re-base `H_req`, `H_spec` and `H_fb` on it now, while nothing has shipped.
- A prefix registry, where each prefix has a frozen field list:
  `sl:req:v1`, `sl:spec:v1`, `sl:fb:v1`, `sl:hold_clear:v1`, `sl:rollout:v1` and
  `sl:notification_policy:v1`.
  - The rollout input is `JCS(sorted(unique(targets)))`.
- `sl.request.v1` gets a closed JSON Schema with `additionalProperties: false`.
  - Every key is always present. Use `null`, never omit.
  - The "where" field is `area`.
  - `eligibility_class` is moved out of `H_req` into the G1 approval payload. A separate hash binds it at G1.
- Normalization rejects unassigned code points (`\p{Cn}`) at intake.
- `loop-schema` ships `test-vectors/*.json` (inputs, normalized bytes, hashes, challenges). The server, the CLI and the dashboard each run them in CI. Changing a vector is a major bump of
  `loop-schema` *and* a new prefix version.

### B4. The CLI has no machine contract: exit codes, output, schema

**Ref:** `07` §1, `05` §5. "Can an agent drive the CLI from errors alone?" Today, no.
**Problems.** No exit codes are defined. There is no `--output json`, no stdout/stderr split,
and no machine-readable command or error catalogue. An agent wrapper would have to scrape
Rich-style terminal text.

**Proposed contract:**
| Exit | Meaning | Agent action |
|------|---------|--------------|
| 0 | Success | Proceed |
| 2 | Usage or arguments | Fix the arguments |
| 3 | Auth required, revoked or expired | `soren-loop login` (human) |
| 4 | Not found or not permitted | Abort |
| 5 | Invalid transition (`409`) | Read `allowed_actions` (M2) and `next` |
| 6 | Policy hard block (SR-04, no override) | Abort; owner review |
| 7 | Request entered `security_hold` | Owner action in the dashboard |
| 8 | Verification failure (`receipt_invalid`, `H_*` mismatch, `VENDORED.json` mismatch) | **Never retry**; escalate |
| 9 | Claude rate limit | `build --resume` after `resets_at` |
| 10 | Deterministic checks failed | Owner reviews; `retry` or `reject` |
| 11 | Agent process error or timeout | Owner reviews |
| 12 | Server unreachable or `5xx` | Retry with backoff |
| 13 | Incompatible versions (`cli_too_old`, `server_too_old`) | Upgrade |

- **Output selection.** `--output text|json`. JSON is the default when stdout isn't a TTY or
  `CI` is set.
- **stdout.** Exactly one document:
  `{schema:"sl.cli.result.v1", command, ok, exit_code, subject:{type,id}, run_id, state, result, error: <B1 problem>|null, next:[{argv,reason}]}`.
- **stderr.** Progress and warnings go to stderr. With `--output json` they are NDJSON:
  `{event:"step", step:"pc_a", status:"passed"}`.
- **`soren-loop schema`** prints the JSON Schema for every command result and the full error code list. `doctor --output json` emits check IDs (`doctor.widget_rp_subdomain`, …).
- **`--agent`.** Implies JSON, never prompts, and fails with exit 2 on any interactive requirement. `build --interactive` is refused under `--agent`.

## Major

**M1. The step-up options contract only fits request-scoped actions.** `05` §1 (`POST /v1/owner/stepup/options {action, request_id, content_hash}`), SR-35.
- Policy, JWKS, trusted-commit, contact, SMTP and bulk reject have no `request_id`. SR-35 says the challenge covers `target_id(s)`.
- **Proposed:** `{action, targets:[{type:"request"|"site"|"verdict"|"owner", id}], content_hash}`, with LP-encoded `targets` sorted by `(type,id)` in the challenge.
- `action` becomes a closed enum in `loop-schema` (`request.approve`, `spec.approve`,
  `hold.clear`, `rollout.widen`, `notification_policy.update`, …).
- Every +SU route takes `{…payload, stepup:{challenge_id, assertion}}` in the body, in one shape everywhere.

**M2. `allowed_events` names events, but clients call routes.** `05` §5, `03` §3.
- Events (`clear_hold`, `widen_rollout`) don't match routes (`/holds/{id}/clear`, `/rollout`), so an agent can't get from one to the other.
- **Proposed:** `409` returns `current_state` and
  `allowed_actions:[{event, method, path, requires_stepup}]`. `loop-schema` publishes the event→route table.
- Add optimistic concurrency to the non-step-up owner actions (`reject`, `park`, `retry`). Accept `If-Match: "<version>"` and return `412 precondition_failed` on a stale view. A
  `version_conflict` from the server-internal race stays `409`.

**M3. No negotiation for version skew between the CLI and the server.** `05` §4.
- Self-hosters pin the server, and the CLI is released on its own schedule. So the common case is a *new CLI against an old server*, and `X-SL-Min-CLI` only covers the opposite case.
- **Proposed:** `GET /v1/meta` (unauthenticated, cacheable) returns
  `{server_version, api_version, min_cli, hash_prefixes:[…], outcome_schema_versions:[1], capabilities:["receipts","notification_policy",…]}`.
  - The CLI gates features on `capabilities`, never on a version comparison.
  - It fails with exit 13 / `server_too_old` naming the missing capability.
- Publish a compatibility promise: CLI major N supports every server release in the current
  `v1` from the oldest still inside its deprecation window.
- Send the CLI version in `User-Agent: soren-loop-cli/1.4.2 (node/22; darwin)` as well as
  `X-SL-CLI-Version`.
- Deprecation windows: "≥ 2 server minor releases" for HTTP routes, and "≥ 1 CLI major" for CLI flags and exit codes. Apply the `Deprecation`/`Sunset` headers and a CLI stderr warning everywhere.

**M4. There is no rule for unknown values in response enums.** `14` §6, `05` §4.
- `14` §6 calls adding a `Channel` "additive". For a strict reader of `GET …/notification-policy` (a `z.enum` in an independently released `loop-schema` consumer), it's breaking. The same applies to error `code`, `state`, outbox `status` and `limit_type`.
- **Proposed rubric line:** request enums are closed (strict). Response enums are open.
- `loop-schema` exports `openEnum()` (known values or `{unknown: string}`). Clients MUST:
  - fall back on the HTTP status class plus `suggested_action` for an unknown `code`;
  - render an unknown stage as "in progress";
  - ignore unknown channels.
- Add this to the `05` §4 rubric as "adding a response enum value: minor, requires the fallback rule".

**M5. The widget JWT exchange claim set isn't a schema.** `06` §1.1, `14` §2.1, SR-07.
- `email` and `email_verified` appear in `14`, but not in the `06` claim list.
- The audience is the constant `soren-loop`, which every install shares, and that matters for hosted Phase 3.
- `typ`, `kid` and leeway are unstated.
- **Proposed:** `sl.widget_jwt.v1` in `loop-schema`.
  - Header: `alg ∈ {ES256, EdDSA}`, `kid` required, and `typ: "sl-widget+jwt"` (RFC 8725 explicit typing).
  - Claims: `iss` = site ID; `aud` = the install's API origin; `sub`; `iat`; `exp` ≤ iat+300;
    `jti`; optional `name`, `email` and `email_verified`. Leeway is 30 s.
- `POST /v1/widget/sessions` returns `{session_token, expires_at, expires_in}`.
- On `401 widget_session_expired`, the widget calls `getToken()` once more and re-exchanges. Any other `401` is a generic `widget_auth_failed` with no detail.
- `createWidgetToken({sub, name?, email?, emailVerified?}, {siteId, apiOrigin, key, kid})`.
- *Sentinel to confirm the per-install `aud` and the leeway value.*

**M6. The OFREP contract (FL-1, SR-36) likely conflicts with the stock browser provider.** `08` §2.2, `02` (`packages/react`: "stock providers").
- The OpenFeature OFREP **web** provider evaluates in bulk (`POST /ofrep/v1/evaluate/flags`) to fit the static-context paradigm. SR-36 says the bulk path is never proxied. Then the stock provider gets 404s and every flag silently resolves to its default, which is "off". Verify in S4.
- **Proposed:**
  - The enumeration risk is closed by the *host allowlist* plus server-injected
    `targetingKey`, not by the single-flag path.
  - Amend SR-36 with Sentinel to allow bulk evaluation *restricted to the allowlist*.
  - `@sorenai/loop-node` ships `createOfrepHandler({flagdUrl, allowlist, getUser})` as a Fetch-API `(Request) => Response`. It strips the browser context, injects
    `evaluationContext(user)`, filters the bulk response to allowlisted keys, and drops metadata. Hosts don't hand-roll a security-critical proxy.
  - Make `createWidgetToken` and `evaluationContext` take the same `SorenLoopUser` type, so
    `sub` and `targetingKey` can't drift. Drift would mean the flag is on for an ID nobody evaluates.

**M7. The webhook signing format is under-specified.** `08` §3, `05` §1, `14` §6.
- Not stated: the exact signed string, the header value format, secret rotation, which site a delivery belongs to, the timestamp unit, and the response codes on duplicates.
- **Proposed:** adopt **Standard Webhooks**.
  - Headers: `webhook-id` (= `event_id`), `webhook-timestamp` (Unix seconds), and
    `webhook-signature: v1,<base64 HMAC-SHA256(id.timestamp.body)>`, space-separated so several signatures can be valid during rotation.
  - Route: `POST /v1/webhooks/deploy/{site_id}`.
  - Body: `{environment, sha}`, where `sha` is 40 lowercase hex characters.
  - Responses: `202` when accepted, `200` for a duplicate `webhook-id`, `400` on a stale timestamp, `401` on a bad signature. The response body is a problem document with no detail.
- GitHub ingestion verifies `X-Hub-Signature-256` over the raw bytes, routes by
  `installation.id`, persists, and returns `202` well inside GitHub's 10 s timeout.
- The Phase 2 outbound `webhook` channel (`14` §6) reuses this scheme verbatim.

**M8. `FlagWriter` has no ordering fence, typed errors or units.** `08` §2.1.
- Absolute writes from two outbox jobs that execute out of order (enable for the requester, then widen) let the older list win. That doesn't matter for flagd, which re-renders from the DB, but it does for Unleash.
- `Promise<void>` gives the worker no way to tell a retryable failure from a dead one.
- **Proposed:**
  - `setTargets(key, targets, {version})`. `version` = `flags.doc_version`. Adapters ignore stale versions, and the worker serializes per flag key.
  - Every method rejects with `FlagWriterError {code: "auth"|"not_found"|"conflict"|"rate_limited"|"unavailable"|"invalid", retryable, retry_after_seconds?}`.
  - `setRollout(key, basisPoints: 0..10000)`.
  - `limits(): {maxTargets, supportsPercentage}`.
  - Drop `meta.requestId` (SR-13 keeps metadata server-side, and adapters shouldn't receive what they mustn't write).
  - Export `FLAG_WRITER_API = 1`, because community adapters will treat this "internal" port as public.
- Unleash paths (`08` §2.3 asks me to pin them): defer this to the Phase 2 adapter task, with a verification step against current docs. I won't pin them unverified.

**M9. The run lease and heartbeat contract is missing.** `05` §1 (`/runs`, `/heartbeat`), `03` row 10.
- **Proposed:** `POST /runs` returns
  `{run_id, lease_id, lease_expires_at, heartbeat_interval_seconds, lease_ttl_seconds}`.
- A heartbeat returns `{lease_expires_at, cancel_requested}`, so the owner can stop a run from the dashboard.
- A lost lease returns `409 lease_lost` with `suggested_action: abort`. The CLI kills the agent and exits 11.

## Minor

- **m1. Time naming** (`05`, `14`, `04`).
  - `stage_since` (feed) and `stage_since_hour` (events, relay payload) name the same concept differently.
  - `expires_in` sits next to `resets_at`.
  - Rule: instants are `*_at` (RFC 3339 UTC) and durations are `*_seconds`. Keep `expires_in` only on OAuth-shaped token responses.
- **m2. Notification-policy API** (`14` §2.2, §5).
  - The PUT body is `{base_version, override, stepup}`.
  - Replace `DELETE` with a body by `POST …/notification-policy/reset`, because intermediaries and `fetch` handle DELETE bodies badly.
  - An unlocked entry takes exactly one of `channels`/`add_channels`, and a locked entry takes only `add_channels`.
  - `409 policy_version_conflict` returns `current_version` and `effective`, so the dashboard can rebase before the new step-up.
- **m3. The tdd-pair outcome** (`07` §5).
  - Push the cross-field rules upstream into `outcome.schema.json` (`if`/`then` and
    `contains`), so one artifact carries them and the TS and pydantic validators can't drift.
  - An unknown `schema_version` is treated as a missing outcome, not as an error.
  - In CLI JSON, put it under `advisory: {untrusted: true, …}`, and never derive `next` from it. An agent driving the CLI must not act on model-written `spec_gaps` (LLM01 propagation).
- **m4. List envelope** (`05` §5).
  - `{data:[…], next_cursor: string|null}`, with opaque cursors that don't leak offsets.
  - `GET /v1/cli/work` is unpaginated and bounded, with `{data, truncated, total}`, because agents drop cursors.
  - `?fields=` can never drop hash inputs from `GET /v1/cli/requests/{id}`, so the receipt-verification fields are always included.
- **m5. Widget `429` oracle** (`05` §2, SR-40b).
  - `limit_reached` must carry an identical `retry_after_seconds` (a fixed value or `null`) for a cap and for a paused site. Otherwise the timing becomes an oracle.
  - *Sentinel to confirm.*
- **m6. ID prefix collision** (`04` `requests.public_ref`).
  - `pr_` reads as "pull request" next to `pr_number`, and agents will conflate the two. Rename it to `ref_`.
- **m7. `GET/DELETE /v1/owner/cli-tokens`** (`05` §1).
  - Use per-token `DELETE /v1/owner/cli-tokens/{tok_id}`, plus an explicit
    `POST …/cli-tokens/revoke-all`. A collection DELETE is an easy accident.

## Verdict

**Not ready for task breakdown.** B1–B4 are spec-text changes to `04` §3, `05` §2–3, and
`07` §1, probably about a day of work. Each one shapes a shared module that every later task
imports: the error middleware, the idempotency middleware, `loop-schema/hash`, and the CLI
output layer. Cutting tasks first would bake in contracts that are breaking to fix later.

Once B1–B4 are resolved:
- M1, M4 and M5 must land in `loop-schema` before its first task closes.
- M2, M3 and M6–M9 can be carried as acceptance criteria on their owning tasks.
- The minors can go in during implementation.

**Hand-offs:**
- **Sentinel:** B2 push-token replacement, M5 `aud`/leeway, M6 SR-36 amendment, m5.
- **Ada:** the test vectors (B3) as the first red batch.
- **Arendt:** fold B1–B4 into the RFC text.

**Counts:** 4 blocker, 9 major, 7 minor.
