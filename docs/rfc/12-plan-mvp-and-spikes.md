# 12. MVP Pullback, Implementation Plan, Spike Dependencies

## 1. The MVP Slice (from the brief, with ratified changes applied)

> Widget (form) → structured request (PC-S) → owner dashboard approve (passkey step-up, G1) →
> optional GitHub issue projection → owner runs `plan` (PC-A, PC-B) / G2 / `build` (PC-C,
> sealed sandbox) / `submit` locally → PR from the bot fork → owner merges (G3) → on a verified
> GitHub deployment event, set the requester's flag via flagd/OpenFeature.

**In:** form intake; the full state machine in §2 of `03` except Phase 2 states
(`rollout_percentage` and `matched_existing` are declared but unreachable, guarded by config);
`rollout_targeted` and `rollout_all` (explicit widening is cheap and needed to make the loop
useful); every MUST-MVP SR, including SR-19 (decision 29); SR-22 (partial), SR-23, SR-24, SR-25 (partial) from the
SHOULD list; the flagd writer; deploy detection (GitHub plus the signed webhook plus
`mark-deployed`); the demo app with a deploy workflow; the policy-diff job.

**Out (deferred):** percentage rollout, existing-feature matching, SMS and push, the Unleash and
LaunchDarkly adapters, LLM intake, Runner B, daemon mode, hosted, and everything in `01`
Non-Goals.

## 2. Which Three Components Ship First

The two repos are `sorenai-dev/soren-loop` (components 1 and 3) and `sorenai-dev/soren-loop-cli`
(component 2). Ship first the components where the trust boundaries and the open spikes are. The widget form,
the flagd writer, and most of the dashboard are thin, can be stubbed, and carry little
uncertainty.

| Order | Component | Why first | Done when |
|-------|-----------|-----------|-----------|
| 1 | **`packages/schema` + server core**: normalization and hashing, the transition table, the outbox, the WebAuthn challenge service, receipts, the audit tables | Every other component trusts its hashes and guards. ST-23 property tests need it. The hash format becomes a versioned contract the moment the CLI ships. | ST-06, ST-07, ST-09, ST-23, ST-63, ST-73 green; golden vectors (including H-14, H-15, N-10) published |
| 2 | **CLI runner + sandbox image**: `login`, `doctor`, `plan`, `build`, `submit`, SR-01 flags, two-phase containers, outcome handling, SR-28 tree hygiene | Highest uncertainty (S2, S3, S5, S6, S7) and the main security boundary. If S5 or S6 forces a redesign, the earlier the better. | ST-01 to ST-05, ST-21, ST-22 green; S7 red test passes |
| 3 | **GitHub integration**: two App manifests, a bot-only fork, the setup wizard, per-operation token minting, webhook ingest and dedup, the compare re-check, deploy detection | S1 fixed its shape (two Apps). What's left is the private-repo follow-ups. | ST-13, ST-14, ST-15, ST-48, ST-49 green on a sandbox org; the start-up check fails closed |

The widget (form plus session exchange), the dashboard gates, and the flagd writer then close
the loop for the smoke test.

## 3. What Breaks First at 10x

The baseline of about 10 requests a week per site is a **design target, not a measured
assumption** (Zod M14). 10x means about 100 a week per site, and ten times the sites per
install:

