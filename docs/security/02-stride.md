# Threat Model 02: STRIDE per Trust Boundary

Boundaries and flows are defined in `01-system-model.md`. Requirement IDs (`SR-nn`) are in
`06-requirements-tests-spikes.md`.

**Round 6 update (2026-10-31).** The Zod and Postel RFC reviews are folded in: T2.7, T8.16, T8.17, T10.14, and PC10; SR-02, SR-07, SR-09, SR-19, SR-26, SR-27, SR-36, SR-37, and SR-41 are revised; ST-63 to ST-72 are new.

**Round 5 update (2026-10-30).** Decisions 26–31 are ratified, and RFC `14` is reviewed (T6.5, T6.6, T12.4, T12.5; SR-39, SR-40). Ratified: the PR App set (T10.13), hardened interactive builds (SR-38), SU-2, FL-1 and AU-1 (SR-35 to SR-37), the notification policy, and the rename to soren-loop.

**Round 4 update (2026-10-30).** Decisions 24 (S1 passed, fork model stands) and 25 (two GitHub
Apps) are ratified. RFC findings CLI-H1, CLI-H2, and SU-1 are folded in as T5.8, T8.9 to T8.14,
and T10.11 to T10.13 (SR-28, SR-29, SR-04).

**Round 3 update (2026-10-30).** DC1–DC8 and decisions 14–23 are ratified
(`00-project-brief.md`, Round 3 table). Read every row tagged **N (DCx)** as **R**. An
`A→B` likelihood (for example `M→L`) gives the likelihood before and after the decision 23
pre-check (SR-26). The Risk column stays inherent. Residual does not drop on the pre-check's
account alone, because its LLM layer can be evaded by design (`03` §7).

**Legend.** L = likelihood, I = impact (L/M/H). Risk is the inherent risk before controls:
C = critical, H, M, L. **Status** says where the mitigation comes from: **R** = in the brief's
ratified mitigations, **D** = recommended in discovery but not ratified, **N** = new in this
model. **Residual** is the risk after the listed mitigation.

---

## TB1: Host page ↔ widget iframe

| ID | S/T/R/I/D/E | Threat | L | I | Risk | Mitigation | Status | Residual |
|----|------|--------|---|---|------|------------|--------|----------|
| T1.1 | S | Host-page XSS calls `getToken` and drives the widget as the logged-in user | M | M | M | Accept. Host XSS already owns that user in the host app. The iframe keeps the longer-lived session token out of host JS. Per-user caps (SR-11) bound the damage. | D | M: an impersonated request is still possible, and it still has to pass owner gates |
| T1.2 | S/T | A forged `postMessage` into the iframe (wrong origin, or a frame of a frame) injects a token or commands | M | M | M | Check `event.origin` against the site's registered origins on both sides. Use a `MessageChannel` port after the handshake. The iframe accepts only a token and theme from the host. | D | L |
| T1.3 | E | The widget is framed on an attacker site and clickjacked, for example into submitting a prefilled request | L | L | L | `frame-ancestors` per site; no auto-submit; the request is typed in the iframe | D | L |
| T1.4 | I | Widget and dashboard share an origin, so XSS in the widget (for example via LLM output, LLM05) runs on the origin that holds owner routes and the WebAuthn RP | L | H | M | Serve the widget from a **separate host** from the dashboard and API owner routes. Owner cookies `__Host-`, `SameSite=Strict`. The widget origin serves no owner routes. | **N** (DC6) | L |
| T1.5 | T | A compromised loader script (served by our origin, it runs **in the host origin**) gets XSS on every host page | L | H | H | Version the loader at an immutable URL, with an SRI hash in the snippet, or bundle it from npm (`05` SC5) | **N** | L self-hosted; **H in hosted** |

## TB2: Host backend ↔ control plane (identity)

