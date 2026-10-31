# Discovery: soren-loop

Author: Norwood (discovery agent) · Date: 2026-10-30 · Status: Draft for owner review
Inputs: `00-project-brief.md` (ratified decisions 2026-10-30), `~/.claude/skills/tdd-pair/SKILL.md`

| File | Contents |
|------|----------|
| `01-discovery.md` (this file) | Executive summary, Q1 subscription-auth verdict, reuse plan, recommended stack and repo split, Integration Requirements, open questions |
| `02-research-findings.md` | Q2 to Q8 detail: prior art, feature flags, GitHub model, sandboxing, durable state, widget auth, approval UX |
| `03-architecture-and-risks.md` | ADRs, `/tdd-pair` OSS packaging plan, risk register, threat-model inputs for Sentinel, build strategy |

Convention: every external claim carries a URL. Anything I could not confirm from a primary source
is marked **UNVERIFIED**. Pages were read on 2026-10-30. Anthropic rewrote its auth policy page
twice in 2026, so treat the Q1 verdict as a snapshot with a re-check date, not as settled law.

---

## The One-Liner

An OSS, self-hosted control plane that turns an authenticated end user's feature request into an
owner-approved spec, has the owner's own Claude Code build it test-first on the owner's machine,
opens a convention-following PR, and turns the feature on for that requester when it deploys.

## Executive Summary

1. **Subscription auth works for the build step, and only for the build step.** Shelling out to
   the owner's own unmodified `claude` binary, signed in through Anthropic's own flow, is on solid
   ground. So is the Claude Code GitHub Action with an owner-generated `CLAUDE_CODE_OAUTH_TOKEN`.
   The Agent SDK in subscription mode inside a distributed product is not.
2. **The intake chat cannot run on the owner's subscription.** An LLM chat that end users talk to
   is the literal case of "routing requests through plan credentials on behalf of their users."
   Ratified decision #2 needs an amendment: intake uses an owner API key (Haiku-class, capped), or
   the widget is a structured form with no LLM. This is the most important finding in this doc.
3. **Closest prior art is Gleap Kai Code, not Copilot.** Gleap already ships feedback to PR to
   customer notification, including a "Bridge" that runs on the owner's machine with their own
   Claude Code subscription. soren-loop's differentiation is OSS and self-hosted, per-requester
   flag enablement and rollout, spec-first TDD with an auditor gate, and passkey approval gates.
4. **"No merge" cannot be done with GitHub permissions alone.** The merge endpoint needs only
   `Contents: write`, the same permission a push needs. Recommendation: the bot pushes to a
   **fork** and opens a PR upstream. That removes upstream write entirely, and fork PRs don't get
   repository secrets by default, which also covers "CI on agent PRs runs without secrets."
5. **Flags:** flagd, with the soren-loop database as the flag-definition source of truth,
   evaluated through stock OpenFeature providers. No custom evaluation provider needed. First
   vendor adapter: Unleash (OSS, self-hostable, fits the audience); LaunchDarkly second.
6. **State:** an explicit Postgres state machine with a transactional outbox and a Postgres job
   queue. No Temporal, no Inngest. The lifecycle is a long-lived domain entity with five actors,
   not a function that sleeps for days.
7. **Sandbox:** a git worktree per request inside the reference devcontainer with an egress
   allowlist. The built-in Bash sandbox is the no-Docker fallback, and Anthropic's own docs say
   it is not sufficient on its own for unattended runs.
8. **Repos:** three, not four. A control-plane monorepo (backend, dashboard, widget, SDK packages,
   flag adapters) plus a separate CLI-and-plugin repo, because the CLI has a different trust
   boundary and a different distribution channel.

---

## Q1. Subscription-Auth Feasibility (load-bearing)

### What Anthropic's current text says (verbatim, read 2026-10-30)

**Legal and compliance, Authentication and credential use**
(https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use):

> OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra,
> Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code
> and other native Anthropic applications.
>
> Developers building products or services that interact with Claude's capabilities, including
> those using the Agent SDK, should use API key authentication [...]. Anthropic does not permit
> third-party developers to offer Claude.ai login into their own applications, or to route
> requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover,
> developers may not collect, store, or intermediate Claude.ai credentials or session tokens —
> sign-in to a Claude account must complete through Anthropic's own flow.
>
> [...] Nor does it prevent an end user from signing in to the unmodified Claude Code binary with
> their own Claude subscription, including where a platform hosts Claude Code [...]

