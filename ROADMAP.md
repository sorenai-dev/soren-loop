# Roadmap

The planned work for the first release, in build order. Each line is one task, and related
tasks ship together in small pull requests. The design behind every item is in
[`docs/rfc/`](docs/rfc/) and the threat model in [`docs/security/`](docs/security/).

Nothing is published to npm until the release gate at the end of Phase 1c.

## Phase 0: scaffolding, sandbox org and spikes

- [x] 001 Scaffold the control-plane monorepo with the aggregate `ci` check
- [x] 002 Scaffold the CLI and plugin repo with the aggregate `ci` check
- [x] 003 Postgres test harness, migration framework, and the outbox-queue decision
- [ ] 003-1 Provision the `sorenai-dev-sandbox` org for integration and end-to-end tests
- [ ] 004 Spike S1-F: private-repo fork follow-ups and the ST-48 merge-denial check
- [ ] 005 Spike S4: flagd HTTP sync auth and latency, and the OFREP web provider bulk question
- [ ] 006 Spike S2: `claude -p` stream-json success, error, and rate-limit shapes
- [ ] 007 Spike S3: plugin skill invocation, headless `AskUserQuestion`, auto-update, agent addressing
- [ ] 008 Spike S6: invocation hardening flags and the zero-tool L1 classifier addendum
- [ ] 009 Spike S5: devcontainer plus run tree on macOS, two-phase firewall, in-container login
- [ ] 010 Spike S7: sealed-egress red test harness against the S5 prototype image

## Phase 0b: first red batch (hashing, normalization, test vectors, deterministic pre-check)

- [ ] 011 Framing primitives: `LP`, `H`, JCS, UTF-8 byte-order sort, and `P(path)`
- [ ] 012 `N_intake` / `N_hash` normalization with a generated Unicode 15.1 assigned-ranges table
- [ ] 013 Closed `sl.request.v1` schema, the prefix registry, and vectors H-01 to H-12
- [ ] 014 Step-up challenge derivation `sl:webauthn:v1`, the action enum, and vectors C-01 to C-03
- [ ] 015 Offline receipt verifier and vectors R-01 to R-08 (ST-63)
- [ ] 016 Vector conformance runner, JSON vector export, and `@sorenai/loop-schema` publish config
- [ ] 017 L3 deterministic pre-check rules and the shared corpus (ST-30)

## Phase 1a: server core, platform, owner auth and routes

- [ ] 018 L1 classifier prompt, strict verdict schema, and golden corpus (ST-27)
- [ ] 019 TS port of the tdd-pair outcome validator with the kit's cross-field rules
- [ ] 020 Migrations for configuration, identity, and the request aggregate; typed IDs; site-scoped repositories
- [ ] 021 Migrations for flags, GitHub, deployments, outbox, timers, notifications, idempotency
- [ ] 022 Envelope encryption, peppered HMAC token storage, and the log redaction allowlist
- [ ] 023 Transition engine: one function, one transaction, versioned writes, `invalid_transition`
- [ ] 024 Requester stage projection and hour-rounded `requester_events`
- [ ] 025 Outbox: `sl:obx:v1` keys, `SKIP LOCKED` workers, retries to `dead`, `effect_claims` serialization, timers
- [ ] 026 Transition rows 1–17: submission, PC-S/PC-I/PC-A records, G1, planning, needs-info, throttle
- [ ] 027 Transition rows 18–28: G2 with path policy, PC-C, build lease, push mint, submit, review, merge, deploy, enable
- [ ] 028 Transition rows 29–49: rollout, kill/restore, holds, reject/withdraw, PR events, opt-out, races
- [ ] 029 ST-23 property tests: random event sequences against real Postgres, invariants 1–14
- [ ] 030 Hash-chained audit tables with per-`(site, table)` chains, INSERT-only role, and the verifier
- [ ] 031 Audit chain head export to a witness, after every step-up and nightly; CLI head endpoint
- [ ] 032 RFC 9457 error envelope, `suggested_action` enum, open response enums, and the shared registries
- [ ] 033 Idempotency middleware and `If-Match` preconditions
- [ ] 034 `/v1/meta`, capability negotiation, deprecation headers, and the two-hostname router with its start-up check
- [ ] 035 Owner sessions with `__Host-` cookies, CSRF, exact `Origin`, and `Sec-Fetch-Site` enforcement
- [ ] 036 Step-up service: options, single-use derived challenges, verify, consume, and receipt storage
- [ ] 037 Authenticator enrollment (two, or one plus recovery codes) and +SU add/remove
- [ ] 038 Site setup and config API: `sl:site_config:v1`, path-policy templates, trusted commit, flag fixture path, SSRF-safe JWKS
- [ ] 039 Server CLI auth: device flow with +SU approval, rotating refresh families, DPoP binding, token list and revoke
- [ ] 040 CLI API routes: work list, request detail, keys, prechecks, run lease and heartbeat, spec upload, run lifecycle
- [ ] 041 Owner API routes for gates, holds, rework, rollout, and request actions

