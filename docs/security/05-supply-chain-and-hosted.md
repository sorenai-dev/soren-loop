# Threat Model 05: Supply Chain (TB13) and Self-Hosted vs Hosted

---

## 1. What we distribute, and what a compromise of each buys

| Artifact | Channel | Runs where, with what privilege | Compromise buys |
|----------|---------|---------------------------------|-----------------|
| `soren-loop` CLI | npm | Owner machine, **outside** the sandbox; holds CLI tokens; pushes with App tokens | Code execution on every owner's workstation (AS10), plus their GitHub push path |
| Claude Code plugin (tdd-pair, plan skill, Ada, Zod) | Plugin marketplace (a git repo), and/or bundled in the CLI package | Inside the sandbox, as **agent instructions** with pre-approved tools | Prompt-level control of every build (LLM03): write backdoors that pass Zod |
| Ada and Zod personas, tdd-pair skill | Sourced from `github.com/mandelbro/agent-workflow-kit` (Decision 11) | Same as the plugin | Same as the plugin |
| `@sorenai/loop-node` | npm | Host backend; **signs JWTs with the host's private key** | Steals host signing keys, so it can impersonate any end user; RCE in host backends |
| `@sorenai/loop-react`, `packages/widget` | npm | Host frontend bundles | XSS in every host app |
| Widget loader script | Served from the control-plane origin to host pages | **In the host page's origin** | XSS on every host page served by that control plane (the Polyfill.io 2024 incident class) |
| Server image | Container registry | Owner infrastructure; holds the App key, vendor credentials, intake key | Everything in Z2 |
| GitHub App manifest | Our repo, used by owners to create their App | Defines the permissions owners grant | Permission creep, if owners accept a changed manifest without reading it |

### Observations on the current state of agent-workflow-kit (read 2026-10-30, local clone)

- `release.yml` publishes to PyPI with **trusted publishing** (`id-token: write`) and
  **commit-SHA-pinned actions**. Good baseline.
- `ci.yml` uses **tag-pinned** actions (`actions/checkout@v6`, `astral-sh/setup-uv@v7`).
  Low risk because CI holds no secrets, but it is inconsistent with the release workflow.
- `workflow_dispatch` lets anyone with write access publish **any** tag. Whether the `pypi`
  environment has required reviewers is **UNVERIFIED** (that is a repository setting).
- `CODEOWNERS` is a single maintainer. That is the bus factor and also the single
  credential to compromise.
- **The tdd-pair skill is not in agent-workflow-kit.** It exists only at
  `~/.claude/skills/tdd-pair/SKILL.md` and references `/Users/montes/.claude/agents/*.md`. The
  public `Ada.md` (32 lines) and `Zod.md` (34 lines) contain no private paths. Decision 11's
  "reuse from there" covers the personas but not the skill yet.
- Its `allowed-tools` pre-approves `Bash, Write, Edit, Task, ...`. Workspace trust never gates
  a skill's `allowed-tools` (code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder),
  so in soren-loop the sandbox, not the tool list, is the boundary. That is acceptable only
  with SR-02.

## 2. Supply-chain threats and controls

| ID | Threat | L | I | Control | Status | Residual |
|----|--------|---|---|---------|--------|----------|
| SC1 | npm publish token theft or a maintainer-account takeover publishes a malicious CLI or SDK (2025 saw self-propagating npm worms that stole publish tokens; specifics **UNVERIFIED** here) | M | H | npm **trusted publishing (OIDC)** with no long-lived tokens; `--provenance` attestations; 2FA enforced on the org; release from a protected environment with a required reviewer; SHA-pinned actions everywhere | N | L |
| SC2 | A plugin marketplace update changes agent behaviour silently | M | H | **Do not install the plugin from the marketplace for soren-loop builds.** The CLI passes the plugin directory from its own installed npm package (one provenance chain) and verifies a content hash before each run. The marketplace remains for interactive users. Plugin auto-update behaviour is **UNVERIFIED**; S3 checks it. | **N** | L |
| SC3 | A persona or skill change upstream (agent-workflow-kit) is pulled in unreviewed | M | H | **Vendor at a pinned commit.** A sync script records the source repo, commit SHA, and per-file SHA-256 in `plugin/VENDORED.json`. Sync PRs show the prompt diff and require review. Never fetch personas at runtime. Publish tdd-pair to the kit first, or own it in soren-loop-cli (Open question Q8). | **N** (DC8) | L |
| SC4 | **Name and account takeover or squatting** (decision 31). Our names: npm `soren-loop`, `soren-loop-cli`, and the **`@sorenai` scope** (`@sorenai/loop-react`, `-node`, `-schema`); the **`sorenai-dev` GitHub account** (`sorenai-dev/soren-loop`, `sorenai-dev/soren-loop-cli`); the plugin marketplace name `soren-loop`; the domain `sorenai.dev`, including `loop.sorenai.dev`, which hosts the error-type URIs. Likely squats: `sorenai`, `soren-ai`, `sorenaidev`, `sorenloop`, `soren_loop`, `@soren-ai`. | M | H | Reserve the `@sorenai` npm org and the unscoped names now, with 2FA required and trusted publishing only. Register the likely squats as defensive names. `sorenai-dev` is a GitHub **user** account (not an org). That means one credential controls every suite repo, there is no member 2FA enforcement, and an org-verified domain isn't available. Protect it with passkey or hardware-key 2FA, recovery codes stored offline, fine-grained PATs only, rulesets on default branches, and private vulnerability reporting. **Decision 33: it converts to an organization before the first public release.** After conversion: require 2FA for all members, keep at least two owners for recovery, verify the `sorenai.dev` domain, give each product's repos and publish rights their own team, and review the org audit log. The bot fork account stays separate either way. **The bot fork account must not be `sorenai-dev`** (S1 F1 requires a bot-only fork). Domain: registrar lock, DNSSEC, CAA records, and no dangling CNAMEs (subdomain takeover of `loop.sorenai.dev` would serve attacker content at our error URIs). Docs give exact install commands. | N | L |
| SC5 | Loader script tampering | L (self-hosted) / M (hosted) | H | An immutable versioned path (`/loader/v1.4.2.js`) with an SRI `integrity` attribute in the documented snippet; or the host bundles the loader from `@sorenai/loop-react`. Never a "latest" loader. | **N** | L |
| SC6 | Server image tampering, or a mutable base image | L | H | Digest-pinned base; signed images (Sigstore cosign) plus SLSA provenance via GitHub artifact attestations; SBOM per release | N | L |
| SC7 | The reference devcontainer or Claude Code binary drifts | M | M | Pin the devcontainer by commit and its image by digest; install Claude Code at a pinned minimum version with checksum verification in the image; a CI matrix against latest (R8) | D + N | L |
| SC8 | App manifest permission creep | L | M | The manifest lives in the repo under CODEOWNERS; changes need a security review label; `doctor` diffs the installed App's permissions against the expected minimum and warns on extras | N | L |
| SC9 | Over-broad dependencies in `@sorenai/loop-node` widen the host-backend blast radius | M | M | A dependency budget: `jose` plus the OpenFeature SDK only; no install scripts; reviewed with `npm ls` in CI | N | L |
| SC10 | The policy-diff job (Decision 13) is abused | L | L | It runs with `issues: write` only; it fetches and diffs text, and never feeds fetched content to an agent with tools | N | L |

