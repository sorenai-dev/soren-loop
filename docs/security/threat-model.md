# Threat Model: soren-loop

Author: Sentinel · Date: 2026-10-30 · Status: Rev 5 (2026-10-31, Zod and Postel reviews folded in). DC1–DC8, decisions 14–31, and RFC
findings CLI-H1, CLI-H2, SU-1, SU-2, FL-1, and AU-1 are folded in (Rounds 3 to 5). Input to the RFC (Arendt) and contract review (Postel).
Inputs: `docs/discovery/00-project-brief.md` (decisions 1–31 and the Decision #2 amendment),
`01-discovery.md`, `02-research-findings.md`, `03-architecture-and-risks.md`.

Convention: external claims carry a URL. Claims I could not confirm against a primary source
are marked **UNVERIFIED**. This document describes attack classes and controls; it contains no
working exploits.

| File | Contents |
|------|----------|
| `threat-model.md` (this file) | Summary, top threats, recommended changes to ratified decisions, open questions |
| `01-system-model.md` | Scope, assumptions, assets, actors, Mermaid DFD, trust boundaries TB1–TB13 |
| `02-stride.md` | STRIDE per boundary, with likelihood, impact, mitigation, ratified status, and residual |
| `03-prompt-injection-and-llm-top10.md` | Request → spec → plan → code pipeline; what each gate reviews; indirect injection; OWASP LLM Top 10 (2025); §7 the decision 23 pre-check |
| `04-abuse-cases.md` | AB1–AB12: spam, flag social engineering, approval fatigue, illegal content, impersonation, recon, notification abuse |
| `05-supply-chain-and-hosted.md` | What we distribute; agent-workflow-kit observations; self-hosted vs hosted |
| `06-requirements-tests-spikes.md` | SR-01 to SR-41 (MUST/SHOULD/LATER), security tests ST-01 to ST-79 (gate: all `mvp`, i.e. all but ST-24), spike consequences S1–S7 |

---

## Summary

soren-loop carries untrusted text, through human gates, into an agent with code-write
capability on the owner's machine. The ratified mitigations are directionally right: pull
model, fork PRs, passkey approvals, hash-pinned specs, CI without secrets. The model's central
stance is **assume the build agent is compromised whenever the request is malicious**. Under
that stance, security comes from three things: the sandbox, the deterministic `submit` checks,
and the owner's diff review at G3. Neither Zod nor passing tests count as a defense layer.

The highest-value new finding is verified against Anthropic's docs. In headless `claude -p`,
a repository's `.claude/settings.json` hooks, its `env` block, and its `.mcp.json` servers run
**without a trust prompt** (https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder).
Combined with an earlier agent PR that plants those files, that is a persistent,
self-propagating compromise path. SR-01 and SR-04 close it.

The second finding: allowing package-registry egress during the agent phase leaves an
exfiltration and code-execution channel next to the owner's one-year Claude credential. Hydrate
dependencies first, then seal egress (SR-02).

Hosted mode does not just add multi-tenancy. It turns the control plane into a distribution
point for build instructions and host-page script across all tenants, so runner-verified
approval receipts (SR-19) become mandatory.

## Brand and Reputational Risk (decision 31)

soren-loop ships under sorenai.dev, the owner's security-audit brand (Soren Score). That changes the risk framing in three ways:

1. **Impact is amplified.** A compromise of soren-loop, or even a public, preventable vulnerability, is a credibility event for a business that sells security judgment. Treat SC1, SC3, SC5, and every top-5 threat below as reputationally critical, in addition to their technical rating.
2. **Likelihood rises.** A security vendor's own tool is a trophy target, so expect more, and more skilled, attention than an anonymous OSS project gets.
3. **Blast radius couples across the suite.** The `sorenai-dev` GitHub account, the `@sorenai` npm scope, and the `sorenai.dev` domain are shared with the other products (AS14, SC4). A takeover of any of them affects all of them.

Controls this adds:

- Separate credentials and publish rights per product. `sorenai-dev` becomes an organization before the first public release (decision 33, SC4), with a team per product.
- GitHub private vulnerability reporting and a published `security.txt` and disclosure policy at `sorenai.dev`.
- A documented advisory process: GitHub Security Advisories, CVE requests, and an embargo window.
- Publish this threat model with the repo. Showing the work is the brand-consistent posture.
- Hosted mode sends email from a domain separate from the audit brand's own mail.

## Top 5 Threats

| # | Threat | Inherent | Key controls | Residual |
|---|--------|----------|--------------|----------|
| 1 | **Injection chain:** malicious request → approved spec → agent writes backdoor or data-exposure code that passes Zod and tests, and survives a fatigued G3 review (`03`, AB3, AB12) | C | Sealed sandbox, least-privilege `plan`, deterministic `submit` policy with default-deny paths, review aids at G2 and G3, content-bound approvals, block-only pre-check (SR-02 to SR-06, SR-22, SR-26) | **M**: human review is the last line. The pre-check lowers the likelihood, not the residual. |
| 2 | **Repo-supplied execution in headless `claude -p`:** hooks, `env` (for example `ANTHROPIC_BASE_URL`), and `.mcp.json` honoured without trust, made persistent via instruction-file PRs (T8.1, T9.1) | C | `--setting-sources user`, `disableAllHooks`, explicit plugin loading, deny-list of `.claude/**`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `.github/**` (SR-01, SR-04) | L |
| 3 | **Exfiltration and dependency execution** over allowed egress: source, `.env` files, the owner's Claude credential (T8.2, T9.2) | H | Two-phase hydrate-then-seal, no new dependencies unless declared in the spec, no host credential mounts (SR-02) | M (DNS and Anthropic channels theoretical) |
| 4 | **Control-plane compromise:** forged approvals or specs sent to runners; loader script on every host page (T7.3, SC5; critical in hosted) | H (C hosted) | Hash checks on the CLI now; approval receipts (SR-19), SRI loader, signed images; runners with no exec channel | M MVP, L with SR-19 |
| 5 | **Dashboard stored XSS and notification phishing** from request text, enabling UI-redressed passkey approvals and session abuse (T5.1, T6.1) | H | Strict CSP, Trusted Types, no raw HTML, plain-text email, step-up on every high-impact action (SR-06, SR-10) | L |

Close runners-up: **client-side flags treated as authorization** (T11.1, critical, enforced
only by policy and review); a **stolen CLI token minting push tokens** (T7.2);
**`pull_request_target` workflows in the owner's repo** turning bot PRs into secret theft
(T10.3).

## Recommended Changes to Ratified Decisions and Mitigations

**Status: all ratified in Round 3 (2026-10-30).** For DC1, decision 16 (no new dependencies in
V1) supersedes the "declared in spec" allowance. For DC6, decision 18 makes two hostnames
mandatory. The table is kept for its reasoning.

| # | Ratified item | Change | Reasoning |
|---|---------------|--------|-----------|
| DC1 | Mitigation "sandboxed agent, **allowlisted egress**" (discovery: Anthropic plus package registries) | **Two phases.** Hydrate from the lockfile with registry access, then seal egress to Anthropic-only for `plan` and `build`. New dependencies are allowed only if declared in the approved spec, and installed in the hydrate phase. | Registries are both an exfiltration channel and an install-script execution channel. The one-year Claude credential and the source sit in the same sandbox. Anthropic's own docs warn that egress "can still leak data the agent can read." |
| DC2 | Mitigation "no `.github/workflows/` writes" | Broaden it to a **deterministic path deny-list at `submit`** covering agent-instruction and tool-config files (SR-04a), and **ignore project settings at runtime** (SR-01). | Instruction and config files are execution vectors in `-p` mode (verified), and the main persistence path across builds. |
| DC3 | Mitigation "feature eligibility policy (V1: UI / read-path)" | Enforce it with **owner-configured path globs, default deny** (`doctor` refuses to build without a policy). Add the rule **"flags are rollout controls, not authorization."** | An LLM's classification of "UI-only" is attacker-steerable. A client-evaluated flag can be flipped by anyone in devtools. |
| DC4 | Mitigation "transcript → structured spec; owner approves the spec" with hash pinning | Use **two hashes** (`H_req` at G1, `H_spec` at G2) over normalized text, and **content-derived WebAuthn challenges**. Add **CLI-verified approval receipts** (SHOULD for MVP, MUST for hosted). Note: in form mode, the "structured spec" at G1 *is* raw text, so `plan` must be least-privilege (SR-03). | A server-stored hash cannot defend against a server or DB compromise. Hidden Unicode makes "what the owner saw" differ from "what was hashed". |
| DC5 | ADR-3 (issue as projection of the structured spec) | Project **ID plus an owner-edited title only**; neutralize mentions, references, and links; never project specs; **off by default for public repos**. | PII and harassment content on GitHub; issue text becomes an injection source for *other* agents on the repo; the spec could become an exfiltration channel. |
| DC6 | Discovery: dashboard same-origin with the API | Keep that, but **serve the widget iframe from a separate host**. | XSS in the widget (for example from LLM output) must not run on the origin holding owner routes and the WebAuthn RP. |
| DC7 | Decision 7 (fork model) | Endorse it. Add a `doctor` check for `pull_request_target` and `workflow_run` workflows. **S1 passed (decision 24); two Apps (decision 25).** Had S1 failed, Option B would have been a launch blocker until rulesets are verified by `doctor`. | Fork PRs without secrets only help if the owner's repo has no secret-bearing fork triggers. |
| DC8 | Decision 11 (reuse personas from agent-workflow-kit) | **Vendor at a pinned commit with hashes**; never fetch at runtime; load the plugin from the CLI package, not a live marketplace. **tdd-pair is not in agent-workflow-kit today.** Publish it there or own it in soren-loop-cli. | Prompts are executable behaviour (LLM03). A persona change is a code change in every owner's build. |
| — | Decisions 5, 6, 9 | **Endorsed** as security-positive. Form intake removes LLM05 and LLM10 at intake; owner-started builds cap quota abuse; orchestration-only hosting keeps credentials owner-side. For Decision 9, add "the runner protocol has no exec channel." | — |

## Open Questions: Resolved in Round 3

Q1 → decision 14 (public repos allowed; outside contributors out of scope). Q2 → 15 (hard
blocks for deny-listed paths, workflows, and secrets; step-up override only for
out-of-eligibility paths). Q3 → 16 (no new dependencies). Q4 → 17 (two-person rule LATER, off
by default). Q5 → 18 (two hostnames required). Q6 → 19 (PII deleted 90 days after close, or on
request; SR-27). Q7 → 20 (DNS and Anthropic channels accepted as residual). Q8 → 21 (tdd-pair
moves to agent-workflow-kit, vendored at a pinned commit). Q9 → 22 (`plan` never runs Bash).

Decision 14 note: with public repos allowed, SR-17 (projection off by default for public repos)
and T10.3 (`pull_request_target`) become MVP-critical rather than conditional. Excluding outside
contributors does not remove the risk of public commenters on PRs (T10.9).

## Decision 23 (pre-check): Folded In, With Ratified Amendments

Folded into SR-26, ST-25 to ST-37, `03` §7 (design, PC1–PC9 threats, state machine), and the
likelihood updates in `02` (T3.1, T9.1) and `04` (AB3). The core property is right: block-only
means a fooled classifier costs nothing. Amendments A23-1 to A23-8 were **ratified 2026-10-30** and are normative in `03` §7 and SR-26:

| # | Amendment | Why |
|---|-----------|-----|
| A23-1 | Run L3 (deterministic) **server-side at submission**, before G1, in every intake mode | PC-A runs at step 0 of `plan`, which is *after* G1. In default form mode, the owner otherwise reviews raw text at G1 with no pre-check at all. |
| A23-2 | Run the second pass **immediately after plan generation, before G2**. At `build`, verify the record matches `H_spec` and **re-run L2 against the actual build base**. | The owner decides once with flags in view, instead of approving and then hitting a hold (fatigue). `origin/<default>` can move between `plan` and `build`, so a planted instruction file could land in between. |
| A23-3 | Classifier errors and rate limits → hold with reason `precheck_unavailable` and a **Retry** action, not Clear | Fail closed without training owners to clear holds during outages or quota exhaustion |
| A23-4 | A **clean verdict renders as "no automated flags", never as a pass** | Otherwise a forced `clean` *does* gate, through the owner's lowered scrutiny (automation bias) |
| A23-5 | `security_hold` is **indistinguishable to the requester** from the surrounding stage | Otherwise the status feed becomes an oracle for tuning payloads against the classifier |
| A23-6 | Define "last owner-trusted commit": set only by the owner with step-up, never auto-advanced, must be an ancestor; missing → hold | L2 is only as strong as its baseline pointer |
| A23-7 | Run L1 in an **empty temp cwd** with the SR-01 flags and zero tools; render spans from **verified offsets into the original input** | Keeps repo files from steering the verdict; keeps model-written strings out of the dashboard |
| A23-8 | Per-requester flag-rate throttle; bulk reject, never bulk clear | False positives are this control's main failure mode (PC2) |

One framing caution for the RFC: L1 is the same model family as the build agent, so its
failures are correlated with the agent's. L2 and L3 are the independent layers. Don't describe
the pre-check as "a second line of defense against prompt injection."

## Round 4: RFC Findings and Decisions 24–25

| Item | Sentinel assessment | Where |
|------|---------------------|-------|
| CLI-H1 (gitdir redirect) | **Accepted and broadened.** Rated critical. The redirect is one member of a class: anything in the agent-written tree that *host* tooling interprets. The class also covers a writable gitdir mounted into the sandbox (worse than a redirect, and easy to create by accident when mounting a linked worktree); every config-driven executable or redirect (`core.sshCommand`, pager, editor, `diff.external`, `gpg.program`, `credential.helper`, `insteadOf`, `http.proxy`, `include`/`includeIf`); `.gitattributes` drivers (inert under isolated config); repo-relative hook managers (husky); symlinks and gitlinks; and the owner's own prompt and IDE opening the tree. Isolated config plus a trusted gitdir is the fix, so `-c` flags alone are not enough. | T8.9 to T8.14, SR-28, ST-41 to ST-46 |
| CLI-H2 (`.gitignore`, `.git` deny-list) | **Accepted.** Also: match `.git` case-insensitively after Unicode normalization; select files using the base commit's ignore rules; add `.vscode/**`, `.idea/**`, `.envrc`, and hook-manager configs. | T8.15, SR-04 |
| SU-1 (RP ID vs widget host) | **Accepted, with a correction of emphasis.** The primary control is the server's exact `expectedOrigin` check. SU-1 is defense in depth. Added: sibling hosts are *same-site*, so CSRF protection must use Fetch Metadata and exact `Origin` checks, not `SameSite`; read only `__Host-` cookies against cookie tossing. | T5.8, SR-29, ST-47 |
| Decisions 24, 25 | T10.1 and T10.2 drop to L likelihood. The key-theft blast radius is split across two keys. New T10.11 (non-App fork pushers), T10.12 (PR-App permission creep), and **T10.13: decision 25's PR-App list omits permissions MVP needs** (`issues: write`, `deployments: read`, `contents: read`). None grants merge. | SR-08, ST-14, ST-48, ST-49 |

## Verification Notes

- **Verified 2026-10-30 (primary):** headless trust behaviour, hooks, `env`, `.mcp.json`, skill
  `allowed-tools`, and the `--setting-sources` / `--bare` / `disableAllHooks` options
  (https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder,
  https://code.claude.com/docs/en/hooks#workspace-trust); the OWASP LLM Top 10 2025 list
  (https://genai.owasp.org/llm-top-10/).
- **Verified (local clone):** agent-workflow-kit workflow pinning, trusted publishing, persona
  contents, and the absence of tdd-pair from the kit.
- **UNVERIFIED:** flagd sync auth headers (S4); the auto-memory default in `-p`; Claude Code
  Action input names for non-write users; plugin auto-update behaviour; `--permission-prompts
  none` deny semantics (S6); availability of a provider moderation endpoint; the PyPI
  environment's required reviewers; details of the 2025 npm worm incidents. All other
  UNVERIFIED items are inherited from discovery.