| ID | STRIDE | Threat | L | I | Risk | Mitigation | Status | Residual |
|----|--------|--------|---|---|------|------------|--------|----------|
| T2.1 | S | JWT forgery by algorithm confusion, `alg: none`, or an unverified `kid` | M | H | H | `jose` with an explicit `algorithms: ["ES256","EdDSA"]`; `iss` maps to exactly one site; `aud = soren-loop`; keys come from that site's JWKS only | D | L |
| T2.2 | S | JWT replay: a token captured from logs or a proxy is reused | M | M | M | `exp` no more than 5 minutes out; a `jti` replay cache per site for the token's lifetime; exchanged once | D | L |
| T2.3 | S | The host's signing key leaks, so an attacker can impersonate any end user | L | M | M | JWKS rotation is supported (multiple `kid`s); a dashboard "revoke key" action; anomaly alert on a `sub` spike | N | M. Impact is bounded because impersonation only yields requests, never repo access. |
| T2.4 | I/E | **SSRF via the JWKS URL**: points at cloud metadata or an internal service | M | H | H | The three-layer SSRF defense from `security-patterns.md`: HTTPS only; resolve and block private and link-local ranges at registration *and* at fetch time; egress-segmented fetcher; no credentials on the fetcher; size and time limits | **N** | L |
| T2.5 | T | `sub` mismatch with the OpenFeature `targetingKey` enables the feature for the wrong user | M | M | M | `@sorenai/loop-node` and `@sorenai/loop-react` derive both values from one input; a smoke test asserts the targeted user sees the feature and a non-targeted user does not | D | L |
| T2.6 | S | The display-name claim is used for social engineering (`"Owner (admin)"`, homoglyphs) | M | L | L | Display names are labelled as host-asserted, shown next to the opaque `sub`, and Unicode-confusable-checked | N | L |
| T2.7 | S | **JWT replay across installs or token types.** A widget JWT minted for staging is replayed at prod, or another host JWT signed by the same key is accepted (the `aud` was a shared constant) | M | M | M | Per-install `aud`, required `typ: sl-widget+jwt`, `kid` required, 30 s leeway (SR-07) | N | L |

## TB3: Intake LLM (Phase 2, API-key mode)

| ID | STRIDE | Threat | L | I | Risk | Mitigation | Status | Residual |
|----|--------|--------|---|---|------|------------|--------|----------|
| T3.1 | T | Direct injection makes the intake LLM emit a structured request that misstates scope or eligibility | H→M | M | H | Intake output is a draft only. Zod validates the schema; eligibility is never taken from the LLM; the owner sees the transcript **and** the structured request side by side, with a diff. The SR-26 pre-check runs at intake in API-key mode (decision 23). | R (spec, not raw chat; dec. 23) + N | M. Carries forward into the `03` pipeline; the classifier is evadable. |
| T3.2 | I | Cross-session leakage: one requester's transcript appears in another's context | L | M | L | A stateless call per session; no shared memory; no retrieval over other users' requests | N | L |
| T3.3 | D | Cost exhaustion of the owner's API key | H | M | H | Per-user and per-site limits; a monthly hard cap that falls back to form mode; maximum turns and tokens per session | R | L |
| T3.4 | E | The intake LLM is given tools | L | H | M | **No tools** for the intake model. It returns text or JSON only. | N | L |
| T3.5 | R | Owner account standing: abusive end-user content is sent on the owner's key | M | M | M | Document it; block users; cap per user; keep the transcript for owner review (`04` AB4) | N | M |

## TB4: Control plane ↔ Postgres

