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
| Q7 | SR-19 receipts as MUST | **29.** MUST-MVP, with no escape hatch (`04` §6, `09` §1). |
| Q8 | A requester reply needs G1 again | **29.** Yes; the G1 view shows the diff (`03` row 15). |
| Q9 | Requester stage after a kill | **29.** `closed` (`03` §5). |
| Q10 | Retention for live features | **29.** The `sub` stays in the flag targets while live; request text is purged 90 days after `enabled_for_requester` (`04` §7). |
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

Sentinel reviewed these against A23-5 and ruled on them (SR-39, SR-40). They now need only the
owner's confirmation.

| # | Tension | Resolution (Sentinel's ruling) |
|---|---------|--------------------------------|
| T17 | Requester-pushed notifications need an address; soren-loop only holds `sub` | Accepted for MVP with conditions: off by default per site; the host-JWT `email` claim is used only when `email_verified: true` (T6.5); encrypted at rest, never logged, purged under SR-27; `List-Unsubscribe` and a per-recipient rate limit; title-free templates (`14` §2.1). The signed host-webhook relay remains the preferred Phase 2 path. |
| T18 | Immediate requester email would reveal the exact minute of a stage change | `ceil_hour` scheduling on every requester channel (SR-39b) |
| T19 | Locked alerts can't be suppressed, but outages flood them | Coalescing is accepted: per `(site, kind)`, leading-edge, every `request_id` listed and grouped by requester, never in `dashboard_inbox`, rows marked `sent_coalesced` (`14` §4) |
| T20 | SR-11 digests vs locked alerts | Locked alerts are never digested |
| T21 | The A23-8 pause returned `limit_reached`, so a requester with no open requests under the daily cap could infer they'd been flagged three times | **Shadow-accept** (SR-40b, Sentinel's recommendation, adopted in `03` §3). The alternative Sentinel offered is to accept the leak as an explicit residual. Owner to confirm shadow-accept, which costs stored junk requests (bounded by the per-`sub` caps, bulk-rejectable). |
| T22 | Public repos (decision 14) let a requester find their PR through the widget `request_id` | Opaque `public_ref` on all GitHub artifacts; no hold or verdict terms (SR-40a, ST-61) |

Residual accepted by Sentinel: a rejection after a hold during `planning` looks like an owner
rejecting at plan review (T12.4).

## 4. Things I Could Not Verify

`claude -p` flag spellings (`--plugin-dir`, `--permission-prompts none`, zero-tool mode) and
`CLAUDE.md` loading under `--setting-sources user` (S6); `stream-json` rate-limit events (S2);
plugin skill invocation with `disable-model-invocation` and plugin agent addressing (S3); flagd
sync auth and latency (S4); private-repo fork behaviour, org fork policies, and whether "all
external contributors" approval holds App PRs (S1-F); merge denial for the full PR-App set
(ST-48); which hosts emit GitHub deployments; Unleash endpoint paths; pg-boss and
graphile-worker maintenance; subscription quota per feature; intake cost per request. Each is
marked **UNVERIFIED** where it appears.