## Phase 1b: CLI, sandbox, GitHub, widget, dashboard and flags

- [ ] 042 CLI core: `sl.cli.result.v1`, exit codes, stderr NDJSON, `--agent`, op-file idempotency, API client, capability gating
- [ ] 043 `soren-loop login`: device flow, keychain storage, DPoP key, WebAuthn key pinning and pin-set growth, audit head recording
- [ ] 044 Trusted gitdir, run-directory manager, SR-28 git environment, lstat tree walk, base ignore rules, and `gc`
- [ ] 045 CLI pre-check runner: PC-A, PC-B, PC-C with L1 (sealed by default), L2, L3, and clear-receipt checks
- [ ] 046 SR-01 `claude -p` invocation builder, per-run config dir, and the zod `stream-json` parser
- [ ] 047 Sandbox image: reference-devcontainer-derived, digest-pinned, non-root agent, phase firewall scripts
- [ ] 048 Two-phase container orchestration: pristine hydrate, read-only dependency layer, exact phase-B mounts, fresh check containers
- [ ] 049 S7 red-test gate: Linux CI on the real image, a scripted macOS release step, and the build-disable switch
- [ ] 050 Vendor tdd-pair and the Ada/Zod personas with `VENDORED.json`; write the read-only `plan` skill
- [ ] 051 `soren-loop pull` and `plan [--recheck]`: G1 receipt, `H_req`, PC-A, lease, sealed read-only plan, PC-B, upload
- [ ] 052 `soren-loop build [--resume|--fresh]`: G2 receipt, PC-C, hydrate and seal, headless tdd-pair, process classification, fresh-container checks
- [ ] 053 SR-04 deterministic policy engine: deny-list, allow globs, manifests, secrets, binaries, size cap
- [ ] 054 Deterministic flag-off gate with OpenFeature `InMemoryProvider` via `SL_FLAG_FIXTURE`
- [ ] 055 `soren-loop submit`: hygiene, policy, bot-authored commit, mint, fast-forward push via `GIT_ASKPASS`, revoke, submit, wait
- [ ] 056 Rework runs from the pinned PR head and `build --fresh` branch chains
- [ ] 057 `soren-loop doctor`: App permissions, fork pushers, workflows, hosts, path policy, fixture, image, DCO/CLA, SMTP
- [ ] 058 `status [--wait --until]`, `mark-deployed`, `gc`, and `schema` commands
- [ ] 059 `build --interactive` in the same sealed container with the SGR-only TTY filter
- [ ] 060 Two App manifests, the dashboard setup wizard, `--setup` key writes, and separate signer modules
- [ ] 061 Start-up and hourly App permission check that fails closed
- [ ] 062 Per-operation token minting and `POST /v1/cli/runs/{id}/push-token` with SR-09 storage, repeat, and replace rules
- [ ] 063 Fallback private-upstream fetch token (DPoP-gated) and the down-scoped rework head fetch token
- [ ] 064 GitHub webhook ingest: constant-time HMAC, delivery dedup, installation routing, fast `202`
- [ ] 065 `submit` route and the `gh.open_pr`/`gh.close_pr` effects: state re-read, cumulative compare re-check, chain supersede, head pin
- [ ] 066 SR-41 head pinning: `synchronize` handling, `expected_head` consumption, do-not-merge label, superseded-merge alert, merge guard
- [ ] 067 Deploy detection: site-scoped `deployments`, `deployment_evaluations`, bounded matching, ancestry compare, `mark-deployed`
- [ ] 068 Signed deploy webhook (Standard Webhooks) at `/v1/webhooks/deploy/{site_id}`
- [ ] 069 Optional GitHub issue projection (SR-17) and superseded-branch cleanup after 30 days
- [ ] 070 `@sorenai/loop-node`: `createWidgetToken`, `SorenLoopUser`, `evaluationContext`
- [ ] 071 Widget session exchange `POST /v1/widget/sessions` and the owner token-check endpoint
- [ ] 072 Intake API: form submit with `N_intake`, caps, inline PC-S, shadow-accept; status feed, reply, withdraw/opt-out
- [ ] 073 Widget loader and iframe app (`postMessage` → `MessageChannel`, form, feed) and `<SorenLoopWidget>`
- [ ] 074 Dashboard SPA shell: nonce CSP, Trusted Types, safe markdown, invisible-character markers, fenced requester content
- [ ] 075 Dashboard request queue and detail: revisions diff, duplicate and throttled grouping, bulk reject
- [ ] 076 G1 and G2 gate views with step-up and SR-22 review aids
- [ ] 077 Hold console: span highlights at verified offsets, clear with step-up, retry, reject
- [ ] 078 Account views: authenticators, CLI tokens, device approval page, inbox, undeliverable-channel banner
- [ ] 079 Rollout console: widen (+SU), kill, restore (+SU), confirm or decline enablement, retire, effective-diff view
- [ ] 080 `FlagWriter` port, flagd document renderer, worker-side version fence, typed errors, `sl_` namespace
- [ ] 081 Internal flagd sync listener (auth per S4) and the SR-23 post-deploy probe
- [ ] 082 `createOfrepHandler` (SR-36): context stripping, injected `targetingKey`, allowlist-filtered single and bulk responses

