# 09. Security Requirements Mapped to Components

Stance (threat model A5, A6): every request is hostile, and the build agent is compromised
whenever the request is malicious. The controls that bound a successful injection are the
**sealed sandbox**, the **deterministic `submit` policy**, and the **owner's review at G2 and
G3**. Zod, passing tests, and a `clean` pre-check verdict are not defense layers. The pre-check
(SR-26) is a block-only detector. Its LLM layer shares failure modes with the build agent, and
its value is in catching unsophisticated payloads and, through L2 and L3, deterministic
indicators.

## 1. MUST-MVP Requirements

| SR | Requirement (short) | Implementing component(s) | Mechanism in this RFC | Tests |
|----|---------------------|---------------------------|-----------------------|-------|
| SR-01 | Headless invocation hardening | Repo 2: CLI runner | `15` §1 flag set; per-run config dir; only the auth variable passed | ST-01, ST-35 |
| SR-02 | Two-phase sealed sandbox | Repo 2: CLI + sandbox image | `15` §2: two containers, hydrate then sealed; non-root; no sockets or credentials | ST-02, ST-03; S7 gate |
| SR-03 | `plan` least-privilege | Repo 2: `plan` skill + CLI | `allowed-tools: Read, Grep, Glob`; read-only mount; spec returned in the final message; sealed egress (`07` §1.1) | ST-04 |
| SR-04 | Deterministic `submit` policy | Repo 2: CLI `submit`; Repo 1: server compare re-check | `07` §1.3, including Sentinel's deny-list additions (`.git` in any component, `.gitignore`, hook-manager configs, `.vscode/**`, `.idea/**`, `.envrc`); server-side re-check of deny-list, manifests, size, binaries (`03` row 23) | ST-05 |
| SR-05 | Content-bound approvals | Repo 1: server WebAuthn + `packages/schema` hashing; Repo 2: CLI hash checks | `04` §3 normalization, `H_req`/`H_spec`, derived challenge; CLI refuses on mismatch; specs fetched only from the backend | ST-06, ST-07, ST-09 |
| SR-06 | Untrusted text in dashboard and email | Repo 1: dashboard, notifier | Nonce CSP, Trusted Types, markdown without HTML, invisible-character markers, fenced requester content; fixed-subject plain-text email | ST-08, ST-09, ST-36 |
| SR-07 | Widget identity | Repo 1: server session exchange, widget, `packages/node` | `jose` allowlist, `jti` cache, SSRF-defended JWKS, iframe-memory token, `MessageChannel`, `frame-ancestors`, **separate widget host** | ST-10, ST-11, ST-12 |
| SR-08 | GitHub (decisions 24, 25) | Repo 1: GitHub module, start-up check, webhook ingest; Repo 2: `doctor` | `08` §1 (ADR-4). Two Apps: the PR App upstream with exactly `pull_requests: write`, `issues: write`, `deployments: read`, `contents: read`, `metadata: read`, never `contents: write`; the push App on the bot-only fork only. Non-201 mints are hard errors; `maintainer_can_modify: false`; separate, separately rotatable keys; the **backend start-up check** (`08` §1.4a) and `doctor` fail on extra permissions or repos; `doctor` fails on human pushers to the fork; HMAC plus dedup; ancestry; `pull_request_target` scan; owner-only feedback | ST-13, ST-14, ST-48, ST-49 |
| SR-09 | CLI auth | Repo 1: device flow, token service; Repo 2: keychain storage | +SU device approval with client context; rotating refresh; state-gated mint (at most one replace, revoked after the push, never returned or cached, `04` §5); fetch uses the owner's own credential by default, with a DPoP-bound fallback token (T24); never in argv (`GIT_ASKPASS`) | ST-15, ST-75 |
| SR-10 | Step-up on high-impact actions | Repo 1: server guards, dashboard | `06` §2 and §3; one step-up per action, no window | ST-16 |
| SR-11 | Caps | Repo 1: server intake guards | Row 1 guards; throttle; pause intake; block requester; digests | ST-17 |
| SR-12 | Status feed | Repo 1: server feed projection | `03` §5 mapping; random IDs; `(site, sub)` scope; field-allowlist snapshot | ST-18 |
| SR-13 | Flag plane | Repo 1: `flag-adapters`, flagd sync listener | `sl_` namespace; internal sync endpoint; writes only as outbox effects of state-machine events, including no-transition events such as row 43 (amended SR-13; lint: no `FlagWriter` import outside workers); scoped vendor token | ST-19, ST-71 |
| SR-14 | Secrets at rest | Repo 1: server crypto module | Envelope encryption with a key outside the DB; peppered HMAC tokens; two App keys as separate `0400` files outside the DB, each with its own signer, the push-App signer importable only by the minting service (`08` §1.5); log redaction | ST-20 |
| SR-15 | Audit trail | Repo 1: `request_transitions`, `audit_events` | `04` §4: append-only grants plus trigger, actor types, the SR-37 chain | ST-23 (attribution); ST-71 |
| SR-16 | Release integrity | Both repos: CI/CD | npm trusted publishing plus provenance; SHA-pinned actions; protected release environment; cosign plus SLSA plus SBOM; names reserved | ST-71 |
| SR-17 | Issue projection | Repo 1: GitHub module | `public_ref` plus owner-edited title only (SR-40a); neutralized mentions and links; off by default for public repos | ST-61, ST-71 |
| SR-18 | Model output advisory | Repo 1: state machine; Repo 2: outcome handler | `03` §1 principle 1; `15` §4 | ST-21, ST-23 invariant 5 |
| SR-20 | Vendored prompts | Repo 2: `plugin/VENDORED.json`, CLI verifier | `15` §3 | ST-22 |
| SR-26 | Block-only pre-check | Repo 1: PC-S, PC-I, hold console, record guards; Repo 2: PC-A, PC-B, PC-C | `06` §4; `03` rows 1, 2, 5, 7, 20, 34, 35, 44; requester-attributable throttle; offset spans; L1 config isolation (`15` §2) | ST-25 to ST-37, ST-39, ST-40 |
| SR-27 | PII retention | Repo 1: purge job, `FlagWriter` purge effect | `17` §2: the full store-by-store table, including the CLI `gc` (Zod M7) | ST-38 (extended) |
| SR-39 | Notification policy can't reveal a hold; locked alerts can't be silenced | Repo 1: notification resolver, outbox, `Notifier`, dashboard | `14`: stage-only requester events and strict schema; `ceil_hour` for every requester channel; title-free requester templates, byte-identical `closed`; verified-email-only, encrypted, `List-Unsubscribe`; ten locked kinds (including `pr_head_changed`, SR-41); leading-edge per-kind coalescing; +SU owner-contact/SMTP changes notifying the old address; undeliverable-channel banner and `doctor` failure; policy edits bound to `site_id` and base version; internal-only metrics with no per-request labels | ST-54 to ST-60 |
| SR-40 | No hold disclosure outside notifications | Repo 1: GitHub module, intake guards; Repo 2: `submit` | (a) opaque `public_ref` on every GitHub artifact, never hold or verdict terms (`07` §1.3, `08` §1.4); (b) A23-8 pause is shadow-accept (ST-76 covers opt-out and retire; `03` §3) | ST-61, ST-62 |
| SR-19 | Approval receipts (**MUST-MVP**, decision 29 / Q7) | Repo 2: CLI verifier; Repo 1: `GET /v1/cli/keys` | `17` §1: keys pinned at `login`; the CLI verifies G1, G2, rework and clearance receipts offline, with no escape hatch | ST-06, ST-63, ST-64, ST-74 |
| SR-28 | Host-side git and tree hygiene | Repo 2: CLI `submit`/`inspect`, run-directory manager | `07` §1.3 step 1: no gitdir mounted in the sandbox; a CLI-owned trusted gitdir with `GIT_CONFIG_NOSYSTEM`, a CLI-owned `GIT_CONFIG_GLOBAL`, hooks/fsmonitor/file and ext protocols off; push to an explicit fork URL; lstat-only walk; a run directory with no `.git`; file selection by the base commit's ignore rules | ST-41 to ST-46 |
| SR-29 | WebAuthn and origin scoping | Repo 1: server WebAuthn verify, route middleware, cookie layer; Repo 2: `doctor` | `06` §3. **Primary control:** exact `expectedOrigin` verification. **Defense in depth:** RP ID = the exact dashboard host, with the widget host neither equal to nor under it and never a related origin. Sibling hosts are same-site, so state-changing routes need `Sec-Fetch-Site: same-origin`, an exact `Origin`, and CSRF, and only `__Host-` cookies are read | ST-47 |
| SR-35 | One step-up, one action | Repo 1: step-up service; Repo 2: receipt verifier | `04` §3.4 action enum and `sl:webauthn:v1` with sorted targets; `05` §1.2 single body shape | ST-50 |
| SR-36 | Host-proxied OFREP | Repo 1: `@sorenai/loop-node` `createOfrepHandler` | `16` §5: single and bulk evaluation, filtered to the shipped-bundle allowlist (amended SR-36) | ST-51, ST-68 |
| SR-37 | Hash-chained audit | Repo 1: chain writer, verifier, witness export; Repo 2: head recording | `04` §4: per-`(site, table)` chains, an advisory lock, export nightly and after every step-up | ST-52 |
| SR-38 | Interactive builds hardened identically | Repo 2: CLI `build --interactive` | `07` §1.2: same container, flags, run tree, PC-C, `submit`; a TTY escape filter | ST-53 |
| SR-41 | PR head pinning | Repo 1: `gh.open_pr`, webhook ingest, `request_prs` | `03` rows 23, 46, 47; `08` §1.4: pin `head_sha`; a `synchronize` off the pin → `stalled{head_tampered}`, a do-not-merge label, and the locked `pr_head_changed` | ST-78 |

