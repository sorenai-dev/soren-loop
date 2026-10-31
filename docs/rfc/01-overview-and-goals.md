# 01. Context, Scope, Goals, and Non-Goals

## Context and Scope

Web app owners have no closed loop between "a signed-in user wants something" and "that user
has it." Feedback boards collect votes. Issue-to-PR agents (Copilot coding agent, Claude Code
Action, OpenHands, Gleap Kai Code) produce diffs. None of them turns the feature on **for the
person who asked**, and none puts a hash-pinned, passkey-approved spec between untrusted text
and an agent with write access (`02-research-findings.md` §Q2).

soren-loop V1 is:

- A **control plane** the owner self-hosts: a backend API, an owner dashboard, an embeddable
  widget, host-app SDKs, flag adapters, and a shared schema package.
- An **owner-run CLI and Claude Code plugin**. It invokes the owner's own, unmodified `claude`
  binary, signed in with the owner's own subscription. This is the only subscription use
  Anthropic's terms permit for this product (decision #2 amendment, ADR-1).
- A **flag plane**. flagd is sourced from the control-plane database by default. Vendor stores
  sit behind a `FlagWriter` port.

V1 is single-tenant-deployable, with `site_id` tenancy seams on every row so a hosted
orchestration-only platform can follow (decisions 1 and 9).

## Goals

| # | Goal | Measured by |
|---|------|-------------|
| G-1 | Close the loop end to end: request → approved spec → PR → deploy → flag on for the requester | The smoke test in `02` §Integration passes on a fresh machine |
| G-2 | Keep subscription use inside Anthropic's terms | Builds use only the stock `claude` binary or the official Action; no token handling; the weekly policy-diff job is green |
| G-3 | No untrusted text reaches an agent with write access except through an owner-approved, hash-pinned artifact | ST-06, ST-07, ST-23 |
| G-4 | A fully hijacked build agent cannot merge, push upstream, read host credentials, or exfiltrate over non-Anthropic egress | ST-01 to ST-05, ST-14, the S7 red test |
| G-5 | Code the agent writes ships behind the request's flag and stays off for non-targeted users | The SR-04(d) check, plus the SR-23 probe (SHOULD) |
| G-6 | The requester learns progress at stage granularity and never learns about holds, plans, repos, or PRs | ST-18, ST-33 |
| G-7 | Self-hosting is one image plus Postgres plus flagd, on two hostnames | A compose file and a Helm-free quickstart that run in under 30 minutes (target) |
| G-8 | The state machine is the only way state changes, and every change is attributable | ST-23 property tests; the `request_transitions` audit trail (SR-15) |

## Non-Goals

Every deferral in the brief, the ratified decisions, and the threat model. Each row names the
source and the phase that would bring it back.

