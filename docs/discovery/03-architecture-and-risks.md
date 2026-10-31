# Discovery: soren-loop, Architecture Decisions, Packaging, and Risks

Companion to `01-discovery.md` and `02-research-findings.md`. Date: 2026-10-30.

---

## Architecture Decisions

### ADR-1: Agent execution goes through the stock `claude` CLI, never the Agent SDK on a subscription

**Situation.** The owner wants to pay with their Claude subscription. Anthropic permits an end
user signing in to the unmodified binary, and forbids products offering "claude.ai login or rate
limits," including Agent SDK agents (`01` §Q1).

| Option | Effort | Trade-off |
|--------|--------|-----------|
| Conservative: shell out to `claude -p --output-format stream-json`, owner logged in | Low | We parse a CLI stream whose schema can drift between releases |
| Modern: Agent SDK `query()` | Low | Typed API, but subscription mode is not permitted in a product. API-key mode only. |
| YOLO: our own harness calling the Messages API with the owner's OAuth token | Medium | Exactly what Anthropic enforced against in January 2026. No. |

**Decision.** Conservative path for subscription mode. The `Runner` contract hides the
difference, so API-key mode may use the Agent SDK later.
**Accepted trade-off.** Pin a minimum Claude Code version, validate every stream line against a
zod schema, and fail closed on unknown event types in safety-relevant fields (`result`, errors,
rate limits) while ignoring unknown informational events.

### ADR-2: Intake chat runs on an owner API key, or not at all

**Situation.** An end-user-facing LLM conversation on the owner's subscription is "routing
requests on behalf of their users."
**Decision.** `intake.mode = "llm"` requires `ANTHROPIC_API_KEY` configured in the backend
(Haiku-class model, per-site monthly cost cap, per-user rate limits). `intake.mode = "form"` is the
default with no key: a guided structured form, structured later by the owner's local `plan`.
**Accepted trade-off.** It amends ratified decision #2. The owner must confirm (Open Question 1).

### ADR-3: The backend DB is canonical; GitHub issues are a one-way projection

See `02` §Q4. **Accepted trade-off:** owners who live in GitHub see a slightly stale mirror; the
nightly reconciler bounds the drift.

### ADR-4: Bot pushes to a fork; upstream access is PR-and-issue only

See `02` §Q4. **Accepted trade-off:** forking private org repos requires an org setting; Option B
(rulesets) remains as a documented fallback mode. **Blocked on spike S1.**

### ADR-5: Explicit Postgres state machine with an outbox

See `02` §Q6. **Accepted trade-off:** we own retries and timeouts; property tests and a
reconciler pay for it.

### ADR-6: flagd sourced from our DB is the default flag store; vendors via `FlagWriter`

See `02` §Q3. **Accepted trade-off:** explicit-target lists are capped; large audiences must use
rollout percentage.

---

## Packaging `/tdd-pair` for OSS Distribution

Source: `~/.claude/skills/tdd-pair/SKILL.md` (449 lines). The engine is sound and maps cleanly
onto soren-loop. `plan` produces the six-section spec the skill already demands, `build` runs
`auto`, and the state file supplies progress. These are the couplings that break outside the
author's machine, and the fix for each:

| # | Coupling in the current skill | Why it breaks in OSS / headless | Change |
|---|-------------------------------|---------------------------------|--------|
| 1 | Hard-coded `/Users/montes/.claude/agents/Ada.md` and `Zod.md` | Nobody else has these paths | Ship Ada and Zod as **plugin agents** in the plugin's `agents/` directory; refer to them by name (`subagent_type: "Zod"`). |
| 2 | Ada.md references private knowledge files under `~/.claude/knowledge/...` | Unresolvable for other users; may contain personal content | Create a public `ada.md` and `zod.md` that inline the needed rules (TDD workflow, audit criteria, AI-code discipline); drop references to private files. Needs an author review for publishability (Open Question 7). |
| 3 | `AskUserQuestion` at gates, existing-state check, pre-flight | In `claude -p` with `--permission-prompts none`, nobody answers. Behavior on a headless question is a hang or a denial. **UNVERIFIED** which. | Add a **`headless`** variant of `auto` that never calls `AskUserQuestion`. Every "STOP and surface" ends the run with a structured final message (see #6). |
| 4 | `PushNotification` on escalation | Not available everywhere, and in soren-loop the backend owns notifications | In headless mode, emit the escalation in the structured result; the CLI reports it, and the backend notifies the owner via the outbox. |
| 5 | "Autonomous mode does not commit unattended" | soren-loop needs commits for a PR | Keep it. The skill never commits. `soren-loop submit` (outside the sandbox, owner-initiated) shows the diff summary, commits per Conventional Commits, and pushes. This preserves the skill's "commits are a human action" rule. |
| 6 | Free-text final summary | The CLI must map outcomes to states | Headless mode ends with a fenced JSON block: `{"outcome": "done"|"blocked"|"needs_info"|"rate_limited", "batches": [...], "blocked_reason": "...", "spec_gaps": [...]}`, validated by `@sorenai/loop-schema`. `needs_info` maps to the `needs_info` lifecycle state; `blocked` maps to an owner escalation. |
| 7 | Pre-flight "on default branch → STOP" | The CLI controls branching | The CLI always creates `soren-loop/<id>` from a freshly fetched `origin/<default>` in a new worktree before invoking the skill, so the pre-flight passes by construction. |
| 8 | `disable-model-invocation: true`, `user-invocable: true` | Must be invocable as a prompt in `-p` | Invoke as `/soren-loop:tdd-pair auto <spec>` (plugin skills are namespaced, https://code.claude.com/docs/en/agent-sdk/plugins#use-plugin-skills). **UNVERIFIED** that a `disable-model-invocation` skill runs when the slash command is the `-p` prompt; test in spike S3. |
| 9 | `allowed-tools` includes `Task` | Name drift: Claude Code now calls subagent dispatch the Agent tool | **UNVERIFIED**; check current frontmatter tool names in the config reference before publishing. |
| 10 | State in `<cwd>/.claude/tdd-state.json` | Fine, but the worktree is the cwd | Keep. The CLI tails it for coarse progress. Add `.claude/tdd-state*` to the worktree's local excludes so it never lands in the PR. |

Plugin layout (Repo 2):

```text
soren-loop-cli/
  .claude-plugin/marketplace.json      # marketplace: name "soren-loop"
  plugin/
    .claude-plugin/plugin.json
    skills/tdd-pair/SKILL.md           # interactive + auto + headless
    skills/plan/SKILL.md               # structured request -> six-section spec
    agents/ada.md
    agents/zod.md
  src/                                 # the npm CLI
```

Keep interactive mode intact: an owner who wants to sit in the auditor chair can run
`soren-loop build <id> --interactive`, which runs `claude` (not `-p`) with
`/soren-loop:tdd-pair start`.

---

## Build Strategy

### Phase 0: Spikes (de-risk before any contract is frozen)

| Spike | Question | Kill criterion |
|-------|----------|----------------|
| S1 | Can a GitHub App open an upstream PR from a fork head with only `Pull requests: write` upstream? Does a workflow-file push get rejected without `Workflows`? | If no, ADR-4 falls back to Option B |
| S2 | `claude -p --output-format stream-json --verbose` event shapes: `result`, errors, rate-limit events, `resetsAt` | No machine-readable rate-limit signal: poll `/usage`-style output or parse errors instead |
| S3 | Plugin skill invocation as a `-p` prompt; headless behavior of `AskUserQuestion` | If the skill can't be invoked, inline it as the `-p` prompt body |
| S4 | flagd HTTP sync from our server: poll interval, auth header, reload latency | If latency is too high, use gRPC sync |
| S5 | Reference devcontainer plus worktree mount on macOS: build time, `/login` inside the container | If painful, make sandbox-runtime the default and the container opt-in |

### Phase 1: Foundation (the MVP slice from the brief)

Schema package, state machine and outbox, GitHub App install flow, widget JWT exchange, form
intake, dashboard approve with passkey, issue projection, CLI `pull/plan/build/submit`, flagd
writer, `deployment_status` handling, demo app with a deploy workflow. **Success criterion:** the
smoke test in `01` passes end to end on a fresh machine.

### Phase 2: Integration

LLM intake (API key), Claude Code Action runner (Runner B), Unleash adapter, rollout UI,
reconciler.

### Phase 3: Hosted path

Tenancy (RLS on `site_id`), owner-run runner registration (pull over an outbound connection;
nothing inbound to owner machines), and an Anthropic conversation before any hosted-runner work.

---

## Risk Register

### High

**R1. Anthropic policy shifts again.** Probability: likely (two rewrites in 2026). Impact: the
subscription path, the product's main cost story, could become disallowed overnight.
Mitigation: the API-key path is first-class from day one, not a fallback bolted on later; never
touch tokens; a CI job diffs the three cited Anthropic pages weekly. Detection: that diff job,
plus `credits_required` or auth errors in run telemetry.

**R2. Prompt injection from end-user requests reaches an agent with repo write.** Probability:
likely, the moment the widget is public. Impact: malicious code in a PR, or exfiltration through
allowed egress. Mitigation: structured spec plus human approval of a hash-pinned spec; the agent
builds only from the approved spec; sandbox egress allowlist; no GitHub write inside the sandbox;
eligibility policy (UI and read paths only). **Owner: Sentinel.** Detection: diff-scope checks
(files outside the eligibility policy fail `submit`).

**R3. The feature ships to everyone, or to no one, because the agent didn't gate it on the flag.**
Probability: coin flip without a check. Impact: the core promise breaks. Mitigation: the `build`
contract injects the flag key; `submit` refuses unless the diff references the key and a test
covers the flag-off path. Detection: that check, plus a post-deploy evaluation probe for a
non-targeted user.

**R4. Subscription limits stall builds mid-loop.** Probability: likely on Pro. Impact: requests
sit in `building` for hours. Mitigation: `paused_rate_limited` with `resetsAt`; resumable state;
the requester feed shows "building" without detail; recommend Max or Ultra in docs. Detection:
rate-limit events from the stream (spike S2).

**R5. "No merge" isn't enforceable on a single repo.** Probability: certain under Option B.
Impact: a compromised CLI or leaked token could merge. Mitigation: ADR-4 fork model; installation
tokens minted per operation, one repo, one hour. Detection: audit log of every token mint.

### Medium

**R6. Gleap Kai Code (or Copilot) adds per-user flag enablement.** Mitigation: ship the loop
end to end early; the OSS and self-hosted angle doesn't erode the same way.

**R7. Deployment detection misses hosts that don't emit GitHub deployments.** Mitigation: signed
deploy webhook plus manual `mark-deployed`. Detection: requests stuck in `merged` beyond N days.

**R8. `stream-json` schema drift breaks the CLI.** Mitigation: zod-validated parsing, a pinned
minimum version, a CI matrix against the latest Claude Code release.

**R9. flagd payload growth from explicit user lists.** Mitigation: a cap of 500 targets per flag,
and push owners to rollout rules past that.

**R10. `sandbox-runtime` is a beta research preview.** Mitigation: it's the fallback, not the
default; show the beta warning in `doctor`.

**R11. EU consumer-terms commercial-use restriction.** Mitigation: confirm the text; README
guidance; Team or API-key mode for EU owners.

### Low

**R12. Passkey loss on a single-owner install.** Mitigation: two authenticators or recovery codes
at enrollment.

**R13. OpenFeature React SDK API churn.** Mitigation: `packages/react` wraps the integration
surface, so churn is absorbed in one place.

### Dependency risk (verify before locking)

| Dependency | Concern | Alternative |
|------------|---------|-------------|
| Claude Code CLI | Vendor-controlled; policy and format changes | API-key mode with the Agent SDK |
| flagd | CNCF OpenFeature project, multi-vendor maintainers (**UNVERIFIED** current maintainer count) | Unleash as the default store |
| SimpleWebAuthn | Small maintainer team (**UNVERIFIED** bus factor) | `@github/webauthn-json` plus manual verification |
| pg-boss / graphile-worker | Single-maintainer risk (**UNVERIFIED**) | The other one; both are Postgres-only |

---

## Threat-Model Inputs for Sentinel (inputs only, not the model)

Trust boundaries to model:

1. **Host page ↔ widget iframe:** `postMessage` handshake, the `getToken` callback, `frame-ancestors`.
2. **Host backend ↔ soren-loop server:** JWT signing keys, JWKS URL fetching (SSRF), `jti` replay.
3. **Requester text → structured spec → agent prompt:** the main injection path (OWASP LLM01), plus
   intake-LLM output handling (LLM05) if ADR-2's LLM mode is on.
4. **Server ↔ GitHub:** App private key custody, webhook signature verification, per-operation
   token minting, fork model.
5. **Server ↔ owner CLI:** CLI device-flow login, API tokens, which endpoints may mint GitHub
   tokens, replay of `submit`.
6. **CLI ↔ sandbox ↔ Claude Code:** egress allowlist, env passthrough (only the Claude auth
   variable), worktree mounts, the hosts' credential stores staying outside.
7. **Server ↔ flag store:** vendor management credentials at rest; who can call `enableAll`.
8. **Owner dashboard:** WebAuthn ceremony binding, session fixation, the approval CSRF surface.
9. **Requester status feed:** information disclosure; must stay at stage names only.

Abuse cases to include: a requester floods requests to burn the owner's quota or cost cap; a
requester crafts a "feature" that is really an authz change dressed as UI; a collaborator edits
the GitHub issue to change what gets built; a malicious dependency in the target repo executes
during `build`; a stolen CLI token is used to mint push tokens; an email link scanner triggers an
approval.

Shared reference for control prescriptions: `~/.claude/knowledge/engineering/security-patterns.md`.

---

## Deliverables Check

- [x] Existing Components & Reuse Plan (third-party/OSS inventory), in `01`
- [x] Rule-of-Three evaluation (`FlagWriter`, `Runner` justified; `Notifier` kept thin), in `01`
- [x] Integration Requirements: data flow, assumption alignment, smoke test, in `01`
- [x] ADRs with options and accepted trade-offs, in this file
- [x] Risk register plus dependency risk, in this file
- [x] Security-shaped risks flagged and handed to Sentinel, in this file
- [x] Open questions for the owner, in `01`
- [ ] Spikes S1 to S5 executed (Phase 0, before the RFC freezes contracts)
