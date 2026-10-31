# 13. Decision Log: Open Questions and Tensions

All of the RFC's open questions closed in Round 5 (`docs/discovery/00-project-brief.md`,
decisions 26 to 31). This file records how each one was closed. §3 lists the new tensions that
came up in the notification-policy design (decision 30). Those need the owner's confirmation.

## 1. Questions (all closed)

| # | Question | Decision |
|---|----------|----------|
| Q1 | Orgs that forbid private forks | **29.** The same-repo mode survives as opt-in and off by default, behind `doctor`-verified rulesets and +SU, with a PR note (`08` §1.8). The S1-F follow-ups run in Phase 0. |
| Q2 | Enablement after a GitHub merge (G3) | **29.** Automatic by default. Site options: `merger_must_be_owner_login`, `dashboard_confirm` (+SU) (`06` §2, `08` §2). |
| Q3 | MVP flag store | **29.** flagd only. Unleash is the first Phase 2 adapter, LaunchDarkly second. |
| Q4 | `build --wait` through a rate-limit window | **29.** Phase 2, opt-in, on an owner-started run, at most one resume per invocation (`07` §1.2). |
| Q5 | Response if Anthropic disallows the subscription path | **29.** A maintainer decision within 72 h with a pre-written advisory. Never an automatic switch (`10` §4). |
| Q6 | Seven requester stages, hour-rounded `stage_since` | **29.** Approved (`03` §5). |
| Q7 | SR-19 receipts as MUST | **29.** MUST-MVP, with no escape hatch (`17` §1, `09` §1). |
| Q8 | A requester reply needs G1 again | **29.** Yes; the G1 view shows the diff (`03` row 15). |
| Q9 | Requester stage after a kill | **29.** `closed` (`03` §5). |
| Q10 | Retention for live features | **29.** The `sub` stays in the flag targets while live; request text is purged 90 days after `enabled_for_requester` (`17` §2). |
| Q11 | Rework feedback from GitHub | **29.** Dashboard, plus `changes_requested` reviews by the configured owner login (`03` row 24). |
| Q12 | Path-policy templates | **29.** Shipped as suggestions; the owner confirms with +SU; `doctor` still refuses a build without a confirmed policy. |
| Q13 | CLI platforms | **29.** macOS and Linux; Windows through WSL2 only. |
| Q14 | OpenFeature SDK as a prerequisite | **29.** An onboarding step; `doctor` checks for it (T10). |
| Q15 | Owner of the bot-only fork | **29.** A dedicated GitHub org (`08` §1.3). |
| Q16 | Keep `build --interactive` | **27.** Kept, hardened exactly like headless; only the auditor changes (`07` §1.2). |

## 2. Tensions (all resolved)

| # | Tension | Resolution |
|---|---------|------------|
| T1 | "Every transition emits a status event" vs A23-5 | Requester events, including pushed notifications (`14`), fire only on a requester-stage change (`03` §5) |
| T2 | WebAuthn on G3 | G3 is GitHub's gate. Decision 29 site options cover the gap (Q2). |
| T3 | RP ID at the parent domain vs a separate widget host | SR-29: exact `expectedOrigin` (primary); exact-host RP ID, Fetch Metadata, `Origin`, CSRF, `__Host-` (`06` §3) |
| T4 | Unleash first vs one-adapter MVP | Decision 29 (Q3) |
| T5 | `planning ⇄ needs_info` vs SR-18 | Model output only leads to `stalled`; `needs_info` is owner-entered (`03` §1) |
| T6 | `rate_limited` outcome status | Process-detected only (`03` row 8). Interactive mode: owner-declared (`07` §1.2). |
| T7 | MVP issue projection vs SR-17 | Optional; off by default for public repos |
| T8 | Readable flag key in discovery's smoke test (`fl-12-dark-mode`) | Opaque `sl_<random>` keys (SR-13) |
| T9 | Agent rewrites the worktree's `.git` | SR-28 (`07` §1.3) |
| T10 | Decision 16 + SR-04(d) deadlock | Onboarding prerequisite (Q14) |
| T11 | Two L1 implementations | One prompt, schema, and corpus in `packages/schema` (`06` §1.3) |
| T12 | No resting state for owner-started builds | `plan_approved` and `stalled` added (`03` §2) |
| T13 | SR-03's spec-file Write vs decision 22 | No Write tool; the spec returns in the final message |
| T14 | Vendored skill pre-approves Bash; `-p` invocation | Sandbox is the boundary (SR-02, S7); S3 fallback in `15` §3 |
| T15 | Outcome cross-field rules only in pydantic | TS port with shared fixtures (`15` §4) |
| T16 | PR App permissions beyond decision 25 | **Decision 26:** `contents: read`, `deployments: read`, `issues: write`; fail on `contents` above read (`08` §1.2) |