| ID | STRIDE | Threat | L | I | Risk | Mitigation | Status | Residual |
|----|--------|--------|---|---|------|------------|--------|----------|
| T4.1 | T | SQL injection through request fields | L | H | M | Query builder with bound parameters only (Kysely or Drizzle); a lint rule against raw SQL | D | L |
| T4.2 | I | A DB dump exposes vendor credentials, the intake key, or CLI tokens | M | H | H | Envelope-encrypt secrets with a key held outside the DB (env or KMS). CLI tokens are stored as peppered HMAC. The App private key is never stored in the DB. | R (encrypted at rest) + N | M. The self-hosted key is often in the same `.env` as the DB URL; document the separation. |
| T4.3 | T | A direct DB write sets `state = owner_approved` or swaps the spec text | L | H | M | Approval rows store the WebAuthn assertion. The CLI verifies the hash and, later, the receipt (SR-05, SR-19). The transitions table is append-only and hash-chained, with the head exported to a witness the DB writer can't reach (SR-37). | N | M in MVP (DB write access defeats a hash the server also stores); L once receipts land |
| T4.4 | E | BOLA across sites or requests (single tenant now, multi-site already) | M | M | M | Scope every query by `site_id`, enforced in the repository layer; tests per route; RLS later | D | L |
| T4.5 | R | Transitions with no actor attribution | M | M | M | `request_transitions` records actor type (owner, CLI-on-behalf-of-owner, bot, GitHub, system), assertion ID, and token ID | D + N | L |

## TB5: Owner browser ↔ dashboard

| ID | STRIDE | Threat | L | I | Risk | Mitigation | Status | Residual |
|----|--------|--------|---|---|------|------------|--------|----------|
| T5.1 | E/T | **Stored XSS from request text** (title, problem, acceptance criteria, transcript, or the LLM-written spec) in the dashboard. Script then starts a WebAuthn ceremony for a different action behind "confirm" UI (UI redress), or acts with the owner session. | M | H | **H** | No raw-HTML markdown; strict nonce CSP with no `unsafe-inline` or `eval`; Trusted Types; React escaping; render untrusted content in a visually fenced "requester-supplied" panel | **N** | L |
| T5.2 | S | Email link scanners or a CSRF trigger an approval | M | H | H | GET has no side effects; approval is a POST with a UV WebAuthn assertion; CSRF token plus `SameSite=Strict` | R | L |
| T5.3 | T | "Approve, then swap the spec" | M | H | H | The challenge record binds `spec_sha256`. Upgrade: derive the challenge **from** `H(action‖request_id‖content_hash‖nonce)` so the signature itself commits to the content (SR-05). | D + N | L |
| T5.4 | S | Session fixation or theft | L | H | M | Rotate the session on login and step-up; `__Host-` cookie; idle and absolute timeouts | D | L |
| T5.5 | E | High-impact non-approval actions without step-up: widening rollout, `enableAll`, adding a passkey, approving a CLI device, editing the site JWKS, vendor credentials, submit-policy overrides | M | H | H | Require step-up on every action in that list (SR-10) | **N** (the brief covers approvals only) | L |
| T5.6 | S | Passkey loss leads to an insecure recovery path, such as email reset | L | H | M | Two authenticators or printed recovery codes; **no email-only recovery** | D | L |
| T5.7 | R | The owner says "I didn't approve that" | L | M | L | Store the assertion (authenticator data, signature, credential ID) with the transition | N | L |
| T5.8 | S/E | **RP ID scope reaches the widget host.** A page on a host equal to or under the WebAuthn RP ID (for example `widget.dash.example.com` with RP ID `dash.example.com`) may start ceremonies for the RP. Sibling hosts under one registrable domain are also *same-site*, so `SameSite` cookies do not stop cross-host CSRF, and a sibling can toss non-`__Host-` cookies. | M | H | H | SR-29: RP ID = the exact dashboard host; the widget host is neither equal to nor a subdomain of it, nor listed in related origins; the server verifies `clientDataJSON.origin` against the exact dashboard origin (the primary control); state-changing routes require `Sec-Fetch-Site: same-origin` plus an exact `Origin` match and a CSRF token; only `__Host-` cookies are read; `doctor` checks the host relationship | R (RFC SU-1, dec. 18) + N | L |

## TB6: Control plane → email → owner