| Rank | Breaks | Why | Mitigation (not in MVP unless noted) |
|------|--------|-----|--------------------------------------|
| 1 (co-ranked) | **Owner review bandwidth** | Every request needs G1, G2, and G3 individually, with step-up and no bulk approve (by design, AB3). At 100 a week, the queue outruns one owner. Hold false positives scale linearly on top. | Better triage, not weaker gates: duplicate grouping (MVP, `06` §1.4), bulk reject (MVP), intake pause (MVP), per-site daily caps (MVP), existing-feature matching (Phase 2), requester-history ranking, a "split this request" reply for oversized specs. Never bulk approve. |
| 1 (co-ranked) | **Owner-started build hours** (Zod M14) | About 90 min of foreground build per request × 100 a week ≈ 150 machine-hours a week, all started by hand (decision 6), on top of the subscription quota (**UNVERIFIED** per-window fit) | Max or Ultra; API-key mode; Runner B on owner CI (Phase 2); several owner machines (leases are per request); revisit decision 6 for API-key mode only |
| 3 | **Flag debt** | One flag per shipped request, never retired (NG-24). Hundreds of `sl_` flags in host code. | Flag cleanup tooling ("remove the flag once `rollout_all` has been stable for N days" as a generated PR). This is the strongest V2 candidate. |
| 4 | **flagd document size and poll cost** | Linear in flags × targets. Fine at thousands, wasteful when polled at a short interval. | gRPC sync (push, S4); per-site documents (already per site) |
| 5 | **Widget polling** | 30 s polls from many open widgets | SSE, or longer intervals with jitter; it's cheap either way |
| — | *Not a 10x problem* | Postgres, the outbox, and the API at these volumes | — |

At 10x sites in one install (an agency running many clients), the first break is the
**single-owner assumption** (A2). Multiple owners per site, roles, and the two-person rule
(decision 17) become needed before any infrastructure limit.

## 4. Implementation Plan

Estimates are engineer-weeks, assuming two engineers. Conway will break them into ≤ 15-point
PR groupings per repo.

### Phase 0: Spikes (1.5 weeks; S1 done)

S1-F and S2 to S7 (§5). Exit: each spike has a written result in `docs/spikes/`, and this RFC is
revised where §5 says it could change.

### Phase 1: MVP, reconciled estimate (Zod M14)

The earlier figure (~19.5) left out work the RFC already required, and the Zod and Postel
reviews added contract work. Zod's independent estimate was 26–30. The reconciled line items:

| # | Workstream | Repo | Was | Now | Why it changed |
|---|------------|------|-----|-----|----------------|
| 1 | Schema, hashing and the canonical vectors (byte-order sorting, `P()`, `N_intake`/`N_hash` with a generated Unicode table), state machine (48 rows, `request_prs`), outbox with per-request `gh.*` serialization, audit chain with witness and verifier | 1 | 2.5 | 3.75 | `04` §3, SR-37, Zod D1, D4; Postel D-M1, D-M2 |
| 2 | Widget JWT exchange (`sl.widget_jwt.v1`), form intake, PC-S, feed, caps, shadow-accept | 1 | 1.5 | 1.75 | Postel M5, SR-40b |
| 3 | Dashboard: queue, gates, review aids, hold console, rollout, effective-diff rendering | 1 | 2.5 | 2.75 | `14` §5 diff view, `If-Match` |
| 4 | **Owner auth, sessions, recovery codes, site setup and config UI, trusted-commit management** | 1 | — | 1.5 | Missing before (Zod M14) |
| 5 | Two Apps and the wizard, fork, branch chains, minting (DPoP-gated fallback fetch), webhooks, SR-41 head pinning, site-scoped deploy matching, the Standard Webhooks deploy hook, the start-up check, projection | 1 | 2.5 | 3.5 | Zod M1, M13, D2, D3; Postel M7; SR-41 |
| 6 | flagd rendering, sync, `FlagWriter` with fence and typed errors, purge, **`createOfrepHandler`** | 1 | 1 | 1.5 | Postel M6, M8; SR-36 |
| 7 | CLI: login, doctor, pull, plan, build, submit (with waiting), **rework** and `--fresh` chains, offline receipts (G1, G2, rework, clear), outcome port, SR-28, **machine contract**, ops idempotency, the InMemoryProvider flag fixture, the CSI/`\r` TTY filter | 2 | 3.5 | 4.75 | Zod B5, M9, D6; Postel B2, B4, D-M3 |
| 8 | Sandbox image, two phases, fresh-container checks, L1 host isolation, S7 red test | 2 | 1.5 | 2 | Zod M11, M12 |
| 9 | Vendoring of tdd-pair, personas, `plan` skill | 2 | 0.5 | 0.5 | — |
| 10 | **API platform middleware:** problem+json, idempotency rules, `If-Match`, `/v1/meta`, open enums | 1 | — | 1 | Postel B1, B2, M2–M4 |
| 11 | Security suite: every `mvp`-tagged ST (about 60, plus the proposed ones), release integrity, policy diff | 1, 2 | 1.5 | 2.5 | Zod M10 |
| 12 | Notification seam with coalescing, banners, inbox, SR-39 and SR-40 | 1 | 0.75 | 1.25 | Sentinel review |
| 13 | `build --interactive` with the TTY filter | 2 | 0.5 | 0.75 | Zod m6 |
| 14 | **Observability:** metrics and the label lint; the reconciler (flag replay plus a drift report) | 1 | — | 1 | Missing before |
| 15 | Demo app with a deploy workflow; nightly E2E | 1 | 1 | 1 | — |
| 16 | **Quickstart:** compose and Caddy, setup docs, the timed fresh-VM test (G-7) | 1 | — | 1 | Missing before |
| | **Total** | | **19.5** | **≈ 30.5** | |

