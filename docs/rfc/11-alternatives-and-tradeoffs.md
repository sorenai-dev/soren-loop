# 11. Alternatives Considered and Decision Rationale

Preference strength: **A >> B** means A is significantly better. **A > B** means A is better and
B is acceptable. **A ≈ B** means the tradeoffs cancel, and the canceling tradeoff is named.

## 1. Workflow Engine (ADR-5)

| Criterion | **A: Postgres state machine + outbox + PG queue** | B: Inngest (self-hosted) | C: Temporal | D: DBOS Transact |
|-----------|----------------------------------------------|--------------------------|-------------|------------------|
| Meets goals | Yes. The request is an aggregate driven by five actors. | Yes, but actors become events into a function | Yes, with determinism rules on workflow code | Yes |
| Complexity / effort | We own retries, timers, and idempotency (~1.5 weeks) | Low code; extra services | High: cluster plus workers | Low: a library on our Postgres |
| Operational burden for self-hosters | Postgres only | Inngest server + Redis + Postgres; `start` labelled beta | Highest | Postgres only |
| Failure modes | Our bugs in retry and timeout code; covered by property tests and the reconciler | Opaque engine state vs our DB | Workflow-versioning pain over long waits | Young project; step semantics vs our transition table |
| Reversibility | High (an engine can be introduced behind the outbox) | Medium | Low | Medium |

**A > D >> B > C.** D is the named escape hatch if orchestration ever moves server-side (hosted
runners). A wins because the state machine's table *is* the security spec (ST-23), and putting
it inside a function-shaped engine would hide the guards.

## 2. PR Model (ADR-4, accepted: decisions 24 and 25)

| Criterion | **A: Fork + two Apps** | A′: Fork + one App | B: Same-repo branch + rulesets | C: Owner's own git credentials |
|-----------|------------------------|--------------------|--------------------------------|--------------------------------|
| Meets goals ("cannot merge") | Yes, structurally: no upstream credential can merge | Only if the minting code is correct (S1 F2: the installation can mint a merging token) | Only if the owner's rulesets are correct | No |
| Complexity | Two registrations, two keys, a bot-only org | One App | `doctor` ruleset checks | Lowest |
| Operational burden | Owner manages two keys; rotation per App | One key | Owner maintains rulesets | None |
| Failure modes | Owner misconfigures the fork's human access (F1, caught by `doctor`) | A bug or leaked key means merge | A misconfigured ruleset means merge; same-repo PRs get secrets (S1 Q4) | The owner's credential sits next to agent output |
| Reversibility | High | High | High | — |

**A > A′ >> B >> C.** A over A′ is the F2 argument: the cost is setup friction, and it buys a
property the minting code can't break. B is rejected by decision 24 as the design, and survives only as the opt-in path for orgs that forbid private forks, by decision 29 / Q1 (`08` §1.8). C puts the owner's
credential in the `submit` path.

## 3. Sandbox Default

| Criterion | **A: Two devcontainers (hydrate, sealed)** | B: One devcontainer with a firewall switch | C: `sandbox-runtime` (beta) | D: VM |
|-----------|-------------------------------------------|-------------------------------------------|-----------------------------|-------|
| Meets SR-02 | Yes | Yes, if the `NET_ADMIN` drop is right every time | **UNVERIFIED** egress parity (S5) | Yes |
| Effort | Medium | Medium | Low | High |
| Owner burden | Docker | Docker | None | VM tooling |
| Failure modes | Cold starts; install-script packages | Firewall-switch race; capability left behind | Beta config churn; partial process coverage | Heavy; slow |
| Reversibility | High | High | High | High |

**A > B > C; D is for untrusted repos.** A ≈ B on effort. The canceling tradeoff: A pays a
second container start, and B pays an in-agent-container privilege transition. A wins because
its safety doesn't depend on getting that transition right.

## 4. Requester Stage Granularity

| Criterion | A: Three stages (`received`, `in_progress`, `done`) | **B: Seven stages (`03` §5)** | C: Every internal state |
|-----------|-------------------------------------------------------|---------------------------------|-------------------------|
| Hold invisibility (A23-5) | Trivially | Yes: every hold sits inside a stage | **No** (an oracle) |
| Requester value | Low ("in progress" for weeks) | Medium | High |
| Recon leakage (AB6) | Lowest | Low (timing coarsened to the hour) | High |
| Reversibility | Adding stages is a breaking change (`05` §4) | Same | — |

**B > A >> C.** B was checked hold by hold: PC-A, PC-B, and PC-C all fall inside `planning`,
and PC-S and PC-I inside `received`.

## 5. Where `plan` Writes the Spec

| Criterion | **A: Final message; no Write tool** | B: Write tool limited to one path |
|-----------|-------------------------------------|-----------------------------------|
| SR-03 | True by construction | Depends on path rules holding in headless mode |
| Effort | Fenced-block extraction (the same pattern as the outcome JSON) | Permission rules |
| Failure modes | Truncated output for very long specs (spec size cap anyway, AB3) | Path-rule bypass |

**A >> B.**

## 6. Repo Split

| Criterion | **A: Monorepo + CLI repo (discovery, decision 10)** | B: Four repos (brief) | C: One monorepo including the CLI |
|-----------|----------------------------------------------------|-----------------------|-----------------------------------|
| Trust boundary for the CLI | Separate release signing and review | Separate | Shared with the server |
| Schema sharing | Inside Repo 1; published for the CLI | Cross-repo everywhere | Inside |
| Flag adapters | Server-only package | In the host SDK (ships write paths to customer bundles) | Server-only |

**A > C >> B.** C is acceptable for one maintainer, but the plugin marketplace still wants its
own repo root.

## 7. Trade-offs and Decision Rationale (summary)

| Decision | We gain | We pay | Mitigation |
|----------|---------|--------|------------|
| Own state machine | Guards as data; one datastore; debuggable with `SELECT` | Retry and timer code | Property tests, the outbox, the reconciler |
| Model output only stops | SR-18 is structural, not a convention | An extra owner click in `stalled` (for example, turning an advisory `needs_info` into a question) | The dashboard shows the advisory reason with one-click actions |
| Content-derived challenges | Approvals commit to content cryptographically | Hash spec and normalization are now a versioned contract | Golden vectors shared by server and CLI |
| Seven requester stages | A hold is invisible, and requesters still see progress | Less detail for requesters | Owner-authored questions are the high-value channel |
| Exact-host RP ID | No widget-origin ceremonies | Renaming the dashboard host means re-enrolling | Setup docs mark the hostname permanent |
| Two-container sandbox | No in-agent privilege transition | Cold start per phase | Image reuse; start only after the pre-check passes |
| Re-running checks after the agent | The only non-model evidence of success | Double test time | Scoped check commands |
| Server compare re-check at submit | Defense in depth independent of the CLI | One compare API call per submit | — |
| flagd from Postgres | No new service; the DB is truth | PII in flag documents; linear growth | 500 cap; purge rewrite; internal endpoint |
| Auto-enable on deploy | Matches the brief; the loop closes without a click | A merger other than the owner triggers enablement | Site options by decision 29 / Q2 |