## 3. New Tensions from the Notification Policy (decision 30, `14`)

Sentinel reviewed these against A23-5 and ruled on them (SR-39, SR-40). All five are
**closed by decision 32** (brief, Round 6): the recommendations were accepted under Sentinel's
conditions.

| # | Tension | Resolution (closed: decision 32) |
|---|---------|--------------------------------|
| T17 | Requester-pushed notifications need an address; soren-loop only holds `sub` | Accepted for MVP with conditions: off by default per site; the host-JWT `email` claim is used only when `email_verified: true` (T6.5); encrypted at rest, never logged, purged under SR-27; `List-Unsubscribe` and a per-recipient rate limit; title-free templates (`14` §2.1). The signed host-webhook relay remains the preferred Phase 2 path. **Closed: decision 32.** |
| T18 | Immediate requester email would reveal the exact minute of a stage change | `ceil_hour` scheduling on every requester channel (SR-39b) **Closed: decision 32.** |
| T19 | Locked alerts can't be suppressed, but outages flood them | Coalescing is accepted: per `(site, kind)`, leading-edge, every `request_id` listed and grouped by requester, never in `dashboard_inbox`, rows marked `sent_coalesced` (`14` §4) **Closed: decision 32.** |
| T20 | SR-11 digests vs locked alerts | Locked alerts are never digested **Closed: decision 32.** |
| T21 | The A23-8 pause returned `limit_reached`, so a requester with no open requests under the daily cap could infer they'd been flagged three times | **Shadow-accept** (SR-40b, Sentinel's recommendation, adopted in `03` §3). The alternative Sentinel offered is to accept the leak as an explicit residual. Shadow-accept costs stored junk requests (bounded by the per-`sub` caps, bulk-rejectable). **Closed: decision 32.** |
| T22 | Public repos (decision 14) let a requester find their PR through the widget `request_id` | Opaque `public_ref` on all GitHub artifacts; no hold or verdict terms (SR-40a, ST-61) |

Residual accepted by Sentinel: a rejection after a hold during `planning` looks like an owner
rejecting at plan review (T12.4).

## 3a. New Tensions from the Zod and Postel Revision (closed by decision 34, except T25)

| # | Tension | Recommendation |
|---|---------|----------------|
| T23 | Decision 29 (Q11) accepted GitHub `changes_requested` reviews by the owner login as rework feedback. Zod B5 shows that unsigned feedback steering a write-capable agent breaks content-bound approvals. | GitHub reviews create **pending** feedback, and the owner confirms it with one +SU `rework.approve` (`03` row 24). This tightens Q11. It needs the owner's OK. **Closed: decision 34.** |
| T24 | The private-repo fetch token (Zod M13) means a stolen CLI token could read the private upstream for 1 h | **Sentinel ruling (rated H inherent):** the default is the owner's own git credential, used only for `git fetch` of the exact upstream URL, so nothing is minted. The server-minted token is a fallback, and it requires a DPoP-bound CLI token (SR-09, T7.6, ST-75). Residual: L by default, M on the fallback. The owner should confirm the default. **Closed: decision 34.** |
| T25 | SR-36 says "bulk never proxied", but the stock OFREP web provider may need bulk (Postel M6, UNVERIFIED) | S4 gates it. Allowlist-filtered bulk is the proposed amendment (with Sentinel), and `SorenLoopFlagProvider` is the fallback (`16` §5). **Open: gated on S4.** |
| T26 | The reconciled MVP is ≈ 30.5 eng-weeks (15–17 calendar weeks), up from ~19.5 (10–12) | The owner picks from the pullback table in `12` §4 (up to ≈ 5 eng-weeks). Nothing has been cut. **Closed: decision 34.** |
| T27 | `build --fresh` opens a new PR and closes the old one, so review comments split across two PRs | Accepted for V1 (no force-push is the stronger property). The new PR links the old one. **Closed: decision 34.** |
| T28 | Agent commits are now authored by the push App's bot identity and committed by the owner (Zod m12). Repos with DCO or CLA bots may reject them. | `doctor` detects DCO and CLA checks and warns. The owner can choose a `Co-authored-by` trailer mode instead. **Closed: decision 34.** |
| T29 | The deterministic flag-off gate (Zod D6) adds an onboarding step: the owner adds a test-setup file that installs OpenFeature's `InMemoryProvider` from `SL_FLAG_FIXTURE` | Accept. `doctor` checks for it, and the onboarding guide ships a snippet per test runner (Jest, Vitest, pytest). **Closed: decision 34.** |
| T30 | Branch chains (Zod D3): every build from base opens a new PR. A rejected first submit, or `--fresh`, splits review history across PRs, and the fork accumulates branches. | Accept. Superseded PRs link to their successor, superseded branches are deleted after 30 days, and rework within a chain keeps a single PR. **Closed: decision 34.** |