## 3. Self-hosted (V1) vs hosted orchestration (Decision 9)

The hosted platform orchestrates only; runners stay on owner machines or owner CI. That keeps
the Claude-credential and source-code threats on the owner side. It does **not** keep the
hosted platform low-value. It becomes a single point that issues build instructions to every
customer's runner and serves script to every customer's host pages. The SolarWinds and
Polyfill.io incident classes apply.

| Threat area | Self-hosted V1 | Hosted: what changes | Required hosted control |
|-------------|----------------|----------------------|-------------------------|
| Approval forgery / malicious spec distribution (T7.3) | One owner's server; attacker needs that host | **One compromise reaches every tenant's runner** | **MUST**: runner-verified approval receipts (SR-19); runners execute only fixed verbs (`plan`, `build`) on receipt-verified specs. The protocol has **no "run this command" message type**, by design. |
| Tenant isolation | `site_id` scoping (multi-site, one owner) | BOLA becomes cross-customer | Postgres RLS on `site_id` / `tenant_id`, plus app-layer checks (both); a per-route cross-tenant negative test suite in CI; key binds to tenant at validation (`security-patterns.md`) |
| GitHub App key (T10.7) | Each owner creates their own App from our manifest; per-owner key | Two shared Apps (decision 25) mean **two private keys covering all tenants**. A push-App key reaches every tenant's fork. | KMS or HSM signing of App JWTs (the key is never in process memory); per-tenant installation-token minting audited; consider per-tenant Apps via the manifest flow for enterprise |
| Widget loader (SC5) | Owner's own origin | One CDN serving every tenant's host pages | SRI-pinned loader mandatory; a per-tenant widget origin (`<tenant>.widget.example`) so `frame-ancestors` and storage are per tenant |
| JWKS fetch SSRF (T2.4) | Owner network | Cloud metadata reachable from a shared fetcher | Dedicated egress-only fetcher with no IAM role; IMDSv2-only with a hop limit of 1; the three-layer SSRF defense |
| Secrets at rest (T4.2) | One `.env` key | Every tenant's intake API keys and vendor tokens | Per-tenant data keys under KMS envelope encryption; decrypt only in the worker processing that tenant's job |
| Runner credentials | CLI device-flow tokens to the owner's server | Runner tokens to our platform | Outbound-only runners; runner tokens scoped to tenant and repo, sender-constrained (DPoP), rotated, listed and revocable; jobs signed by the platform and receipt-verified |
| Abuse and cost (AB1, AB4, AB7) | Owner's problem | Our email reputation and our moderation duty | Per-tenant sending domains or subdomains; tenant-level quotas; abuse reporting; trust and safety process |
| Insider access | n/a | Our staff can read request text and specs | Access through audited break-glass only; specs encrypted per tenant; operators have no access to runner hosts |
| Privacy / compliance | Owner is controller and processor | We become a processor of requester PII | DPA, retention limits, deletion by `sub`, subprocessor list (email, LLM in intake mode); SOC 2 scope |
| Noisy neighbour / DoS | n/a | One tenant's flood degrades others | Per-tenant rate limits and worker partitioning (outbox per tenant), circuit breakers |
| Anthropic terms | Owner runs `claude` | Orchestration only is permitted per `01` §Q1. Hosted *runners* need the Commercial Terms. | Keep runners owner-side (Decision 9). Any hosted-runner work starts with Anthropic (R1). |

Unchanged in hosted mode: everything in TB8 and TB9 (owner machine, sandbox, repo content),
and G3 review.
