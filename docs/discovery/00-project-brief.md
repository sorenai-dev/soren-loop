# Project Brief: soren-loop

Source of truth for discovery. Captures the original proposal, the decisions ratified on
2026-10-30, and the approved MVP and planning phases. Formerly the working name
`feature-loop`; renamed by decision 31. Historical S1 spike artifacts keep the old name.

## Problem Statement

Web application owners have no closed loop between "an end user wants something" and "that end
user has it." soren-loop lets an authenticated end user describe a feature through a React chat
widget, routes the structured request through owner approval gates, plans and builds it with
Claude Code (`/tdd-pair auto`), opens a PR that follows the target repo's conventions, and on
deploy enables the feature for the requester via a feature flag. Owners can then widen rollout
(specific users, percentage, everyone). Requests matching an already-built, self-serve-eligible
feature are fulfilled by enabling the flag.

## Lifecycle (state machine sketch, to be formalized in the RFC)

`intake` → `submitted` → `owner_approved` (or `rejected`) → `planning` ⇄ `needs_info`
(owner or requester) → `plan_review` ⇄ `plan_feedback` → `building` → `in_review`
⇄ `changes_requested` → `merged` → `deployed` → `enabled_for_requester` → `rollout_*`

Shortcut: `submitted` → `matched_existing` → `enabled_for_requester`.

Every transition emits a coarse status event to the requester (stage name only — never plan
contents, repo names, or PR links).

## Ratified Decisions (2026-10-30)

| # | Decision | Implication for discovery |
|---|----------|---------------------------|
| 1 | Self-hosted first, roadmap to a hosted platform (Terraform / Terraform Cloud model) | Control plane must be single-tenant-deployable now, with tenancy seams for later. Hosted platform orchestrates; execution stays on owner-controlled runners (cf. Terraform Cloud Agents). |
| 2 | Cost: owners use their existing Claude subscription, not API keys | Agent execution invokes the owner's own installed Claude Code CLI (local pull model) or their own GitHub Actions runner with `CLAUDE_CODE_OAUTH_TOKEN`. **Must verify Anthropic terms** — third-party products may not offer claude.ai login; invoking the owner's own CLI must stay on the right side of that line. API-key mode as optional fallback. |
| 3 | Only authenticated end users can submit | Widget receives identity from the host app (signed JWT / server-side token exchange), never self-asserted. |
| 4 | GitHub-only for V1; generous V1 scope; MVP below is the first slice | GitHub App vs fine-grained PAT choice; GitHub Issues as candidate system of record. |

### Decision #2 Amendment (2026-10-30, after discovery)

Anthropic's terms permit the owner's subscription for the **build** step only (our CLI shelling
out to the owner's unmodified `claude -p`, or the Claude Code Action with the owner's
`CLAUDE_CODE_OAUTH_TOKEN`). The end-user **intake** chat cannot run on the subscription. Intake
ships two modes: a guided form with no LLM (default) and an LLM chat enabled by an owner-supplied
API key. The Agent SDK is used in API-key mode only. See `01-discovery.md` §Q1.

## Ratified Decisions — Round 2 (2026-10-30)

