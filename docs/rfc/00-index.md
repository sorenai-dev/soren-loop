# RFC: soren-loop V1 (self-hosted control plane, owner-run builds, per-requester flags)

## Status

**Draft** · Author: Arendt · Date: 2026-10-30 · Next: contract review (Postel), then task
breakdown (Conway).

ADR-4 (fork model with two GitHub Apps) is **Accepted**: S1 passed, and decisions 24 and 25
were ratified in Round 4. Spikes S2 to S7 are open, along with S1's untested private-repo areas.
Section `12` lists which parts of this RFC each one can change.

Decisions 26 to 31 (Round 5) closed every open question in `13`, accepted SU-2, FL-1, and AU-1,
added the per-stage notification policy (`14`), and renamed the project to **soren-loop**
(decision 31). The project is published under the `sorenai-dev` GitHub account in two repos:
`sorenai-dev/soren-loop` (the control-plane monorepo) and `sorenai-dev/soren-loop-cli` (the CLI
and Claude Code plugin). Paths in this RFC are repo-relative.

## Inputs (source of truth, in priority order)

1. `docs/discovery/00-project-brief.md`: decisions 1 to 31 (Round 4: 24 and 25; Round 5: 26 to 31), the decision #2
   amendment, and A23-1 to A23-8. `docs/discovery/spikes/S1-fork-pr-permissions.md`. This RFC never contradicts a ratified decision. Where I think one is
   wrong, or where two decisions pull against each other, the item is in `13-open-questions.md`.
2. `docs/discovery/01` to `03`: discovery, research, ADR-1 to ADR-6, spikes, risk register.
3. `docs/security/threat-model.md` and `01` to `06`: SR-01 to SR-34 (including SR-28 and SR-29), ST-01 to ST-49, S1 to S7.
4. agent-workflow-kit (local clone, read 2026-10-30): `assets/skills/tdd-pair/SKILL.md`,
   `outcome.schema.json`, `core/tdd_outcome.py` (headless mode, schema version 1).

Convention: anything I could not confirm against a primary source or the local clone is
marked **UNVERIFIED**. SR and ST IDs refer to `docs/security/06-requirements-tests-spikes.md`.

## Files

| File | Contents | 
|------|----------|
| `00-index.md` | This file: status, map, summary, glossary |
| `01-overview-and-goals.md` | Context and scope, goals, non-goals (every deferral), constraints |
| `02-architecture.md` | Architecture diagram, repo split, components (owns / does NOT own), interactions, reuse plan, integration requirements |
| `03-state-machine.md` | The request state machine: states, events, guards, effects, actors; Mermaid diagrams; holds, pauses, loops; requester stage mapping; invariants |
| `04-data-model.md` | Tables, ER diagram, outbox, audit trail, `H_req` / `H_spec` hashing, approval receipts, retention |
| `05-api-design.md` | API surfaces, error shape, idempotency, IDs; versioning, rollout, and deprecation |
| `06-intake-and-approvals.md` | Deep dives: intake (form and API-key chat), gates G1 to G4, WebAuthn step-up, pre-check orchestration |
| `07-cli.md` | Deep dive: CLI `pull/plan/build/submit`, rework, `--interactive`, the CLI machine contract (exit codes, JSON output) |
| `08-github-and-deploy.md` | Deep dives: GitHub fork model with two Apps (ADR-4, accepted), deploy detection |
| `09-security-mapping.md` | Every MUST-MVP SR mapped to its implementing component, plus the ST coverage |
| `10-cross-cutting.md` | Observability, self-hosted deployment (two hostnames), cost, rollback, the weekly policy-diff job, testing |
| `11-alternatives-and-tradeoffs.md` | Alternatives compared on fixed criteria, and the decision rationale |
| `12-plan-mvp-and-spikes.md` | MVP pullback, first three components, what breaks at 10x, phases with estimates, spike dependencies |
| `13-open-questions.md` | Decision log: how each open question and tension was closed (decisions 26 to 31), plus new tensions |
| `15-sandbox-and-packaging.md` | Deep dives: `claude -p` hardening, sandbox phases, `/tdd-pair` packaging, outcome handling |
| `16-flags.md` | Deep dive: `FlagWriter`, flagd, Unleash, the flag gate, the OFREP contract |
| `reviews/` | Zod and Postel reviews (2026-10-31); the findings→fix map is in `13` §5 |
| `14-notifications.md` | The per-stage notification policy (decision 30): `NotificationPolicy.resolve`, locked owner alerts, suppression records, site overrides |

## Summary

soren-loop is an Apache-2.0, self-hosted control plane plus an owner-run CLI. An
authenticated end user submits a feature request through an embeddable widget (a no-LLM form by
default, an LLM chat when the owner supplies an API key). The owner approves the request (G1)
with a passkey. The owner's CLI then runs `plan` with the owner's own `claude -p`, and the owner
approves the resulting six-section spec (G2), again with a passkey. Next, `build` runs the
vendored `/tdd-pair auto --headless` inside a sealed sandbox. `submit` applies deterministic
checks, pushes to a bot fork, and opens an upstream PR that the owner reviews and merges (G3).
When a verified production deployment contains the merge commit, the backend turns the
feature's flag on for the requester, and the owner can widen the rollout (G4).

The design rests on four positions:

1. **The request is a long-lived aggregate in Postgres** with a table-driven state machine and a
   transactional outbox (ADR-5). Model output can stop a request. It never advances one (SR-18).
2. **Privilege lives outside the agent.** The build agent is assumed compromised whenever the
   request is malicious (threat model A6). Safety comes from the sealed sandbox, the
   deterministic `submit` policy, and the owner's review at G2 and G3. Zod and green tests are
   quality signals only.
3. **Approvals are content-bound.** Each WebAuthn challenge commits to `H_req` or `H_spec`, so
   what the owner signed is what gets built. The CLI recomputes the hashes, and in a later step
   verifies the receipts itself (SR-19).
4. **The requester sees seven coarse stages.** A `security_hold` never changes the requester's
   stage, never emits a requester event, and never sends a requester notification.

## Glossary

| Term | Meaning |
|------|---------|
| Owner | The person who operates the self-hosted control plane and owns the target repo |
| Requester | An end user of the owner's host app, authenticated by the host's signed JWT |
| G1 / G2 / G3 / G4 | Gates: request approval / spec approval / PR merge (on GitHub) / rollout widening |
| `H_req`, `H_spec` | SHA-256 content hashes over the normalized request revision and the spec (`04` §3) |
| PC-S, PC-I, PC-A, PC-B, PC-C | Pre-check checkpoints: at submission, at intake (LLM mode), step 0 of `plan`, on the generated spec, at `build` start |
| L1 / L2 / L3 | Pre-check layers: no-tool classifier / instruction-file diff / deterministic rules |
| Receipt | The stored WebAuthn assertion for an approval, verifiable offline against pinned public keys |
| PR App / push App | The two GitHub Apps of decision 25: the PR App is installed upstream (`pull_requests: write`); the push App is installed only on the bot-only fork (`contents: write`) |
| Runner A | The owner's CLI on the owner's machine (MVP). Runner B is the Claude Code GitHub Action (Phase 2). |
| `sl_` key | An opaque, random flag key minted at G1 (SR-13) |
| Hydrate / sealed | Sandbox phase A (lockfile install, registry egress) / phase B (Anthropic-only egress) |
