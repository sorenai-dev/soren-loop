# Discovery: soren-loop, Research Findings (Q2 to Q8)

Companion to `01-discovery.md`. Read 2026-10-30. **UNVERIFIED** marks claims without a primary
source.

---

## Q2. Prior Art and Differentiation

| Product | What it does | Execution and credentials | Reusable? |
|---------|--------------|---------------------------|-----------|
| **Gleap Kai Code** (https://docs.gleap.io/documentation/kai-code/overview, https://www.gleap.ai/kai-code) | Ticket, bug report, or approved feature request becomes a planned change and a PR. It verifies in a running preview, then tells the customer after a deployment delay. | "Kai Code Cloud" runs in Gleap's sandbox, billed at API rates. "Kai Code Bridge" runs on the owner's computer or server using the owner's own Claude Code, Codex, or Cursor subscription. | No (closed SaaS). It **is the closest competitor** and proves the Bridge pattern is commercially viable. |
| **Claude Code GitHub Action** (https://code.claude.com/docs/en/github-actions) | `@claude` mentions (interactive mode), or a workflow `prompt` input (automation mode). | Owner's runner; API key, `CLAUDE_CODE_OAUTH_TOKEN`, or cloud provider. | **Yes.** Use it as Runner B instead of reimplementing. |
| **GitHub Copilot coding agent** (https://docs.github.com/copilot/concepts/agents/cloud-agent/about-cloud-agent) | Assign an issue to Copilot; it works on one branch and opens one PR per task. | GitHub-hosted Actions environment behind an agent firewall with an allowlist (https://docs.github.com/copilot/how-tos/agents/copilot-coding-agent/customizing-or-disabling-the-firewall-for-copilot-coding-agent). Copilot subscription. | Not as code. Reuse the **design**: firewall-by-default, a warning in the PR body when a request was blocked, workflow runs on agent PRs need approval (https://greenlitbooks.com/field-notes/is-github-copilot-coding-agent-safe, secondary). |
| **OpenHands resolver** (https://www.openhands.dev/blog/open-source-coding-agents-in-your-github-fixing-your-issues) | Label an issue `fix-me`; a GitHub Action attempts a fix and opens a PR, or leaves a branch with partial progress. | Actions, model-agnostic, API keys. | Pattern only: label-triggered runs and the "partial branch on failure" behavior. |
| **Devin** (https://devin.ai) | Hosted autonomous engineer triggered from Slack, issues, and its web app. | Vendor-hosted, vendor credits. | No. **UNVERIFIED** current trigger list; not re-checked. |
| **Sweep** | Began as issue-to-PR; **UNVERIFIED**, reportedly pivoted to an IDE assistant. | — | No. |
| **Canny / Featurebase / Productboard / ProductLift** (https://www.featurebase.app/customer-feedback, https://www.productlift.dev/best-feature-request-tool/) | Voting boards, roadmaps, "notify voters when shipped." | No build loop. | Future intake sources via webhook, not competitors for the build half. |

### Where soren-loop is differentiated

1. **Per-requester enablement.** Nobody above turns the feature on *for the person who asked*
   and then lets the owner widen rollout. Gleap notifies; soren-loop delivers.
2. **OSS, self-hosted control plane** with a Terraform-style path to hosted orchestration. Gleap
   Bridge proves owner-run execution works, but Gleap's control plane is closed.
3. **Spec-first TDD with an auditor gate.** `/tdd-pair auto` builds against a reviewed six-section
   spec with Zod gating every phase. The others go straight from issue text to a diff.
4. **Approval gates with passkey step-up** and a structured spec instead of raw chat text. This is
   a security posture none of the issue-to-PR tools advertise.

Honest assessment: (1) is the moat. (2) through (4) are good engineering that a funded
competitor could copy within a quarter. Lead the README with (1).

---

## Q3. Feature Flags

### Evaluation side (solved by OpenFeature)

- **React:** `@openfeature/react-sdk` with hooks like `useBooleanFlagValue` and a `<FeatureFlag>`
  component, plus `OpenFeatureTestProvider` for tests
  (https://openfeature.dev/docs/reference/sdks/client/web/react/). Back it with the OFREP web
  provider or `flagd-web`
  (https://openfeature.dev/docs/tutorials/open-feature-operator/advanced-topics/).
- **Node:** the OpenFeature server SDK with the flagd provider, in-process mode syncing
  definitions over `sync.proto` (same tutorial; https://flagd.dev/reference/specifications/providers/).
- **OFREP** is a protocol, not a provider: one HTTP API any vendor can implement
  (https://openfeature.dev/docs/reference/other-technologies/ofrep/). flagd serves it
  (`/ofrep/v1/evaluate/flags/{key}`).

So **soren-loop does not need its own evaluation provider.** `packages/react` and
`packages/node` only set the evaluation context's `targetingKey` from the same user ID used in the
widget JWT.

### Write side (OpenFeature doesn't cover it)

The OpenFeature spec explicitly describes evaluation only, not a definition language or management
API (https://github.com/orgs/open-feature/discussions/249). Every vendor needs an adapter.

| Vendor | Create flag | Target one user | Percentage rollout | Notes |
|--------|-------------|-----------------|--------------------|-------|
| **flagd** | Write JSON definition (https://flagd.dev/reference/flag-definitions/) | `targeting: {"if": [{"in": [{"var":"targetingKey"}, [ids...]]}, "on", "off"]}` | `fractional` op, salted by `$flagd.flagKey` for independence across flags (https://flagd.dev/reference/custom-operations/fractional-operation/) | No write API; flagd reads from file, HTTP, or gRPC sync sources. **Our backend is the source.** |
| **LaunchDarkly** | REST `POST /flags` | Semantic patch `addTargets` with `contextKind`, `values`, `variationId` (https://launchdarkly.com/docs/api/feature-flags/update-feature-flag) | `updateFallthroughVariationOrRollout` with `rolloutWeights` (same page) | Cleanest write API of the set. Semantic patch is intent-based, so concurrent edits compose. |
| **Unleash** | Admin API create feature, then add strategy per environment | Gradual rollout at 100% with a `userId IN [...]` constraint (https://docs.getunleash.io/concepts/activation-strategies) | Gradual rollout (flexible rollout) with stickiness | OSS and self-hostable. Docs warn that every constraint value increases payload size. |
| **GrowthBook** | REST API or `growthbook features create` CLI (https://www.growthbook.io/insights/growthbook-vs-flagsmith-vs-unleash) | Force rule with a targeting condition (https://docs.growthbook.io/features/rules) | Rollout rule | OSS. **UNVERIFIED** exact endpoint for appending a rule to an existing feature. |
| **Flagsmith** | Admin API | Identity override (https://docs.flagsmith.com/flagsmith-concepts/identities) | Segment percentage split | **UNVERIFIED** endpoint shape for identity overrides via the admin API. |
| **ConfigCat** | Public Management API (https://api.configcat.com/) | Targeting rule with a user condition | Percentage Options (https://configcat.com/docs/targeting/targeting-overview/) | The API can add, remove, and reorder targeting and percentage rules. |

### Recommendation

- **MVP default store: flagd, sourced from the soren-loop database.** Postgres holds flag
  records (key, request ID, self-serve-eligible flag, targeted user IDs, rollout percentage). The
  server renders a flagd-format JSON document and exposes it as an HTTP sync source that flagd
  polls. **UNVERIFIED** flagd's HTTP sync polling interval and auth-header options; check
  `flagd start --uri https://...` sync docs in the Phase 1 spike. gRPC sync (`sync.proto`) is the
  push-based upgrade.
- **Scaling note:** per-user ID lists grow the payload linearly (the same problem Unleash warns
  about). Cap explicit targets per flag (say 500) and push owners toward a percentage or segment
  rule past that. Explicit targets are for "the requester plus a few testers," not for rollout.
- **`FlagWriter` port** (in `packages/flag-adapters`):
  `ensureFlag(key, meta)`, `enableFor(key, targetingKeys[])`, `setRollout(key, pct)`,
  `enableAll(key)`, `disable(key)`, `describe(key)`. All writes are idempotent and keyed by
  request ID, so a retried outbox job can't double-apply.
- **First vendor adapter: Unleash.** The likely early adopters are self-hosters who already run
  OSS infrastructure, and Unleash is the most common OSS flag server with an OpenFeature provider.
  **LaunchDarkly second.** Its semantic patch maps one-to-one onto `FlagWriter`, so it is the
  cheapest adapter to write well. This is Open Question 4 in `01`.

---

## Q4. GitHub Integration Model

### App vs. fine-grained PAT

| | GitHub App | Fine-grained PAT |
|-|-----------|------------------|
| Token lifetime | Installation tokens expire after an hour and can be **narrowed at mint time** to specific repos and permissions (https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app) | Up to the owner-set expiry; a person's credential |
| Identity | `soren-loop[bot]`, separate from the owner | The owner |
| Webhooks | Built in, signed | Separate repo webhook setup |
| Required reviews | The owner can approve a bot-authored PR | The owner cannot approve their own PR, which breaks solo-dev required-review setups |

**Recommendation: GitHub App.** The backend holds the App private key and mints a per-operation,
per-repo, minimum-permission token for each action. The CLI never holds a long-lived GitHub
credential. It asks the backend for a token scoped to "push to this fork" at `submit` time.

### Least privilege, and the merge problem

The merge endpoint requires only **`Contents: write`**
(https://docs.github.com/rest/pulls/pulls#merge-a-pull-request--fine-grained-access-tokens),
the same permission needed to push a branch. So "can open PRs but cannot merge" is **not
achievable with permissions alone** on a single repo.

Two ways out:

- **Option A, fork model (recommended).** The App owns or is installed on a fork. It pushes to the
  fork (`Contents: write` on the fork only) and opens a PR upstream. Upstream permissions:
  `Metadata: read`, `Contents: read`, `Pull requests: write`, `Issues: write`,
  `Deployments: read`. With no upstream write, it can't merge or push to `main`. As a bonus,
  "secrets are not passed to the runner when a workflow is triggered from a forked repository"
  (GitHub Actions docs; for private repos the org setting to send secrets to fork PRs is off by
  default). That covers the "CI on agent PRs runs without secrets" mitigation for free.
  **UNVERIFIED:** that an App can open a cross-repo PR from a fork head with only
  `Pull requests: write` upstream. Spike it first; it decides the whole model.
- **Option B, same-repo branch plus rulesets.** `Contents: write` upstream, plus a repository
  ruleset on the default branch requiring a PR and one approving review, with the App excluded
  from bypass. Workable, but it depends on owner configuration that soren-loop can't enforce,
  and same-repo PRs **do** receive secrets, so CI hardening becomes the owner's job.

**Workflows:** never grant the `Workflows` permission. GitHub rejects pushes that create or modify
files under `.github/workflows/` from tokens without it. **UNVERIFIED** in the current docs; I'm
relying on long-standing behavior. Add a test to the spike.

### "Deployed" transition

Subscribe to `deployment_status` (needs `Deployments: read`). On `state: success` for the owner's
configured production environment, check that the request's merge commit is an ancestor of the
deployed SHA with `GET /repos/{o}/{r}/compare/{merge_sha}...{deploy_sha}` (status `ahead` or
`identical`). Fallbacks for hosts that don't create GitHub deployments: a signed
`POST /v1/deployments` webhook the owner's CD can call, and a manual `soren-loop mark-deployed`.
**UNVERIFIED** which hosts (Vercel, Netlify, Render, Fly) create GitHub deployments by default.

### Issues as system of record?

**No: the backend DB is canonical; the GitHub issue is a projection.**

- Issues are editable by any collaborator, and issue text is a known prompt-injection vector into
  Claude workflows (https://flatt.tech/research/posts/poisoning-claude-code-one-github-issue-to-break-the-supply-chain/).
  The agent must build from the hash-pinned approved spec fetched from the backend, never from the
  issue body.
- Public repos would expose requester data. The issue gets the structured spec and a pseudonymous
  request ID only.
- The state machine has states (`needs_info`, `plan_feedback`, rollout states) that labels can
  mirror but not enforce.

Labels like `soren-loop:building` are a one-way mirror for the owner's convenience.

### PR templates and conventions

The CLI reads them from the local checkout (no API call needed):
`.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE/*.md`,
`PULL_REQUEST_TEMPLATE.md` at the root or in `docs/`, `CONTRIBUTING.md`, `CLAUDE.md`, `AGENTS.md`,
`CODEOWNERS`, plus commit-style inference from `git log -50 --format=%s`. The `submit` step fills
the template; it doesn't replace it.

---

## Q5. Agent Sandboxing on the Owner's Machine

Anthropic's own comparison (https://code.claude.com/docs/en/sandbox-environments):

| Option | Isolates | Docker | Unattended-safe? | Trade-off |
|--------|----------|--------|------------------|-----------|
| **Built-in sandboxed Bash** (`/sandbox`, `sandbox.network.allowedDomains`) | Bash, PowerShell, and Monitor commands and their children only | No | **No.** Docs: "not sufficient for fully unattended runs." File tools, MCP servers, and hooks run outside it. | Minimal setup on macOS. Good second layer. |
| **`@anthropic-ai/sandbox-runtime`** | The whole Claude Code process (Seatbelt or bubblewrap) | No | Yes, per docs | **Beta research preview**; config format may change. |
| **Dev container** (https://code.claude.com/docs/en/devcontainer) | Full dev environment; reference image includes an egress firewall | Yes | Yes | Medium setup; owners need Docker; per-repo toolchains must be in the image. |
| **VM** | Full OS | No | Yes | Heavy. The right call for untrusted repos. |
| **Git worktree** | Nothing. Separate working copy only. | No | — | Not isolation. Use it for a clean branch per request and safe concurrency. |

Two documented facts that shape the design:

- `--dangerously-skip-permissions` must run inside a container, VM, or sandbox runtime, and
  Claude Code refuses to start with it as root (same page).
- Isolation doesn't change what is sent to the model. Files the agent reads still go to Anthropic
  (same page).

### Recommendation

1. **Default:** a worktree per request (`.soren-loop/worktrees/<id>`) mounted into the reference
   devcontainer. Egress allowlist: the Anthropic API plus the repo's package registries. **No
   GitHub write from inside**; the push happens in `submit`, outside the container, with a
   just-minted App token. No host env vars pass through except the Claude auth variable.
2. **No-Docker fallback:** `sandbox-runtime` wrapping `claude`, plus the sandboxed Bash tool with
   the same allowlist. Label it "beta" in `doctor` output.
3. **Claude auth inside the container:** the owner either runs `/login` inside the container
   (Anthropic's flow, credentials stay in the container volume) or exports their own
   `CLAUDE_CODE_OAUTH_TOKEN`, which the CLI forwards from the owner's shell into the container env
   **without persisting or transmitting it**. Both are owner provisioning on owner hardware, which
   the legal page allows. Document both.
4. Use `--permission-prompts none` for unattended runs so prompts are denied instead of hanging
   (https://code.claude.com/docs/en/headless#turn-off-permission-prompts-in-unattended-runs).

Residual risk Sentinel should own: registry access is an exfiltration channel, and any approach
that allows egress "can still leak data the agent can read" (Anthropic's warning). **UNVERIFIED**
the full list of domains Claude Code needs; take it from the reference devcontainer's firewall
script rather than guessing.

---

## Q6. Durable Workflow and State

| | Postgres state machine + outbox + PG queue | Inngest (self-hosted) | Temporal | DBOS Transact |
|-|--------------------------------------------|-----------------------|----------|---------------|
| Extra infra for self-hosters | None beyond Postgres | Inngest server plus Redis plus Postgres (https://www.inngest.com/docs/self-hosting); `inngest start` is labeled beta | Temporal cluster plus its DB plus workers | None (a library on your Postgres) |
| Waits of days | A row in a state; timers as scheduled jobs | `step.waitForEvent` | Signals and timers | Durable delays persisted in the DB (https://www.dbos.dev/blog/dbos-new-features-april-2026) |
| Fit to this domain | Request is a long-lived aggregate driven by five actors (requester, owner, CLI, GitHub, flag store) | Function-shaped; actors become events | Function-shaped; determinism rules on workflow code | Function-shaped, transactional with business data |
| Debuggability | `SELECT` the row | Inngest UI | Temporal UI | DBOS tables |

**Recommendation: an explicit Postgres state machine.** One `requests` table with `state` and
`version` (optimistic concurrency), a `request_transitions` audit table, a table-driven transition
map with guard functions (`from`, `event`, `to`, `guard`, `effects`), a transactional outbox for
side effects (notifications, GitHub writes, flag writes), and pg-boss or graphile-worker to drain
the outbox and run reminder or timeout jobs.

**The cost, named:** we own retry, backoff, timeout, and idempotency code that Temporal or Inngest
would provide, and every illegal-transition path needs a test. Mitigations: idempotency keys on
every outbox effect; property-based tests that random event sequences never reach an undeclared
state; a nightly reconciler that compares GitHub PR state with request state and repairs drift.

**Escape hatch:** if `plan` or `build` orchestration ever moves server-side (hosted runners), DBOS
is the first thing to evaluate, because it adds durable steps without new infrastructure.

**Tenancy seam:** `site_id` (tenant) on every row from day one, so Postgres row-level security can
be turned on for the hosted platform without a migration rewrite.

---

## Q7. Embeddable Widget Auth

### Identity: host-issued signed JWT, exchanged for a widget session

1. The owner registers a site in the dashboard and uploads a public key or a JWKS URL. The private
   key stays in the host app's backend.
2. The host page passes `getToken: () => Promise<string>` to the widget. It calls the host's own
   backend, which uses `createWidgetToken(user)` from `@sorenai/loop-node`.
3. Token claims: `iss` = site ID, `aud` = `soren-loop`, `sub` = stable opaque user ID (the same
   value used as the OpenFeature `targetingKey`), `exp` at most 5 minutes out, `iat`, `jti` for
   replay protection, and an optional display name. Asymmetric `ES256` or `EdDSA`, verified with
   `jose`.
4. The widget exchanges it at `POST /v1/widget/sessions` for a short-lived soren-loop session
   token bound to `(site_id, sub)`. This is an RFC 8693-style token exchange
   (https://www.rfc-editor.org/rfc/rfc8693). Refresh means calling `getToken` again; no
   long-lived widget credential exists.

Never accept identity from widget props, `data-` attributes, or URL params. Rejected
alternative: Intercom-style HMAC "user hash." It's simpler, but it's a shared symmetric secret
with no built-in expiry, and leaking it lets anyone mint any identity.

### Embedding: script-tag loader plus iframe

| | Iframe on the soren-loop origin | Shadow DOM in the host page |
|-|-----------------------------------|-----------------------------|
| Isolation from host-page scripts | Strong (separate origin) | None (same JS realm; host scripts can read the session token and tamper with the DOM) |
| Host CSP changes | `frame-src` for our origin | `script-src` and `connect-src` for our origin, maybe `style-src` |
| Style isolation | Complete | Good, not perfect (inherited properties leak) |
| Cost | Sizing and `postMessage` plumbing; no third-party cookies (keep tokens in memory) | Lightweight, easy theming |

**Recommendation:** a tiny vanilla loader script renders the launcher button (shadow DOM is fine
there) and opens the chat panel in an **iframe**. The session token lives only inside the iframe.
`postMessage` carries the `getToken` handshake with strict `event.origin` checks on both sides.
The widget origin sends `Content-Security-Policy: frame-ancestors <registered site origins>` per
site, so the widget can't be embedded and clickjacked elsewhere. `@sorenai/loop-react` wraps the
same loader as `<SorenLoopWidget getToken={...} />`.

Why the stronger boundary is worth it here: the chat transcript feeds an agent pipeline with repo
write access downstream. Host-page XSS shouldn't be able to impersonate the requester into it.

---

## Q8. Owner Approval UX Security

### WebAuthn step-up on every approval

- Approval links in email go to an **authenticated dashboard page**. The GET is side-effect free,
  because link scanners prefetch GETs (already in the brief's mitigations).
- Clicking Approve starts a WebAuthn `get()` whose server challenge is bound to the action: the
  challenge record stores `(owner_id, request_id, action, spec_sha256, expires_at)`, is single-use,
  and expires in about 2 minutes. The POST is accepted only if the assertion verifies,
  `userVerification` is `required` and the UV flag is set, origin and RP ID match, and the bound
  `spec_sha256` equals the current spec. That last check defeats "approve, then swap the spec."
- Library: SimpleWebAuthn server and browser packages (https://simplewebauthn.dev). Spec:
  W3C WebAuthn Level 3 (https://www.w3.org/TR/webauthn-3/).
- Synced passkeys are fine. Require **two** registered authenticators, or one plus printed
  recovery codes, at owner enrollment. A lost passkey on a single-owner self-hosted install is
  otherwise a database-surgery recovery.
- Same-origin dashboard and API keeps the RP ID simple. If the dashboard ever moves to its own
  subdomain, set the RP ID to the registrable parent domain from day one.

### Notification channels

| Phase | Channel | Implementation |
|-------|---------|----------------|
| MVP | Email | `Notifier` port, SMTP via Nodemailer; outbox-driven, so a failed send retries and never blocks a transition |
| Later | Web Push | VAPID push to the installed dashboard PWA; no third party needed for self-hosters |
| Later | SMS | Twilio Verify (or equivalent) to verify owner numbers first; send only to verified owner numbers (per the brief); never put approval tokens in SMS bodies |

Notification content follows the same rule as the requester feed: a stage name, the request
title, and a dashboard link. No spec contents, no repo names in email subjects.