## 5. Review Findings → Fix Map (2026-10-31)

| Finding(s) | Fix | Where |
|------------|-----|-------|
| Zod B1 | Outbox key `sl:obx:v1(source_type, source_id, effect, kind, audience, channel)`; nullable `request_id`; notification fields as real columns | `04` §2, §5; `14` §4 |
| Zod B2 | `reject` from all of P with lease revocation and `gh.close_pr`; `building{submitting}` with `pr_opened`, `pr_open_failed`, `submit_rejected`; `retry_effect`; liveness invariant | `03` rows 4, 23, 38–41; §6 inv. 10 |
| Zod B3 | `withdraw` only from P, with `gh.close_pr`; after merge, `requester_opt_out` (no transition); `retire` archives instead of closing; invariants 9 and 12 | `03` rows 32, 33, 43 |
| **Zod B4 + Postel B3** | `H_req` covers requester content only; the closed `sl.request.v1` with every key present; the G1 hash `sl:g1:v1(h_req, eligibility_class)`; cumulative `owner_context` revisions; LP framing everywhere; prefix registry; lowercase hex; `\p{Cn}` rejection; **canonical vectors N/H/C/R** | `04` §3 |
| Zod B5 | The rework tree from the PR head; fast-forward only; cumulative compare from the original base; `--fresh` instead of a rebase; +SU rework receipts verified by the CLI; context preserved through `stalled`; `ask_requester` only with no PR open | `07` §1.4; `03` rows 12–14, 24; `17` §1 |
| Zod M1 | Every deployment persisted; `evaluate_deployments` on `merged`; `deployed{awaiting_confirm}` and `confirm_enablement` | `03` rows 25, 27, 42; `08` §2 |
| Zod M2 | `plan --recheck` and the PC-B row from `plan_review` | `03` rows 35, 44 |
| Zod M3 | The throttle counts only requester-attributable L1/L3 flags, derived over a rolling 24 h; row 1 marks `throttled`; `06` corrected | `03` §3; `04` `prechecks`; `06` §1.4 |
| Zod M4 | An Events column per row; one kind per hold reason; timers resolved at fire time; `sites.requester_email_enabled`; per-request ordering | `03` §3; `04` `timers`; `14` §4 |
| Zod M5 | `retire` archives, so a shipped feature never shows `closed` | `03` row 32, §5 |
| Zod M6 | Chains per `(site, table)` under an advisory lock; columns; export after every step-up; SR-35–38 rows in `09`; "optional" deleted | `04` §4; `09` §1 |
| Zod M7 | A store-by-store retention table; CLI `gc` | `17` §2 |
| Zod M8 | A spec `paths[]` field in `H_spec`; a deterministic flag-off definition; ST-05 wording (decision 16) | `04` §3; `07` §1.3; Sentinel for ST-05 |
| Zod M9 | Offline verification of G1, G2, rework, and clear receipts; vectors R-02 to R-08 and a proposed ST | `17` §1; `04` §3.5 |
| Zod M10 | ST priority tags; the release gate = every `mvp` ST; proposed STs for SR-13, 15, 16, 17 | `09` §1, §1a; `10` §6 |
| Zod M11, M12 | Hydrate only pristine exports; checks in a fresh container; credential copied, never mounted; SR-02 mount text; L1 fresh config dir with strict MCP | `15` §2; `07` §1.2 |
| Zod M13 | A server-minted read-only fetch token | `05` §1.3; `07` §1.1; `08` §1.4 |
| Zod M14 | Estimate reconciled to ≈ 29.5; pullback table; 10x co-ranking; duplicate grouping specified | `12` §3, §4; `06` §1.4 |
| Zod M15 | A `clearances` table; one binding everywhere | `04` §2, §3.4; `03` row 34 |
| Postel B1 | RFC 9457 envelope; `suggested_action` enum; `next[].argv`; `trace_id` vs `subject`; widget code subset | `05` §2 |
| Postel B2 | Scope `(principal, route)`; UUIDv7 per operation; store only 2xx/final 4xx; exempt credential routes; push-token replace | `04` §5; `05` §3; `07` §2.4 |
| Postel B4 | Exit codes, `sl.cli.result.v1`, stderr NDJSON, `schema`, `--agent` | `07` §2 |
| Postel M1, M2 | Step-up `targets[]` and `action` enum, one body shape; `allowed_actions` with routes; `If-Match` → `412` | `05` §1.2, §2; `04` §3.4 |
| Postel M3, M4 | `/v1/meta` capabilities and the compatibility promise; open response enums | `05` §4 |
| Postel M5 | `sl.widget_jwt.v1` (per-install `aud`, `typ`, `kid`, leeway: Sentinel to confirm) | `06` §1.1 |
| Postel M6 | `createOfrepHandler`; S4 gating; fallback provider | `16` §5; `12` §5 |
| Postel M7 | Standard Webhooks deploy hook | `08` §2.1 |
| Postel M8 | `FlagWriter` version fence, typed errors, basis points, `limits()`, API version | `16` §1 |
| Postel M9 | Lease and heartbeat contract, `cancel_requested`, `lease_lost` | `05` §1.4; `03` row 45 |
| Postel m1–m7 | Time naming; policy PUT/reset; outcome under `advisory.untrusted`; list envelope and `fields` floor; the widget `429` constant; `ref_` prefix; per-token DELETE | `05`; `14` §5; `15` §4; `04` |
| Zod m1–m6, m8–m12 | Live set L; idempotent mint; server path-policy check; mint and head guards; timeout resume and lease sleep; TTY filter; stale SR-19 text; row-count rule; diagrams; lease authority and `site_owners`; attribution; G-7 acceptance test | `03`; `07`; `09`; `12`; `14`; `18`; `04`; `01` |