**Same page, Can customers offer Claude Code in their products?**
(https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products):
running Claude Code "in hosted sandboxes or other agent infrastructure" requires the operator to
accept the Commercial Terms. The binary must not be modified, no built-in auth method may be
removed, and the operator "may not pay for, resell, or intermediate Claude usage on their end
users' behalf." Each end user authenticates with their own credentials.

**Same page, Acceptable use** (`#acceptable-use`): "Advertised usage limits for Pro, Max, and
Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."

**Agent SDK overview** (https://code.claude.com/docs/en/agent-sdk/overview#get-started):

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai
> login or rate limits for their products, including agents built on the Claude Agent SDK.

**Help Center, Log in to your Claude account**
(https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account): the preferred
path for third-party tools "including open-source projects" is API keys. Anthropic "may at its
discretion" let subscribers use certain third-party tools but may bill that to usage credits.
"Use of third-party tools that misrepresent their identity to Anthropic's servers, attempt to
route third-party traffic against subscription limits [...] is prohibited."

**Authentication docs** (https://code.claude.com/docs/en/authentication#generate-a-long-lived-token):
`claude setup-token` mints a one-year, inference-only OAuth token "for CI pipelines, scripts, or
other environments where interactive browser login isn't available," used via
`CLAUDE_CODE_OAUTH_TOKEN`. It requires a Pro, Max, Ultra, Team, or Enterprise plan.

**GitHub Actions docs** (https://code.claude.com/docs/en/github-actions#example-use-cases):
"If you authenticate with a Claude subscription, replace the `anthropic_api_key` line [...] with
`claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`."

History, for context: in February 2026 the page explicitly banned subscription OAuth with the
Agent SDK (The Register, https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546).
That sentence is gone from today's page, but the SDK-overview note above still applies to
*products*. Enforcement against harnesses that spoofed Claude Code began in January 2026 (same
source). The policy moves, so it needs a scheduled re-check.

### Verdict per execution model

| # | Model | Verdict | Conditions soren-loop must hold |
|---|-------|---------|-----------------------------------|
| a | OSS CLI on the owner's machine shells out to the owner's installed `claude -p --output-format stream-json`, owner signed in via `/login` | **Permitted.** This is "an end user signing in to the unmodified Claude Code binary with their own subscription." | Never read `~/.claude` credentials or the Keychain entry. Never prompt for, store, or transmit a token. Never set a spoofed user agent or system-prompt identity. Invoke the stock binary only. |
| a′ | Same CLI, but as an always-on daemon that auto-pulls approved requests and builds unattended | **Gray.** Permitted mechanically, but it starts to look like "routing third-party traffic against subscription limits" and strains "ordinary, individual usage." | MVP: the owner starts every `build` by hand. Daemon mode is opt-in, defaults to API-key mode, and docs say why. |
| b | Owner's GitHub Actions runner using `anthropics/claude-code-action@v1` with `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | **Permitted.** Anthropic documents this exact configuration. | The owner creates the token and stores it in their own repo secret. soren-loop's backend never sees it. The workflow file lives in the owner's repo, and the owner enables it. |
| c | soren-loop CLI built on the Agent SDK, running on the owner's subscription | **Not permitted** for a distributed product without Anthropic approval ("offer [...] rate limits for their products, including agents built on the Claude Agent SDK"). | Agent SDK only in API-key mode. The SDK spawns the CLI anyway (https://code.claude.com/docs/en/agent-sdk/overview), so shelling out to `claude -p` gives up nothing important. |
| d | **Intake chat**: the backend runs an LLM conversation with end users | **Not permitted on a subscription.** This is "route requests [...] on behalf of their users" in the plainest reading. | API key (owner's own, billed to them), or a no-LLM structured form. See Open Question 1. |

**Future hosted platform:**

- **Orchestration-only control plane plus owner-run runners** (Terraform Cloud Agents model): the
  hosted service never touches Claude. Runners are model (a) or (b) on owner infrastructure.
  **Permitted** under the same conditions. This is the recommended hosted shape.
- **Hosted runners we operate**, running Claude Code with each owner's subscription: allowed by
  the "including where a platform hosts Claude Code" clause, **but** the operator must accept the
  Commercial Terms, sign-in must complete through Anthropic's flow inside the sandbox, and we may
  not "collect, store, or intermediate" tokens. That rules out a "paste your setup-token here"
  field. Feasible but heavy. Talk to Anthropic sales before building it (the page links to
  https://www.anthropic.com/contact-sales for exactly this question).

### Rate limits that shape an autonomous TDD loop

- Pro and Max have a **five-hour session limit and a weekly limit**. Ultra has no five-hour limit
  for verified accounts but keeps a weekly cap
  (https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan,
  https://support.claude.com/en/articles/17728952-what-is-the-ultra-plan).
- Anthropic does not publish token numbers for these windows. **UNVERIFIED** how many
  `/tdd-pair auto` batches fit in a window. A Zod review per phase boundary roughly triples the
  turns per batch, so expect a medium feature to take a large share of a Pro window.
- `setup-token` usage draws from the same quota as interactive use, so CI runs and the owner's
  daily coding compete (https://lalatenduswain.medium.com/claude-code-on-claude-max-plan-understanding-oauth-token-vs-api-key-authentication-in-2026-96a6213d2cde,
  secondary source).
- The stream emits `rate_limit_event` with `status`, `resetsAt`, `utilization`, and
  `errorCode: "credits_required"` when included usage is exhausted (Agent SDK type reference,
  https://code.claude.com/docs/en/agent-sdk/typescript#sdkratelimitevent; requires Claude Code
  v2.1.181+). **UNVERIFIED** that `claude -p --output-format stream-json` emits the same event
  shape. Spike it in Phase 1.

Design consequence: `building` needs a `paused_rate_limited` substate carrying `resetsAt`, and
the tdd-pair state file must be resumable after the window resets (it already is: `resume`).

### API-key fallback

The same CLI path with `ANTHROPIC_API_KEY` set; Claude Code prefers it over subscription OAuth
(precedence on https://code.claude.com/docs/en/authentication). It is required for: intake chat,
daemon mode, Agent SDK use, and any hosted runner we operate. Warn loudly when a stale
`ANTHROPIC_API_KEY` silently overrides the subscription.

### One more flag the owner needs to see

A secondary source reports that the Consumer Terms say EU, EEA, and Swiss users won't use
consumer plans "for any commercial or business purposes"
(https://autonomee.ai/blog/claude-code-terms-of-service-explained/). **UNVERIFIED** against
https://www.anthropic.com/legal/consumer-terms. If accurate, EU owners building a commercial app
on Pro or Max would need a Team plan or an API key. The README should say so plainly.

---

## Existing Components & Reuse Plan (greenfield: third-party and OSS)

| Need | Reuse | Why | Not chosen, and why |
|------|-------|-----|---------------------|
| Agent execution, local | Stock `claude` CLI, headless `-p`, `stream-json` (https://code.claude.com/docs/en/headless) | The only permitted subscription path; Anthropic maintains it | Agent SDK in subscription mode (not permitted); a custom harness (spoofing risk) |
| Agent execution, CI | `anthropics/claude-code-action@v1`, automation mode via `prompt` input (https://code.claude.com/docs/en/github-actions) | Official, supports OAuth token, already solves checkout, comments, and trigger auth | Reimplementing an Actions runner wrapper |
| TDD inner loop | The user's `/tdd-pair` skill, packaged as a Claude Code plugin (https://code.claude.com/docs/en/plugins/create-marketplace) | Existing, proven red/green/refactor engine with a resumable state file | OpenHands resolver (Python, model-agnostic, no spec gate) |
| Flag evaluation | OpenFeature React SDK and Node SDK, flagd providers, OFREP (https://openfeature.dev/docs/reference/sdks/client/web/react/, https://openfeature.dev/docs/reference/other-technologies/ofrep/) | Vendor-neutral; host apps may already use it | Writing our own provider (no need: flagd plus OFREP covers it) |
| Flag store, MVP | flagd (https://flagd.dev/reference/flag-definitions/) | OSS, JSON definitions, `fractional` rollout built in | Shipping our own evaluator |
| Flag store, vendors | Unleash Admin API, then LaunchDarkly semantic patch | See `02` §Q3 | |
| GitHub | GitHub App with Octokit (`@octokit/app`, `@octokit/webhooks`) | Short-lived, down-scopable tokens; bot identity | Fine-grained PAT (person-bound, long-lived) |
| Sandbox | Anthropic reference devcontainer (https://code.claude.com/docs/en/devcontainer), `@anthropic-ai/sandbox-runtime` (beta) | Maintained by the vendor; egress firewall included | Building our own container image from scratch |
| Durable state | Postgres plus a Postgres job queue (pg-boss or graphile-worker, **UNVERIFIED** current maintenance; check before picking) | One datastore for self-hosters | Temporal, Inngest (see `02` §Q6) |
| Passkeys | SimpleWebAuthn (`@simplewebauthn/server`, `@simplewebauthn/browser`) | De facto TypeScript WebAuthn library | Hand-rolled CBOR and COSE parsing |
| Widget identity | `jose` for JWT and JWKS verification | Standards-based, zero-dependency | Ad-hoc HMAC user-hash (see `02` §Q7) |
| Email | Nodemailer over SMTP behind a `Notifier` port | Works for any self-hoster | Vendor SDKs as hard dependencies |

Rule of Three: at design time there are three flag backends (flagd, Unleash, LaunchDarkly) and
two runners (local CLI, Actions). That earns a `FlagWriter` port and a `Runner` contract now.
Notifications have one channel in the MVP, so `Notifier` stays a thin interface with one
implementation and no plugin system.

---

## Recommended Stack and Repo Split

The brief's four-repo split puts "flag-write adapters" in the SDK. That's the wrong home: host
apps never write flags, the backend does. Putting adapters in a host-app SDK ships vendor
management credentials' code paths into customer bundles. Corrected split:

### Repo 1: `soren-loop` (control-plane monorepo, pnpm workspaces, changesets)

| Package | Role | Stack |
|---------|------|-------|
| `apps/server` | Backend API monolith: requests, state machine, approvals, GitHub App, webhooks, outbox, notifications, flagd sync endpoint | Node 22 LTS, TypeScript, Fastify, Postgres, Kysely or Drizzle, pg-boss, zod, Octokit, SimpleWebAuthn, jose |
| `apps/dashboard` | Owner dashboard (served as a static SPA by `server`, same origin) | React, Vite, TanStack Query |
| `packages/widget` | Embeddable chat widget: loader script, iframe app, React wrapper | Preact or React in the iframe, a tiny vanilla loader |
| `packages/node` | Host-backend SDK: `createWidgetToken(user)`, OpenFeature context helper | TypeScript, jose |
| `packages/react` | Host-frontend SDK: `<SorenLoopWidget getToken>`, OpenFeature provider wiring | TypeScript, React |
| `packages/flag-adapters` | `FlagWriter` port plus flagd, Unleash, and LaunchDarkly implementations (used by `server` only) | TypeScript |
| `packages/schema` | Structured request, spec, and status-event schemas (zod, exported as JSON Schema for the CLI) | zod |

One Docker image (`server` plus the dashboard bundle) plus Postgres plus flagd is the whole
self-hosted footprint. Same-origin dashboard keeps WebAuthn's RP ID and cookies simple.

### Repo 2: `soren-loop-cli` (CLI plus Claude Code plugin), own repo

Recommendation: **own repo.** Reasons:

1. **Trust boundary.** It runs on the owner's machine next to their source and their Claude
   login. Its supply chain deserves its own release signing, its own review rules, and a small
   dependency tree that's easy to audit.
2. **Distribution.** It ships twice: to npm (`npx soren-loop`) and as a plugin marketplace
   (`.claude-plugin/marketplace.json`) carrying the packaged `tdd-pair` skill and Ada and Zod
   agents (https://code.claude.com/docs/en/plugins/publish).
3. **Cadence.** It tracks Claude Code CLI releases and `stream-json` schema changes, not backend
   releases. Its only coupling to Repo 1 is the versioned HTTP API and `packages/schema`, which it
   consumes as a published npm package.

Stack: Node 22 TypeScript, `commander`, `execa` for spawning `claude`, a line-delimited JSON
stream parser, zod schemas from `@sorenai/loop-schema`. Commands: `login` (device flow against the
self-hosted backend, not Claude), `pull`, `plan <id>`, `build <id>`, `submit <id>`, `status`.

### Alternatives considered

- **Four repos as briefed:** more release coordination, and widget plus dashboard plus backend
  share schema types constantly. Rejected.
- **CLI inside the monorepo:** workable, and simpler for one maintainer. If the owner prefers
  that, keep it as `apps/cli`, but publish the plugin from a separate marketplace repo anyway,
  because plugin marketplaces are installed from a git repo root. See Open Question 6.

---

## Integration Requirements

### Data flow

**In (from existing systems):**

| Data | Source | Consumer |
|------|--------|----------|
| End-user identity (`sub`, display name) | Host app backend, signed JWT | Widget session, flag targeting key, rate limits |
| Repo conventions: PR template, CONTRIBUTING, CLAUDE.md/AGENTS.md, CODEOWNERS, commit style | Target repo | `plan` and `build` prompts, PR body |
| Owner identity plus passkeys | Dashboard enrollment | Approval gates |
| Claude login or API key | Owner's machine or owner's repo secret (never the backend) | `claude -p` |
| Deployment events | GitHub `deployment_status` webhook | `merged` → `deployed` transition |
| Flag vendor management credentials | Owner config in backend (encrypted at rest) | `FlagWriter` adapters |

**Out (produced for downstream consumers):**

| Data | Consumer |
|------|----------|
| Structured request (title, problem, acceptance criteria, eligibility class) | Owner approval page, GitHub issue body, `plan` input |
| tdd-pair six-section spec (the `plan` output) | Owner `plan_review`, then `build` input |
| `.claude/tdd-state.json` progress | CLI, mapped to coarse status events |
| PR (bot-authored, from fork) with flag key and request link | Owner review, CI |
| Flag definition plus per-user targeting rule | flagd / vendor, then host app evaluation |
| Coarse status events (stage name only) | Requester's widget status feed |

### Assumption alignment

- **"soren-loop" implies a closed loop.** A human reading the name assumes the requester
  actually gets the feature. That only happens if the agent's code is **gated behind the flag the
  backend will later flip**. So the `build` contract must inject the flag key, and a post-build
  check must verify the diff references it (a grep plus a test that the flag-off path hides the
  feature). Without this check, merge ships the feature to everyone, or to no one.
- **"Enable for requester" assumes the flag's targeting key equals the widget's `sub`.** The
  host app must set `targetingKey` in its OpenFeature evaluation context from the same user ID it
  puts in the widget JWT. `packages/react` and `packages/node` exist mainly to make that one line
  impossible to get wrong.
- **"Approve" assumes the owner sees what will be built.** The owner approves the structured spec
  with a content hash; `plan` and `build` must refuse to run on a spec whose hash differs from the
  approved one. Issue edits must not change what gets built.
- **"Deployed" assumes the merged commit is in the deployment**, not just that some deployment
  succeeded. Verify ancestry with the compare API.
- **Obvious-but-unstated:** the CLI needs the repo checked out locally, a clean default branch,
  the owner's Claude login, and network access to the backend. `soren-loop doctor` checks all
  four before `build`.

### End-to-end smoke test

> In the bundled demo app, signed-in user `u_123` opens the widget and asks for "a dark mode
> toggle on the settings page." The owner gets an email, opens the dashboard, approves the
> structured request with a passkey. The backend opens issue #12. The owner runs
> `soren-loop plan 12`; the spec appears in the dashboard and the owner approves it.
> `soren-loop build 12` runs `/soren-loop:tdd-pair auto` in a worktree inside the devcontainer.
> `soren-loop submit 12` pushes to the bot's fork and opens a PR that follows the repo's PR
> template and gates the toggle behind `fl-12-dark-mode`. The owner merges. The demo's GitHub
> Actions deploy job posts a `deployment_status: success` for production. The backend verifies
> ancestry, writes the flagd rule `targetingKey in ["u_123"]`. `u_123` reloads and sees the
> toggle; user `u_456` does not. The widget feed shows `enabled_for_requester`.

What's missing if this fails after the MVP: a demo app with a deploy workflow that emits GitHub
deployments, and the flag-reference verification step. Both belong in the MVP task list.

---

## Open Questions (need the owner's decision)

1. **Intake LLM vs. ratified decision #2.** The end-user chat cannot use the subscription.
   Options: (a) owner supplies an API key for intake only (Haiku-class model, cost cap already in
   the mitigations, likely cents per request); (b) MVP widget is a guided structured form with no
   LLM, and the owner's local `plan` step does the structuring; (c) both, with (b) as the default
   when no key is configured. Recommendation: (c).
2. **Daemon mode.** Is an always-on runner that builds approved requests unattended a V1 goal?
   It's the gray zone in the Q1 table. Recommendation: V1 is owner-initiated only.
3. **Fork-based PR model.** Accept that the bot pushes to a fork (cleanest least-privilege story)
   versus a branch on the upstream with ruleset protection? Forks of private org repos require the
   org to allow private forking.
4. **First vendor adapter:** Unleash (OSS audience fit) or LaunchDarkly (market share, best write
   API)?
5. **Hosted-platform intent.** Is "we operate hosted runners" on the roadmap, or only
   "orchestration plus owner-run runners"? The first requires accepting the Commercial Terms and
   should start with an Anthropic sales conversation.
6. **CLI repo:** separate repo (recommended) or `apps/cli` in the monorepo?
7. **Licensing and persona content.** `/tdd-pair` depends on Ada and Zod persona files that
   reference private knowledge files. What license (MIT, Apache-2.0), and how much of Ada and Zod
   is publishable as-is?
8. **EU owners.** Accept a README warning on the consumer-terms commercial-use question, or
   require Team or API-key mode for EU deployments? Needs the Consumer Terms text confirmed first.
9. **Policy re-check cadence.** Who re-reads the Anthropic pages before each release? Recommend a
   CI job that diffs the three cited pages and fails on change.