## 1a. Release Gate (Zod M10)

Every ST in `security/06` carries a priority tag (`mvp`, `phase2`, `hosted`). The release gate
is **every `mvp`-tagged ST**: currently **ST-01 to ST-79 minus ST-24** (`hosted`), as tagged in
`security/06`. Range-based gates ("ST-01 to ST-40") are retired.

## 2. SHOULD-MVP Requirements (ship in Phase 1 unless cut in writing)

| SR | Component | Plan |
|----|-----------|------|
| SR-21 Spotlighting and datamarking | `plan` and build prompt templates | Ship; low cost |
| SR-22 Review aids | Server analysis job; dashboard; PR risk summary | Ship G2 extraction and the G3 summary. The request-to-spec diff is a text diff in Phase 1. |
| SR-23 Post-deploy probe | Outbox job | Ship when the demo app exists |
| SR-24 Ephemeral config dir | CLI runner | Ship (it is part of `15` §1) |
| SR-25 `doctor` DKIM/SPF, App permissions, policy | CLI `doctor` | Ship the policy and App-permission checks; DKIM/SPF as a warning |

## 3. LATER Requirements and Their Gates

| SR | Blocks |
|----|--------|
| SR-30 | LLM intake (Phase 2) |
| SR-31 | Runner B, the Claude Code Action (Phase 2). Automation mode, fixed prompt, no comment triggers, minimal `permissions:`; input names **UNVERIFIED** |
| SR-32 | `matched_existing` (Phase 2+) |
| SR-33 | SMS or push |
| SR-34 | Hosted (Phase 3): RLS, KMS, per-tenant isolation (SR-19 is already MUST-MVP) |