**Reconciled: ≈ 30.5 engineer-weeks, about 15 calendar weeks for two engineers** (the delta reviews
added about 1.0: Zod D1–D4, D6, Postel D-M1 to D-M3). There's a
separate **2-week calendar reserve** for spike-driven redesign (S5, S6, S7), so plan for 15 to
17 weeks. One external dependency remains: the agent-workflow-kit PR is still pending upstream
(`15` §3). Order: 1, 10, 7, and 5 first (§2), with 8 and 9 alongside 7. Then 2, 3, 4, and 6.
Then 11 to 16. **Exit criterion:** the `02` §7 smoke test passes nightly, and every `mvp` ST is
green (ST-01 to ST-79 minus ST-24).

### Pullback options (the owner chooses; nothing is cut here)

| Candidate cut | Saves (eng-wk) | Risk if cut | SR / ST touched | Conflicts with |
|---------------|----------------|-------------|-----------------|----------------|
| `build --interactive` moves to Phase 2 | 0.75 | No auditor's chair in the MVP | SR-38, ST-53 move | Decision 27 |
| `rollout_targeted` (the MVP widens only to `all`) | 0.5 | Owners can't add testers before going wide | ST-16 (part) | — |
| Issue projection off in the MVP | 0.5 | No GitHub mirror for owners who live in GitHub | SR-17; ST-61 (issue part) | Brief MVP slice (T7) |
| Notification overrides and suppressed view → Phase 2 (keep the resolver, defaults, and locked alerts) | 0.5 | No tuning until Phase 2 | ST-55, ST-58 move | Decision 30 ("site overrides") |
| Requester email | 0.25 | Requesters see the feed only | ST-59 (part) | T17 (pending) |
| Signed deploy webhook (keep GitHub deployments and `mark-deployed`) | 0.25 | Hosts without GitHub deployments need a manual step | ST-13 (part), R7 | — |
| `createOfrepHandler` (server-side evaluation only) | 0.5 | Client-rendered features must be evaluated server-side by the host | SR-36, ST-51 move | Decision 28 (FL-1) |
| CLI JSON output and `schema` (keep exit codes) | 0.5 | Agent wrappers wait; reshaping output later is a breaking change (Postel) | — | — |
| Witness export only nightly (not after every step-up) | 0.25 | Tamper-detection window grows to 24 h | SR-37, ST-52 | Decision 28 (AU-1) |
| `enablement_mode` options (`auto` only) | 0.5 | Any merger triggers enablement | — | Decision 29 (Q2) |
| Reconciler flag replay (manual only) | 0.5 | Flag drift is repaired by hand | — | — |
| **All of the above** | **≈ 5.0** | | | |