**Handed to Sentinel** (security text in `security/06`; the RFC is written to the proposal):
Postel B2 push-token replacement cap; M5 `aud` and leeway; M6 SR-36 bulk amendment; m5;
Zod sandbox gaps (M11), L1 isolation (M12), the throttle change (M3), the audit-chain scope
(M6), the SR-35–38 rows, the SR-19 ST, the release gate to ST-62, the ST-05 wording, the SR-26e
binding text, and the SR-02 mount text.

## 5a. Delta Re-Review Findings → Fix Map (Zod and Postel deltas; Sentinel's rulings)

| Finding | Fix | Where |
|---------|-----|-------|
| Zod D1 (blocker) | `request_prs` with `active`/`superseded`; rows 24–26 act only on the active PR; superseded-PR events make no transition (row 46), and a superseded merge raises the locked alert; invariant 13 | `03` §2, rows 24–26, 46; `04` |
| Zod D2 | Site-scoped `deployments` plus `deployment_evaluations`; fan-out on arrival; a bounded newest-first evaluation on `merged` entry | `04`; `08` §2; `03` row 27 |
| Zod D3 | Branch chains `soren-loop/<public_ref>/<chain>`; `retry` routes by whether there's an active PR; `--fresh` from any build-start state | `03` rows 12, 23; `07` §1.3, §1.4 |
| Zod D4 | `gh.*` serialized per request; `open_pr` re-reads the state; `pr_opened` on a terminal state closes the PR with no transition; invariant 12 restated over the drained queue | `04` §5; `03` rows 4, 23, 33, 40 |
| Zod D5 | A `requests.requester_opted_out` column, excluded from every `setTargets`; invariant 14; opt-out removes only the caller's own `sub` (ST-76) | `03` rows 27, 43; `04`; `16` §1 |
| Zod D6 | The flag-off gate uses OpenFeature's `InMemoryProvider` through an onboarding test-setup file (`SL_FLAG_FIXTURE`); the SDK override is removed | `07` §1.3(d) |
| Zod D7 | `decline_enablement` → `flag_off{previous: none}`; `restore_flag` from `none` → `deployed{queued}` | `03` rows 31, 48 |
| Zod m1–m6 | Invariant 7 restated (≤ 2 mints, revoke first); P enumerated; `kill_flag` from `deployed{queued}`; the span rule for attribution; a down-scoped rework fetch; the lease timer as a pointer | `03`; `07` §1.4; `04` `timers` |
| Postel D-M1 | Byte-order sorting, named sort keys, `P(path)`, vectors H-14 and H-15 | `04` §3.2, §3.4, §3.5 |
| Postel D-M2 | `N_intake` vs `N_hash`, a generated Unicode table, `unicode_version` in `/v1/meta`, vector N-10 | `04` §3.1; `05` §4 |
| Postel D-M3 | `submit` waits (`--wait-seconds`), maps outcomes to exits, and returns `pending` plus `status --wait` | `07` §2.1; `05` §1.3 |
| Postel D-M4 | `aud` = the exact widget host origin; the `audience` option; reasons recorded for the owner; the owner token-check endpoint; `widget_auth_failures_total` | `06` §1.1; `05` §1.1–1.2; `10` §1 |
| Postel d1–d8 | The fence in the worker with `{applied}`, camelCase, and `FlagState`; ops-file reuse; exit 1; ETag and `428`; `/v1/meta` trimmed on the widget host; `whsec_` and a uniform `401`; `invalid_request`; the `suggested_action` enum value | `16` §1–2; `07` §2; `05`; `08` §2.1 |
| Sentinel: SR-41 | Head pinning, `expected_head` at mint, `stalled{head_tampered}`, the locked `pr_head_changed` (the tenth locked kind) | `03` rows 22, 23, 47; `08` §1.4; `14` §2.1 |
| Sentinel: SR-02 | A read-only dependency layer from the pristine export; exact phase-B mounts; no persistent credential volume | `15` §2 |
| Sentinel: SR-09 | Push-token storage and revocation; fetch via the owner's credential by default, DPoP-gated fallback | `04` §5; `07` §1.1; `08` §1.4 |
| Sentinel: SR-26a, SR-26i | L1 in phase B by default, host S6-gated; the span-attributed throttle | `15` §2; `06` §4; `03` §3 |
| Sentinel: SR-37, SR-38, ST gate | The chain text references SR-37; the TTY filter strips non-SGR CSI and shows bare `\r`; the gate is ST-01 to ST-79 minus ST-24 |
| Zod round 3: R1 | The merge guard compares the webhook's `pull_request.head.sha` with `pinned_head_sha`, so it works for merge, squash, and rebase; `merge_commit_sha` is used only for deploys; three integration tests | `03` row 25 |
| Zod round 3: R2 | Already applied: `flag_fixture_path` is registered with +SU, on the SR-04(a) hard-block list, and blob-hash checked (ST-77) | `07` §1.3; `15` §2; `05` §1.2 |
| Zod round 3: R3 to R5 | Row 49 for `pr_opened` on terminal states; a hashed lock ID, held only while claiming, with GitHub calls outside the transaction; `restore` from `none` returns to `merged` when no deploy matched; row 40 supersedes, then inserts, in one transaction | `03` rows 31, 40, 49; `04` §5 |
| Sentinel check of the pass | `expected_head` consumed at pin (ST-78); a superseded merge reuses `pr_head_changed`; the token check rated L/L (ST-79); SR-13 amended; the flag fixture path registered with +SU, hard-blocked, and blob-hash verified (ST-77) | `04` §4; `07` §1.2; `09` §1a; `10` §6; `12` §4 |

