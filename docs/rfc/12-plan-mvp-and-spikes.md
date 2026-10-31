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
| 1 | **`packages/schema` + server core**: normalization and hashing, the transition table, the outbox, the WebAuthn challenge service, receipts, the audit tables | Every other component trusts its hashes and guards. ST-23 property tests need it. The hash format becomes a versioned contract the moment the CLI ships. | ST-06, ST-07, ST-09, ST-23 green; golden vectors published |
| 2 | **CLI runner + sandbox image**: `login`, `doctor`, `plan`, `build`, `submit`, SR-01 flags, two-phase containers, outcome handling, SR-28 tree hygiene | Highest uncertainty (S2, S3, S5, S6, S7) and the main security boundary. If S5 or S6 forces a redesign, the earlier the better. | ST-01 to ST-05, ST-21, ST-22 green; S7 red test passes |
| 3 | **GitHub integration**: two App manifests, a bot-only fork, the setup wizard, per-operation token minting, webhook ingest and dedup, the compare re-check, deploy detection | S1 fixed its shape (two Apps). What's left is the private-repo follow-ups. | ST-13, ST-14, ST-15, ST-48, ST-49 green on a sandbox org; the start-up check fails closed |

The widget (form plus session exchange), the dashboard gates, and the flagd writer then close
the loop for the smoke test.

## 3. What Breaks First at 10x

Taking "10x" as ten times the requests per site (about 10 a week to about 100 a week) and ten
times the sites per install:

| Rank | Breaks | Why | Mitigation (not in MVP unless noted) |
|------|--------|-----|--------------------------------------|
| 1 | **Owner review bandwidth** | Every request needs G1, G2, and G3 individually, with step-up, no bulk approve (by design, AB3). At 100 a week, the queue outruns one owner. Hold false positives scale linearly on top. | Better triage, not weaker gates: duplicate collapse (MVP), bulk reject (MVP), intake pause (MVP), per-site daily caps (MVP), existing-feature matching (Phase 2), requester-history ranking, and a "split this request" auto-reply for oversized specs. Never bulk approve. |
| 2 | **Subscription quota on one machine** | Builds are owner-started and serialized on the owner's machine. A Pro five-hour window covers few medium features (**UNVERIFIED** how few). | Max or Ultra; API-key mode; Runner B on owner CI (Phase 2). Multiple owner machines already work, because leases are per request. |
| 3 | **Flag debt** | One flag per shipped request, never retired (NG-24). Hundreds of `sl_` flags in host code. | Flag cleanup tooling ("remove the flag once `rollout_all` has been stable for N days" as a generated PR). This is the strongest V2 candidate. |
| 4 | **flagd document size and poll cost** | Linear in flags × targets. Fine at thousands, wasteful when polled at a short interval. | gRPC sync (push, S4); per-site documents (already per site) |
| 5 | **Widget polling** | 30 s polls from many open widgets | SSE, or longer intervals with jitter; it's cheap either way |
| — | *Not a 10x problem* | Postgres, the outbox, and the API at these volumes | — |

At 10x sites in one install (an agency running many clients), the first break is the
**single-owner assumption** (A2). Multiple owners per site, roles, and the two-person rule
(decision 17) become needed before any infrastructure limit.

## 4. Implementation Plan

Estimates assume two engineers. They are calendar weeks and include review and integration.
Conway will break them into ≤ 15-point PR groupings per repo.

### Phase 0: Spikes (1.5 weeks; S1 done)

S1 to S7 (§5). Exit: each spike has a written result in `docs/spikes/`, and this RFC is revised
where §5 says it could change.

### Phase 1: MVP (10 to 12 weeks)

| Workstream | Repo | Est. (eng-weeks) | Key SRs |
|------------|------|------------------|---------|
| Schema, hashing, state machine, outbox, audit | 1 | 2.5 | SR-05, SR-15, SR-18 |
| Widget session exchange, form intake, PC-S, status feed, caps | 1 | 1.5 | SR-07, SR-11, SR-12, SR-26 (PC-S) |
| Dashboard: queue, G1/G2, review aids, hold console, rollout console, WebAuthn enrollment | 1 | 2.5 | SR-06, SR-10, SR-22 |
| Two GitHub Apps and setup wizard, bot-only fork, minting, webhooks, compare, deploy detection, issue projection | 1 | 2.5 | SR-08, SR-09, SR-17 |
| flagd rendering, sync listener, `FlagWriter` (flagd), purge effect | 1 | 1 | SR-13, SR-27 |
| CLI: login, doctor, pull, plan, build, submit, receipts, outcome, SR-28 tree hygiene | 2 | 3.5 | SR-01, SR-03, SR-04, SR-09, SR-19, SR-20, SR-28 |
| Sandbox image, two phases, S7 red test in CI | 2 | 1.5 | SR-02 |
| Vendoring of tdd-pair, personas, and the `plan` skill, with the sync script | 2 | 0.5 | SR-20 |
| Security test suite (ST-01 to ST-40 MVP subset), release integrity, the policy-diff job | 1, 2 | 1.5 | SR-16 |
| Demo app with a deploy workflow; nightly E2E smoke test | 1 | 1 | — |
| Notification policy seam: resolver, defaults, override API with +SU, `suppressed` outbox rows, dashboard inbox, the SR-39 locked-alert guards, SR-40 `public_ref` and shadow-accept (decision 30, `14`) | 1 | 0.75 | SR-06, SR-10, SR-12, SR-39, SR-40 |
| `build --interactive`: TTY attach to the phase-B container, the same pre- and post-run gates (decision 27) | 2 | 0.5 | SR-01, SR-02, SR-28 |
| **Total** | | **~19.5** | |