### Phase 2: Integration (about 8 weeks)

LLM intake with PC-I (SR-30). Runner B (SR-31). The Unleash adapter, then LaunchDarkly.
Percentage rollout. Existing-feature matching (SR-32). The request-drift reconciler report.
Optional `build --wait` (decision 29, Q4).

### Phase 3: Hosted Orchestration (12+ weeks; starts with an Anthropic conversation)

SR-34: RLS and the cross-tenant negative suite, KMS-signed App JWTs, per-tenant data keys and
widget origins, a mandatory SRI loader, and signed runner jobs with no exec channel. SR-19 is
already MUST-MVP (Zod m8).

## 5. Spike Dependencies

| Spike | Status | Question | RFC sections it can change | If it goes badly |
|-------|--------|----------|---------------------------|------------------|
| **S1** fork PR permissions | **Done: passed** (decisions 24 and 25) | Fork PR with only `pull_requests: write` upstream; merge 403; workflow pushes rejected; no fork secrets | Applied to `08` §1 and the files referencing it | n/a |
| **S1-F** private-repo follow-ups | Open | Private upstream and private fork; org fork policy; the private-repo "secrets / write tokens to fork PRs" settings; whether "all external contributors" approval holds App PRs; other `pull_requests: write` capabilities; ST-48 | `08` §1.3 to §1.6, §1.8 | Orgs that forbid private forks use the opt-in same-repo mode (decision 29, Q1). Approval settings stay out of the control set (F1). |
| **S2** `stream-json` shapes | Open | Machine-readable success, error, and rate-limit events with `resets_at`? | `07` §1.2 step 6 and §2 stream parsing; `03` row 8 | Detect rate limits from error text and exit codes; with no `resets_at`, back off with a fixed default. Never infer success from model text. |
| **S3** plugin invocation | Open | Namespaced skill as the `-p` prompt with `disable-model-invocation`? Headless `AskUserQuestion`? Plugin auto-update? Agent addressing? | `15` §3 | Pass the vendored `SKILL.md` body as the prompt; load from a local directory only; a hash-recorded patch for agent names |
| **S4** flagd HTTP sync **and OFREP web provider** | Open | Auth header? Poll interval? Reload latency? **Gating (Postel M6): can the stock OpenFeature OFREP web provider do single-flag evaluation, or does it require the bulk endpoint?** Does flagd keep an on-disk cache? | `16` §2 and §5; `10` §2 and §4 (kill-switch latency); SR-36 | If the web provider needs bulk evaluation: allowlist-filtered bulk in `createOfrepHandler` (the SR-36 amendment, with Sentinel), or the `SorenLoopFlagProvider` fallback (`16` §5). Network-restrict the sync endpoint, or move to gRPC sync with auth or mTLS. If latency is too long for a kill switch, document it and prefer gRPC push. |
| **S5** devcontainer + worktree on macOS | Open | Build time, `/login` in the container, a phase-A/B switch, the agent user's privileges | `15` §2; `11` §3; `01` assumptions | If containers are too slow: cache images and reuse containers per repo, never per run with state. `sandbox-runtime` becomes the default only with proven egress parity. |
| **S6** invocation hardening (+ classifier addendum) | Open | `--setting-sources user` + `disableAllHooks` + explicit plugin + `CLAUDE.md` loading; does `--permission-prompts none` deny? Zero-tool `claude -p` for L1? Refusal signalling? | `15` §1 (the flag set); `06` §4 (L1 invocation); `09` SR-01 | Inline `CLAUDE.md`/`AGENTS.md` into the prompt and strip `.claude/` and `.mcp.json` from the mount. If tools can't be fully disabled, run L1 inside the sealed sandbox. |
| **S7** sealed-egress red test | Open (needs S5) | ST-01 to ST-03 against the real image | `15` §2; the Phase 1 exit | Builds stay disabled until it passes. No exceptions. |