## 4. Additions Proposed by This RFC: Disposition

| ID | Proposal | Disposition |
|----|----------|-------------|
| CLI-H1 | Trusted gitdir and safe `-c` flags for host-side git | **Accepted, broadened into SR-28** (adds no gitdir in the sandbox, `GIT_CONFIG_NOSYSTEM`, a CLI-owned global config, an explicit push URL, an lstat-only walk, base-commit ignore rules) |
| CLI-H2 | `.gitignore` and `.git` in the deny-list | **Accepted into SR-04**, along with hook-manager configs, `.vscode/**`, `.idea/**`, `.envrc` |
| SU-1 | Exact-host RP ID; the widget not under it | **Folded into SR-29.** The exact `expectedOrigin` check is the primary control, and the RP ID is defense in depth. |
| SU-2 | One step-up authorizes one action | **Accepted, decision 28** (`06` §3) |
| FL-1 | Host-proxied single-flag OFREP for browsers | **Accepted, decision 28** (`16` §2) |
| AU-1 | Hash-chained audit tables, head exported out of the DB writer's reach | **Accepted, decision 28** (`04` §4) |

## 5. Residual Risks Carried by This Design

| Risk | Residual | Why it stays |
|------|----------|--------------|
| Injection chain survives a fatigued G2/G3 review | M | Human review is the last line. The pre-check lowers the likelihood, not the residual. |
| DNS and Anthropic-bound exfiltration in the sealed phase | M (accepted, decision 20) | Allowlisted egress can still leak what the agent can read |
| A modified local CLI skips or forges pre-check records | M (accepted, PC7) | The owner's machine is out of our control |
| A merge by a collaborator triggers enablement | L–M (L with a decision 29 site option) | G3 is GitHub's gate; site options `merger_must_be_owner_login` / `dashboard_confirm` |
| A client-side flag used as authz by the owner's own code | M | Enforced by policy, the prompt contract, and review only (T11.1) |
| A human with push access to the fork edits workflows that run in upstream CI (no secrets) | L | S1 F1; the bot-only fork is checked by `doctor` (`08` §1.7) |
| A leaked push App key writes fork branches | L | It reaches upstream only through an owner-merged PR; key rotation (`08` §1.5) |