## 6. Deferred Minors

| Finding | Why deferred | Owner |
|---------|--------------|-------|
| Zod m7: numeric definitions for ST-62's "latency band" and ST-26's "control-flow trace" | They're ST text in `security/06`. The proposal is: p95 within ±25 ms over 200 samples; the trace is the ordered list of guard IDs. | Sentinel |
| Zod R3 to R5 (applied in `03` rows 31, 40, 49 and `04` §5; **acceptance criteria for Conway**) | R3: a test where `pr_opened` arrives after `reject`/`withdraw` → row 49 closes the PR, with no transition; the lock ID is hashed; no transaction is open during GitHub calls. R4: `restore_flag` from `none` with no matched deploy lands in `merged`. R5: a second-chain PR open supersedes, then inserts, in one transaction, with no unique-index error. | Conway |
| Zod round 4 (acceptance criterion for the outbox task) | The `effect_claims` lease is longer than the GitHub client's hard timeout, and a worker re-checks that it still holds the claim before reporting an effect outcome | Conway |
| Postel m3 (upstream half): `if`/`then` clauses in the kit's `outcome.schema.json` | Needs an agent-workflow-kit PR. The TS port covers it until then. | Kit maintainer |

## 4. Things I Could Not Verify

`claude -p` flag spellings (`--plugin-dir`, `--permission-prompts none`, zero-tool mode) and
`CLAUDE.md` loading under `--setting-sources user` (S6); `stream-json` rate-limit events (S2);
plugin skill invocation with `disable-model-invocation` and plugin agent addressing (S3); flagd
sync auth and latency (S4); private-repo fork behaviour, org fork policies, and whether "all
external contributors" approval holds App PRs (S1-F); merge denial for the full PR-App set
(ST-48); which hosts emit GitHub deployments; Unleash endpoint paths; pg-boss and
graphile-worker maintenance; subscription quota per feature; intake cost per request. Each is
marked **UNVERIFIED** where it appears.