| ID | STRIDE | Threat | L | I | Risk | Mitigation | Status | Residual |
|----|--------|--------|---|---|------|------------|--------|----------|
| T6.1 | S | **Phishing through our own notifications**: attacker-chosen request title such as "Action required: re-verify passkey at ..." | M | H | H | Fixed subject; plain text; attacker text truncated, URL-defanged, and quoted as "Request title (from end user)"; the only link is the dashboard origin | N | L |
| T6.2 | D | Email bombing the owner through request floods | M | M | M | Digest after N per hour; per-user submit caps | N | L |
| T6.3 | I | Spec or repo details leak through email | L | M | L | Stage, title, and link only | D | L |
| T6.4 | S | SPF/DKIM missing, so spoofed "soren-loop" mail trains owners to click | M | M | M | Setup docs and `doctor` check DKIM and SPF for the configured sender | N | M |
| T6.5 | S | **Requester email as a phishing relay.** A host that doesn't verify emails lets an attacker register with a victim's address and receive soren-loop mail, sent from the owner's domain, carrying an attacker-chosen title | M | M | M | `email_verified: true` required; requester templates carry no title; per-recipient rate limit (SR-39b/c) | N | L |
| T6.6 | T | **Locked alerts silenced indirectly** by changing the owner's address or the SMTP config, or by letting delivery fail | M | H | H | Step-up plus notice to the old address; undeliverable banner and `doctor` failure; no `outbox_dead` recursion (SR-39f) | N | L |

## TB7: Control plane ↔ owner CLI

| ID | STRIDE | Threat | L | I | Risk | Mitigation | Status | Residual |
|----|--------|--------|---|---|------|------------|--------|----------|
| T7.1 | S | **Device-code phishing**: attacker starts a device flow and puts "enter code ABCD-1234 at /device" in a request | M | H | H | Device approval needs passkey step-up, shows client IP, approximate location, and time, and expires within minutes; codes in request text are flagged | **N** | L |
| T7.2 | E | A stolen CLI token mints push tokens and opens bot PRs the owner trusts | M | H | H | Short access tokens plus rotating refresh, stored in the OS keychain, sender-constrained (DPoP) where feasible. Mint only for a request in `building` with an approved `H_spec`, one per submit. Every mint is audited. Tokens are listed and revocable in the dashboard. | D + N | M. The PR still faces owner review. |
| T7.3 | T | A compromised control plane serves a malicious "approved" spec | L | H | M (C hosted) | The CLI recomputes the hash. A receipt check (the CLI verifies the owner's WebAuthn assertion against public keys pinned at `login`) means the server cannot forge an approval (SR-19). | **N** | M MVP, L with receipts |
| T7.4 | T | Replay of a `submit` or plan upload | L | M | L | Idempotency keys; transition guards (plan upload only in `planning`) | D | L |
| T7.5 | I | CLI logs leak tokens | M | M | M | Redact tokens; never pass them as argv; keep them out of `doctor` output | N | L |

## TB8: CLI → sandbox → `claude -p` → Anthropic

| ID | STRIDE | Threat | L | I | Risk | Mitigation | Status | Residual |
|----|--------|--------|---|---|------|------------|--------|----------|
| T8.1 | E | **Repo-supplied execution in headless mode.** In `claude -p`, hooks in `.claude/settings.json`, the `env` block, `apiKeyHelper`, project skills' `allowed-tools`, and `.mcp.json` servers are used without a trust prompt (verified: code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder; /en/hooks#workspace-trust). The `env` block can set `ANTHROPIC_BASE_URL` and route model traffic, with the credential, to an attacker. | M | H | **C** | Invoke with `--setting-sources user` (no project settings or `.mcp.json`) plus `--settings '{"disableAllHooks": true}'`. Load our plugin explicitly from the pinned bundled copy. Container-local user settings belong to the CLI. Note that `--bare` alone still applies the project `env` block (same doc). Verify in S6. | **N** | L |
| T8.2 | I | **Exfiltration over allowed egress** (package registries, DNS) of source, `.env` files, or the Claude credential | M | H | H | **Two-phase sandbox**: hydrate dependencies from the lockfile, then seal egress to Anthropic only for `plan` and `build` (DC1). Never mount host `.env` files or credential stores. DNS limited to the allowlist's resolver. | R (allowlist) + **N** (sealed phase) | M. Anthropic-bound traffic and DNS remain theoretical channels; the agent can still read the worktree. |
| T8.3 | E | Sandbox escape: Docker socket mount, privileged container, agent user can sudo or modify iptables (the reference firewall needs `NET_ADMIN` at start) | L | H | M | No socket, non-root, drop capabilities after the firewall is up, and verify the agent user cannot change rules (S5 and S7 tests) | R + N | L |
| T8.4 | I | Host credentials visible in the sandbox: env passthrough, a `~/.claude` mount, an SSH agent socket, a git credential helper | M | H | H | Pass only the Claude auth variable; prefer `/login` inside the container's own volume; no SSH agent; the worktree's `.git` is a copy without the owner's remotes' credentials | R + D | M. The Claude credential itself must be readable by `claude` (accepted). |
| T8.5 | T | Persistent poisoning across runs through a persisted container config dir (auto-memory, settings, plugin cache) | M | M | M | A fresh config dir per run except the credential file; the plugin is re-verified by hash each run (**UNVERIFIED** auto-memory default in `-p`) | **N** | L |
| T8.6 | D | Runaway loops burn the owner's quota | M | M | M | tdd-pair's `max_review_rounds = 3`; a wall-clock timeout and turn cap per run; `paused_rate_limited` | D | L |
| T8.7 | R | The model-written outcome JSON claims `done` when the work isn't | H | M | H | Treat outcome JSON as untrusted. `submit` gates on deterministic checks only (SR-04, SR-18). | **N** | L |
| T8.8 | E | `--permission-prompts none` behaves as allow rather than deny, or the skill's `allowed-tools` pre-approves Bash. Workspace trust never gates a skill's `allowed-tools` (same doc). | M | M | M | Treat the sandbox as the only boundary; deny `WebFetch` and `WebSearch` explicitly; S6 verifies the semantics | **N** | L |

### TB8b: agent-written tree → host-side tooling (RFC CLI-H1, CLI-H2)

The agent's output tree crosses back from Z4 to Z3 when `submit` (and the owner's own tools) read it. Anything in that tree that host tooling *interprets* is an execution vector outside the sandbox.