| # | Decision |
|---|----------|
| 5 | Intake: no-LLM guided form by default; LLM chat when the owner supplies an API key |
| 6 | No unattended daemon in V1 — builds run only when the owner starts them |
| 7 | Fork-based PR model (bot pushes to fork, opens PR upstream), pending spike S1 |
| 8 | First flag-write adapter: Unleash; LaunchDarkly second |
| 9 | Hosted platform orchestrates only; runners stay on owner machines / owner CI |
| 10 | CLI + Claude Code plugin in their own repo |
| 11 | License Apache-2.0. Ada/Zod personas are already public (Apache-2.0) in [agent-workflow-kit](https://github.com/mandelbro/agent-workflow-kit); reuse them from there rather than re-trimming |
| 12 | EU/EEA/CH: README warning, recommend Team plan or API-key mode |
| 13 | Weekly CI job diffs Anthropic's policy pages and opens an issue on change |

## Ratified Decisions — Round 3 (2026-10-30, after threat model)

All tightening changes DC1–DC8 from `docs/security/threat-model.md` are accepted (the
`06-requirements-tests-spikes.md` deny-list, including `.github/**`, is canonical). Open
questions resolved:

| # | Decision |
|---|----------|
| 14 | Public repos allowed in V1; outside contributors out of scope |
| 15 | `submit` hard blocks: deny-listed paths, workflows, detected secrets. Step-up override: out-of-eligibility paths |
| 16 | No new dependencies in V1 |
| 17 | Two-person rule (spec approver ≠ merger): LATER, off by default |
| 18 | Two hostnames (widget, dashboard/API) required for self-hosters |
| 19 | Requester PII deleted 90 days after a request closes, or on request |
| 20 | DNS and Anthropic-bound traffic accepted as documented residual exfiltration risk for MVP |
| 21 | `/tdd-pair` moves into agent-workflow-kit; soren-loop vendors it at a pinned commit |
| 22 | `plan` never runs Bash; read-only tools only |
| 23 | Sentinel pre-check: can block, never approve. Runs locally as step 0 of `plan` (and at intake in API-key mode) and again on the generated plan before `build`. Three layers: no-tool `claude -p` classifier over request + spec returning a fixed JSON verdict; deterministic diff of agent-instruction files since the last owner-trusted commit; deterministic rules (invisible/bidi/confusable chars, encoded payloads, URLs, shell-like strings). Flagged → `security_hold`, cleared only by owner with step-up. Clean has no gating effect. **Amended by A23-1–A23-8** (`docs/security/threat-model.md`, ratified 2026-10-30): deterministic rules also run server-side at submission, before G1; second pass runs before G2, with L2 re-run at `build`; classifier failure holds with Retry only; clean shown as "no automated flags"; hold invisible to requester; owner-set trusted commit; classifier runs in an empty cwd with no tools; flag-rate throttle, no bulk clear |

## Ratified Decisions — Round 4 (2026-10-30, after spike S1)

| # | Decision |
|---|----------|
| 24 | S1 passed: fork model (ADR-4) stands; Option B rejected. See `spikes/S1-fork-pr-permissions.md` |
| 25 | Two GitHub Apps (S1 F2): a PR App (`pull_requests: write`, `metadata: read`) installed upstream, and a push App (`contents: write`) installed only on the bot-only fork. No upstream credential can merge |

## Ratified Decisions — Round 5 (2026-10-30, RFC open questions)

| # | Decision |
|---|----------|
| 26 | T16 accepted: the PR App also gets `contents: read`, `deployments: read`, `issues: write`. `doctor` and the start-up check fail on any `contents` permission above read |
| 27 | Q16: keep `build --interactive`. It uses the same sealed sandbox, SR-01 flags, SR-28 run tree, PC-C and `submit` policy as headless builds; only the auditor changes |
| 28 | SU-2 (one step-up authorizes one action), FL-1 (host-proxied single-flag OFREP for browsers) and AU-1 (hash-chained audit tables, chain head exported somewhere the DB writer can't reach) accepted |
| 29 | RFC Q1–Q15: all recommendations in `rfc/13-open-questions.md` §1 accepted. The seven requester stages and hour-rounded `stage_since` (Q6) are approved |
| 30 | Per-stage notification policy (seam, MVP). Every stage carries a policy that decides which notifications are emitted, to whom, on which channel, including none. Requester entries are keyed by the seven requester stages only, never internal states, so a hold can't be revealed (A23-5). Owner security alerts (`security_hold`, `precheck_unavailable`, App permission-check failure, outbox `dead`) are locked on. Suppressed notifications are recorded, not dropped, so the defaults can be tuned. Site overrides are schema-validated, audit-logged and need step-up |
| 31 | Rename: the project becomes **soren-loop**, part of the sorenai.dev suite, published under the `sorenai-dev` GitHub account. Repos: `sorenai-dev/soren-loop` (control plane monorepo) and `sorenai-dev/soren-loop-cli` (CLI + Claude Code plugin). npm scope `@sorenai` (`@sorenai/loop-react`, `-node`, `-schema`; to be reserved, SC4). Flag key prefix `sl_`, env prefix `SL_`, plugin namespace `/soren-loop:*`, error-type URIs under `https://loop.sorenai.dev/errors/` |

## Ratified Decisions — Round 6 (2026-10-31, notification tensions and hosting)

| # | Decision |
|---|----------|
| 32 | T17–T21 accepted with Sentinel's conditions: requester email only from a host-JWT `email` claim with `email_verified: true`, default off, encrypted and purged under SR-27; requester notifications delivered at the next hour; locked owner alerts coalesced per site and kind, leading edge, every request ID listed, inbox never coalesced; locked alerts never digested; throttled requesters are shadow-accepted (skip PC-I and the matcher, still run PC-S) |
| 33 | Convert `sorenai-dev` from a GitHub user account to an organization before the first public release, with `mandelbro` as owner. The working copy lives at `~/Code/soren-loop` (outside iCloud); commits are authored by `mandelbro`. Done 2026-10-31: the user account was renamed `sorenai-dev-user`, a new `sorenai-dev` org now owns the repos, and `mandelbro` is an org owner |
| 34 | RFC tensions accepted: no MVP cuts (≈30.5 eng-weeks; 15–17 calendar weeks for two engineers including a 2-week spike reserve, T26). T23: rework feedback from a GitHub review needs owner step-up before it reaches the agent. T24: private-repo fetch defaults to the owner's own git credential, with a DPoP-gated server-minted token as fallback. T27/T30: a rebuild from base opens a new PR in a branch chain; superseded branches are deleted after 30 days. T28: agent commits are bot-authored, with an owner sign-off trailer mode and a `doctor` DCO/CLA warning. T29: the flag-off gate needs a one-time, registered owner test-setup file |

## Repo Split (proposed)

1. **SDK** — feature-flag evaluation (OpenFeature provider) + flag-write adapters per vendor.
2. **Web UI** — React chat widget (embeddable) + owner dashboard (TBD: same repo or backend).
3. **Backend API monolith** — control plane: requests, state machine, approvals, notifications,
   GitHub integration, status feed.
4. *Open question:* CLI + Claude Code plugin (`plan`, `build`, packaged `/tdd-pair` skill) —
   own repo or inside the backend repo.

## Approved Security Mitigations (design inputs, not afterthoughts)

- Transcript → structured spec; owner approves the spec, never raw chat text.
- Sandboxed agent (devcontainer/worktree, no secrets in env, allowlisted egress).
- Least-privilege GitHub credentials: open PRs only, no merge, no `.github/workflows/` writes.
- CI on agent PRs runs without secrets.
- Approval links open an authenticated page; approval is a POST with WebAuthn step-up
  (link scanners prefetch GET links).
- Pull model: nothing on the internet can start a process on the owner's machine.
- Feature eligibility policy (V1: UI / read-path; no migrations, authz, billing).
- Only flags explicitly marked self-serve-eligible can be auto-enabled on match.
- Requester status feed is coarse stages only.
- Rate limits per user and per site, monthly cost cap, PII scrubbing, SMS only to verified
  owner numbers.

## MVP Slice (approved)

Widget → structured request → owner dashboard approve (passkey step-up) → GitHub issue →
owner runs `plan` / `build` locally → PR → on GitHub deployment event, flip requester's flag
via flagd/OpenFeature.

Deferred past MVP: percentage rollout, existing-feature matching, SMS/push, vendor adapters
beyond one.

## Planning Phases (approved)

| Step | Output | Agent |
|------|--------|-------|
| 1. Discovery | Prior art, subscription-auth feasibility, sandboxing, flag-vendor management APIs, GitHub integration model | Norwood |
| 2. Threat model | STRIDE + OWASP LLM Top 10, trust boundaries, abuse cases | Sentinel |
| 3. PRD → RFC | State machine, components (owns / does NOT own), MVP pullback, 10x | Arendt |
| 4. Contract review | SDK API, webhook signing, CLI, structured request schema | Postel |
| 5. Task breakdown | ≤15-point PR groupings across repos | Conway |