Order: workstreams 1, 6, and 4 first (§2), with 7 and 8 in parallel with 6. Then 2, 3, and 5.
Then 9 and 10. **Exit criterion:** the `02` §7 smoke test passes nightly, and every MUST-MVP ST
is green.

### Phase 2: Integration (about 8 weeks)

LLM intake with PC-I (SR-30). Runner B (SR-31). The Unleash adapter, then LaunchDarkly.
Percentage rollout. Existing-feature matching (SR-32). The request-drift reconciler report.
Optional `build --wait` (decision 29, Q4).

### Phase 3: Hosted Orchestration (12+ weeks; starts with an Anthropic conversation)

SR-34: RLS and the cross-tenant negative suite, KMS-signed App JWTs, per-tenant data keys and
widget origins, a mandatory SRI loader, signed runner jobs with no exec channel, and SR-19 as
MUST.

## 5. Spike Dependencies

| Spike | Status | Question | RFC sections it can change | If it goes badly |
|-------|--------|----------|---------------------------|------------------|
| **S1** fork PR permissions | **Done: passed** (decisions 24 and 25) | Fork PR with only `pull_requests: write` upstream; merge 403; workflow pushes rejected; no fork secrets | Applied to `08` §1 and the files referencing it | n/a |
| **S1-F** private-repo follow-ups | Open | Private upstream and private fork; org fork policy; the private-repo "secrets / write tokens to fork PRs" settings; whether "all external contributors" approval holds App PRs; other `pull_requests: write` capabilities; ST-48 | `08` §1.3 to §1.6, §1.8 | Orgs that forbid private forks use the opt-in same-repo mode (decision 29, Q1). Approval settings stay out of the control set (F1). |
| **S2** `stream-json` shapes | Open | Machine-readable success, error, and rate-limit events with `resets_at`? | `07` §1.2 step 6 and §2 stream parsing; `03` row 8 | Detect rate limits from error text and exit codes; with no `resets_at`, back off with a fixed default. Never infer success from model text. |
| **S3** plugin invocation | Open | Namespaced skill as the `-p` prompt with `disable-model-invocation`? Headless `AskUserQuestion`? Plugin auto-update? Agent addressing? | `15` §3 | Pass the vendored `SKILL.md` body as the prompt; load from a local directory only; a hash-recorded patch for agent names |
| **S4** flagd HTTP sync | Open | Auth header? Poll interval? Reload latency? | `16` §2; `10` §2 and §4 (kill-switch latency) | Network-restrict the sync endpoint, or move to gRPC sync with auth or mTLS. If latency is too long for a kill switch, document it and prefer gRPC push. |
| **S5** devcontainer + worktree on macOS | Open | Build time, `/login` in the container, a phase-A/B switch, the agent user's privileges | `15` §2; `11` §3; `01` assumptions | If containers are too slow: cache images and reuse containers per repo, never per run with state. `sandbox-runtime` becomes the default only with proven egress parity. |
| **S6** invocation hardening (+ classifier addendum) | Open | `--setting-sources user` + `disableAllHooks` + explicit plugin + `CLAUDE.md` loading; does `--permission-prompts none` deny? Zero-tool `claude -p` for L1? Refusal signalling? | `15` §1 (the flag set); `06` §4 (L1 invocation); `09` SR-01 | Inline `CLAUDE.md`/`AGENTS.md` into the prompt and strip `.claude/` and `.mcp.json` from the mount. If tools can't be fully disabled, run L1 inside the sealed sandbox. |
| **S7** sealed-egress red test | Open (needs S5) | ST-01 to ST-03 against the real image | `15` §2; the Phase 1 exit | Builds stay disabled until it passes. No exceptions. |