## Phase 1c: notifications, operations, retention, security gate, end-to-end test, release and quickstart

- [ ] 083 `NotificationPolicy.resolve`, shipped defaults, strict override schema, in-transaction suppression rows, +SU policy changes
- [ ] 084 `Notifier`: plain-text email, requester templates, `ceil_hour`, locked-alert coalescing, digests, inbox, contact changes
- [ ] 085 Metrics on the internal listener with the label lint, structured logs wiring, and OpenTelemetry spans
- [ ] 086 Reconciler: nightly flag replay and a request-drift report (no auto-transition)
- [ ] 087 SR-27 PII purge and retention sweepers across every store, including the flagd document
- [ ] 088 Release integrity for Repo 1: trusted publishing, provenance, SHA-pinned actions, protected env, signed image with SLSA and SBOM
- [ ] 089 Release integrity for Repo 2: CLI trusted publishing with provenance and image digest pinning
- [ ] 090 Weekly Anthropic policy-diff job
- [ ] 091 Security release-gate aggregator: ST tag registry, per-ST status report, and the ST-71 lints
- [ ] 092 Indistinguishability tests: clean vs cleared trace (ST-26), held vs normal feed and outbox (ST-33, ST-54), paused submit timing (ST-62)
- [ ] 093 Demo app (private repo) with OpenFeature, a flag-fixture test setup, and a deploy workflow posting `deployment_status`
- [ ] 094 Nightly end-to-end smoke test (`02` §7), including the bidi-hold second request
- [ ] 094-1 Release gate: org 2FA, npm names reserved, `SECURITY.md`, branch rulesets, public sandbox image
- [ ] 095 Quickstart: `docker-compose.yml`, Caddy for two hostnames, setup guide with onboarding snippets
- [ ] 096 Timed fresh-VM acceptance test of the setup guide (G-7, under 60 minutes)