| ID | STRIDE | Threat | L | I | Risk | Mitigation | Status | Residual |
|----|--------|--------|---|---|------|------------|--------|----------|
| T8.9 | E | **Gitdir redirect.** The agent rewrites the linked worktree's `.git` file to point at a gitdir it controls. Host git then reads attacker config: `core.fsmonitor` and `core.hooksPath` run commands. | M | H | **C** | SR-28: host git uses a CLI-owned trusted `--git-dir`/`--work-tree` and never follows the tree's `.git` entry; the `.git` entry's hash is recorded before the run and verified after (any change is a hard fail and quarantines the tree) | R (RFC CLI-H1) | L |
| T8.10 | E | **Writable gitdir in the sandbox.** If the worktree's private gitdir or the shared common dir (`<main>/.git`, whose `config` and `hooks/` apply to every worktree) is mounted into the sandbox, the agent can write config directly, with no redirect needed | M | H | **C** | SR-28a: no gitdir of the owner's repo is ever mounted into the sandbox. The sandbox gets a plain tree, or a sandbox-internal clone that host git never uses. | **N** | L |
| T8.11 | E/I | **Other config-driven vectors** reached when attacker config applies, or when host git honours ambient config: `core.sshCommand`, `core.pager`, `core.editor`, `diff.external`, `gpg.program`, `credential.helper`, `url.<base>.insteadOf` and `http.proxy` (redirect the push token to another host), `include.path` and `includeIf` (pull in an attacker file), `remote.*.receivepack`, `protocol.ext` | M | H | H | SR-28b/c: isolated config (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` = a CLI-owned minimal file); `-c` overrides for hooks, fsmonitor, protocols, and pager as a second layer; push to an explicit fork HTTPS URL with an ephemeral credential, never via remote config | **N** | L |
| T8.12 | E | **`.gitattributes` drivers and repo-relative hook managers.** `filter=`, `diff=`, and `merge=` attributes only *name* drivers; the commands come from config, so isolated config neutralizes them, but under the owner's ambient config they could trigger owner-defined drivers on attacker content. Husky- or lefthook-style `core.hooksPath=.husky` points hooks **into the agent-writable tree**, so committing runs agent-written hooks on the host. | M | H | H | SR-28b (isolated config, `core.hooksPath=/dev/null`); `.gitattributes`, `.husky/**`, and hook-manager configs hard-blocked (SR-04) | R (SR-04) + N | L |
| T8.13 | I/E | **Filesystem tricks.** A symlink to `~/.ssh` or another host path, followed by `submit`'s scanners or copy steps, puts host file content into the PR. Gitlinks (mode 160000) or nested `.git` directories embed repos. Case and Unicode variants (`.GIT`, ignorable code points, `git~1`) evade a naive `.git` deny-list match. FIFOs and devices hang tools. | M | H | H | SR-28d: lstat-only walks; hard block on new symlinks, gitlinks, special files, and any path component that normalizes to `.git`; deny-list matching is case-insensitive and Unicode-normalized | **N** | L |
| T8.14 | E | **The owner's own tools open the tree.** A shell prompt that runs `git status`, IDE git integration, IDE tasks (`.vscode/tasks.json` with `runOn: folderOpen`), or `direnv`/`mise` hooks act on agent-written content before `submit` validates it | M | H | H | SR-28e: the agent tree lives under a CLI-owned run directory with **no `.git` entry**, so prompts and IDEs don't treat it as a repo; `soren-loop inspect` shows the diff through the trusted gitdir; `.vscode/**`, `.idea/**`, and `.envrc` are deny-listed; docs warn not to open the run directory | **N** | M (owner behaviour) |
| T8.15 | T | **`.gitignore` edits** un-ignore files present in the tree (build output, hydrated artifacts) so they get committed, or hide files from the owner's view | M | M | M | `.gitignore` hard-blocked (SR-04); `submit`'s file selection uses the base commit's ignore rules from the trusted gitdir, never the tree's | R (RFC CLI-H2) | L |
| T8.16 | T/E | **Agent-container persistence and credential substitution.** Checks run in the agent's own container, so a leftover background process fakes the results. Hydrate re-runs on an agent-touched tree, so an agent-written `.npmrc` or lockfile executes with registry egress. A persistent rw credential volume lets the agent replace or poison the credential for later runs. | M | H | H | A fresh container per check run; hydrate only from a pristine export into a read-only dependency layer; the credential via env or an ephemeral copy (SR-02) | **N** (Zod M11) | L |
| T8.17 | E | **Host-side L1 inherits the owner's config**: user-scope MCP servers and plugins give the "no-tool" classifier tools on the host | M | M | M | L1 only in a sealed container with a fresh config dir (SR-26a) | **N** (Zod M12) | L |

## TB9: Repo and dependency content → agent

Covered in depth in `03` §4 (indirect injection). The STRIDE summary:

| ID | STRIDE | Threat | L | I | Risk | Mitigation | Status | Residual |
|----|--------|--------|---|---|------|------------|--------|----------|
| T9.1 | T | **Instruction-file persistence**: an earlier agent PR plants `CLAUDE.md`, `AGENTS.md`, `.claude/`, or `.mcp.json` content that hijacks every later build | M→L | H | **H** | Deny-list those paths in `submit` (SR-04); SR-01 ignores project settings; SR-26 layer 2 holds any instruction-file change since the last owner-trusted commit, including changes merged by hand or by a collaborator | R (DC2, dec. 23) | L |
| T9.2 | E | A malicious or slopsquatted dependency the agent adds runs install or test scripts | L | H | M | **No new dependencies in V1** (decision 16): manifest and lockfile changes are hard-blocked at `submit`. Hydrate installs only the existing lockfile. | R (dec. 16) | L |
| T9.3 | T | A compromised existing dependency runs during tests | L | H | M | Sealed egress limits the payoff; this is the owner's existing supply-chain risk | R | M (accepted, pre-existing) |

## TB10: Control plane / CLI ↔ GitHub

| ID | STRIDE | Threat | L | I | Risk | Mitigation | Status | Residual |
|----|--------|--------|---|---|------|------------|--------|----------|
| T10.1 | E | Bot can merge or push to `main` (`Contents: write` grants merge; S1's control merge confirmed it) | L | H | H | **Fork model confirmed by S1 (decision 24).** **Two Apps (decision 25).** The upstream PR App holds no `contents: write`, so no upstream credential can merge, whatever the minting code does (S1 F2). | R (dec. 24, 25) | L |
| T10.2 | E | A workflow-file write gives a CI-secrets foothold | L | H | M | Never request `Workflows`. GitHub rejects workflow writes without it, via both git push and the Contents API (verified, S1 Q3). `.github/**` is hard-blocked in `submit`. | R | L |
| T10.3 | E | **"Pwn request"**: the owner's existing `pull_request_target` or `workflow_run` workflows check out the fork PR's head with secrets | M | H | **H** | `doctor` scans the repo's workflows and blocks or warns; documented | **N** | M (the owner's config) |
| T10.4 | S | Forged webhooks | M | H | H | HMAC-SHA256 constant-time verify; reject when unsigned | D | L |
| T10.5 | T | Webhook replay (GitHub signs the body only, with no timestamp) | M | M | M | Dedup on `X-GitHub-Delivery`; idempotent transition guards | N | L |
| T10.6 | T | `deployment_status: success` from any actor with Deployments access, or for an unrelated SHA, flips flags early | M | L | L | Configured environment only; ancestry check of the merge SHA (compare API); restrict to the configured deploy actor where possible | D | L |
| T10.7 | I | App private key theft from the backend host | L | H | M | **Two keys, split blast radius** (decision 25). A push-App key opens fork write only: no upstream install, no workflows. A PR-App key opens, edits, and comments on PRs and issues upstream, but can neither merge nor push. Keys file-mounted `0400`, separately rotatable, never in DB or logs; any non-201 mint is a hard error (S1 F3); KMS signing in hosted mode. | R (dec. 25) + N | L to M |
| T10.8 | T | A collaborator edits the issue to change what gets built | H | H | H | The issue is a projection; build uses the hash-pinned spec from the backend | R | L |
| T10.9 | T | PR comments from any GitHub user are fed back to the agent on `changes_requested` | M | H | H | Feedback comes only from the dashboard, or from PR reviews by the configured owner identity; never raw comments | **N** | L |
| T10.10 | I | Issue projection publishes requester text (PII, harassment) and becomes an injection source for *other* agents on the repo (Copilot, `@claude` workflows) | M | M | M | Minimal projection: request ID plus an owner-edited title; neutralize `@` mentions, `#` references, and links; never project specs; off by default for public repos | **N** (DC5) | L |
| T10.11 | E | **Non-App pushers to the fork.** A human or other credential with push access to the fork bypasses the App's workflow restriction. A fork-side workflow edit then runs upstream on `pull_request` (without secrets, read-only token, per S1 F1), and branch content stops being attributable to the pipeline. | M | M | M | The fork lives in a bot-only account with no human collaborators; `doctor` fails if the fork has other pushers; `maintainer_can_modify: false` on every PR (S1 F4); SR-04 `.github/**` hard block | R (S1 F1/F4) + N | L |
| T10.12 | E | **PR App permission creep.** Someone later grants the PR App `contents: write` (for example, to add a feature), silently restoring merge capability | L | H | M | `doctor` and a backend start-up check compare each App's granted permissions against the expected set and refuse to run on extras; the App manifests are under CODEOWNERS (SC8) | **N** | L |
| T10.13 | E | **PR App permission set too narrow for MVP**, which invites ad-hoc broadening. Decision 25 lists `pull_requests: write` + `metadata: read`, but issue projection needs `issues: write`, `deployment_status` webhooks need `deployments: read`, and the ancestry check (compare API) needs `contents: read`. | H | M | M | Ratified as decision 26: `pull_requests: write`, `issues: write`, `deployments: read`, `contents: read`, `metadata: read`. None of these grants merge (merge needs `contents: write`). Re-verify merge = 403 with this exact set (ST-48). | R (dec. 26) | L |
| T10.14 | T | **Fork branch changed after `submit`.** A push token that wasn't revoked, or a second mint, pushes new commits to the bot's fork branch, and the open upstream PR silently picks them up after the owner's review began | M | H | H | Single mint with `409` on repeat; immediate revocation after the push; `replace` capped at 2 and revoking; `head_sha` pinned with tamper detection on `synchronize` (SR-09, SR-41) | **N** (Postel B2) | L |

## TB11: Flag plane

| ID | STRIDE | Threat | L | I | Risk | Mitigation | Status | Residual |
|----|--------|--------|---|---|------|------------|--------|----------|
| T11.1 | E | **A client-side flag treated as authorization**: the gated feature exposes data or actions, and anyone flips the flag in devtools | H | H | **C** | Eligibility rule: a flag is a rollout control, not authz. Gated code may only expose what the server already authorizes for every user. This goes in the plan template and the owner checklist. | **N** (DC3) | M (enforcement is by review) |
| T11.2 | I | The flagd sync endpoint or OFREP bulk evaluation exposes every flag key and the targeted user-ID lists | M | M | M | Sync endpoint authenticated and internal only; browsers use host-proxied single-flag OFREP only (SR-36); opaque flag keys (`sl_<random>`); description stays server-side | **N** | L |
| T11.3 | E | A vendor admin token reaches every flag, not just soren-loop's | M | H | H | Use a project- or environment-scoped vendor token; `FlagWriter` refuses keys outside the `sl_` namespace | **N** | L |
| T11.4 | T | `enableAll` or rollout widening without step-up | M | H | H | SR-10; outbox-only writes driven by state transitions | N | L |
| T11.5 | T | A missing flag gate (R3) ships the feature to everyone | M | H | H | A key-reference check plus a flag-off test **and** a post-deploy probe as a non-targeted user. A grep alone is gameable: the key can appear in a comment. | D | M |

## TB12: Requester status feed

| ID | STRIDE | Threat | L | I | Risk | Mitigation | Status | Residual |
|----|--------|--------|---|---|------|------------|--------|----------|
| T12.1 | I | IDOR on `GET /requests/:id` | M | M | M | Random 128-bit IDs; authorize by `(site_id, sub)` | N | L |
| T12.2 | I | Timing side channel: owner activity hours, rejection signal, build duration | H | L | L | Accept stage names. Optionally batch updates (hourly granularity). | R | L |
| T12.3 | I | A `matched_existing` oracle enumerates unreleased features (Phase 2+) | M | M | M | Indistinguishable path: "submitted" first, match revealed only after owner confirmation (`04` AB6) | **N** | L |
| T12.4 | I | **Hold leakage through pushed notifications**: an event or override keyed by internal state, delivery timing, suppressed-versus-sent counts, or the reason text in a `closed` message | M | M | M | SR-39a/b/d (stage-only events, hour-aligned, owner-only suppression data, uniform templates); property test ST-54 | R (dec. 30) + N | L. Residual: a rejection during `planning` hints at a G2 or hold rejection; accepted, because owners also reject at plan review. |
| T12.5 | I | **Hold leakage outside notifications**: on public repos the widget `request_id` lets the requester find their PR and its risk summary; the throttle pause answers `limit_reached` while the requester has no open requests | M | M | M | `public_ref` unlinkable to `request_id`; no verdict or hold terms in GitHub artifacts; shadow-accept throttle (SR-40) | **N** | L |

## Pre-check (decision 23, SR-26)

The pre-check is a new attack surface of its own: an LLM classifier reading attacker text,
whose output is rendered in the dashboard. Its threats (PC1–PC9) are analysed in `03` §7 next
to the injection pipeline they belong to.

TB13 (distribution) is in `05-supply-chain-and-hosted.md`.