| # | Non-goal (V1 / MVP) | Source | Earliest return |
|---|---------------------|--------|-----------------|
| NG-1 | **Hosted platform** of any kind. Hosted *runners* we operate are not on the roadmap without an Anthropic conversation and the Commercial Terms. | Decisions 1, 9; `01` §Q1 | Phase 3 (orchestration only) |
| NG-2 | **Running the intake chat on the owner's subscription** | Decision #2 amendment, ADR-2 | Never, under current terms |
| NG-3 | **Agent SDK in subscription mode** | ADR-1 | Never, under current terms. API-key mode only. |
| NG-4 | **Unattended daemon** that pulls and builds without an owner command | Decision 6 | Post-V1, opt-in, API-key mode by default |
| NG-5 | **Percentage rollout** | Brief, MVP deferrals | Phase 2 (`rollout_percentage`) |
| NG-6 | **Existing-feature matching** (`matched_existing`) | Brief, MVP deferrals; SR-32 | Phase 2+ |
| NG-7 | **SMS and push notifications** | Brief, MVP deferrals; SR-33 | Later |
| NG-8 | **More than one flag store in the MVP.** flagd ships first; Unleash is the first vendor adapter, LaunchDarkly second. | Brief; decision 8 | Unleash in Phase 2 (decision 29, Q3) |
| NG-9 | **LLM intake in the MVP slice**. It is V1 scope, gated by SR-30. | Brief MVP slice; SR-30 | Phase 2 |
| NG-10 | **Runner B (Claude Code Action)** in the MVP | `03` build strategy; SR-31 | Phase 2 |
| NG-11 | **Non-GitHub forges** (GitLab, Bitbucket) | Decision 4 | Not planned |
| NG-12 | **Outside contributors** on public repos as a supported workflow | Decision 14 | Not planned |
| NG-13 | **New dependencies** in agent-built changes. Manifest and lockfile edits are hard-blocked. | Decision 16; SR-04(c) | Post-V1, behind a spec declaration and approval |
| NG-14 | **Two-person rule** (spec approver ≠ merger). Off by default. | Decision 17 | LATER, opt-in |
| NG-15 | **Defending DNS and Anthropic-bound exfiltration** during the sealed phase | Decision 20 | Documented residual risk |
| NG-16 | **Eligibility beyond UI and read paths.** No migrations, authz, billing, or entitlements. | Brief mitigations; DC3; T11.1 | Not planned for V1 |
| NG-17 | **Flags as authorization.** A flag is a rollout control only. | SR-13; T11.1 | Never |
| NG-18 | **Bulk clear of security holds, bulk approve of requests, auto-approve on reputation** | A23-8; AB3 | Never |
| NG-19 | **GitHub issues as the system of record.** Issues are an optional, minimal projection, off by default for public repos. | ADR-3; DC5; SR-17 | Never |
| NG-20 | **Feeding GitHub issue text, PR comments, or web content to the agent** | `03` §4; T10.9 | Never |
| NG-21 | **Runtime fetching of personas, skills, or plugins** | SR-20; DC8 | Never |
| NG-23 | **Multi-tenant isolation** (RLS, per-tenant KMS, per-tenant widget origin) | SR-34 | Phase 3 |
| NG-24 | **Flag cleanup and code removal** after full rollout | Not in brief | Post-V1 |
| NG-25 | **EU/EEA/CH-specific enforcement.** A README warning is the V1 control. | Decision 12 | Not planned |
| NG-26 | **Moderation of request content** beyond caps, block, and purge | AB4 | Hosted phase |

## Constraints

| Constraint | Source | Consequence in this RFC |
|------------|--------|-------------------------|
| Only the stock `claude` binary on the owner's subscription | ADR-1, decision #2 amendment | The `Runner` contract shells out to `claude -p`. No credential reads and no token transit. |
| Builds start only on an owner command | Decision 6 | No server-to-runner push channel. The CLI polls or pulls. `paused_rate_limited` exits the process by default. |
| Fork-based PRs from two GitHub Apps | Decisions 7, 24, 25; S1 | ADR-4 (`08` §1): the PR App upstream, the push App on a bot-only fork; no upstream credential can merge |
| Two hostnames | Decision 18, DC6 | Widget host ≠ dashboard/API host; WebAuthn RP ID choice in `06` §3 |
| `plan` never runs Bash | Decision 22, SR-03 | The `plan` skill's `allowed-tools` is `Read, Grep, Glob`. The spec is returned in the final message. |
| tdd-pair vendored at a pinned commit | Decisions 11, 21; SR-20 | `VENDORED.json` with per-file hashes, verified every run |
| Pre-check is block-only | Decision 23, A23-1 to A23-8 | Checkpoints PC-S to PC-C in the state machine; clean has no effect |
| PII retention 90 days after close | Decision 19, SR-27 | Purge job plus tombstones |
| Weekly policy diff | Decision 13 | A scheduled job in the control-plane repo (`10` §5) |

## Assumptions

- A2 from the threat model holds: one owner or a small trusted team. The same person may
  approve a spec and merge.
- The host app can sign an ES256 or EdDSA JWT server-side and set the OpenFeature
  `targetingKey` from the same user ID.
- The owner has Docker for the default sandbox. Without it, the beta `sandbox-runtime`
  fallback applies, subject to S5.
- The owner's production deploy either emits GitHub `deployment_status` events or can call a
  signed webhook. **UNVERIFIED** which common hosts emit GitHub deployments by default
  (`02-research-findings.md` §Q4).
