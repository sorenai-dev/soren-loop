# Zod Technical Review: soren-loop V1 RFC (`00` to `14`)

Reviewer: Zod · Date: 2026-10-31 · Inputs: RFC `00`–`14`, brief decisions 1–31, `security/06-requirements-tests-spikes.md`. Out of scope: T17–T21, the rename, wire formats (Postel).

## Assessment Summary

- **Verdict: Not ready for task breakdown.** The issues are fixable in one revision pass. They are not design reversals.
- Complexity: Complex. Confidence: High on the state machine, data model and outbox findings. Medium on the estimate.
- Findings: **5 blocker, 15 major, 12 minor.**

The core positions are sound and well defended: the table-driven state machine with OCC, content-bound challenges with length prefixes, "model output can stop, never advance", the two-container sandbox with a root init step, the trusted gitdir plus a plain run tree, and policy evaluation pinned inside the transition transaction. The leading-edge, per-kind coalescing rule in `14` §4 is a precise fix for a real failure mode.

The weak spot is the table in `03` §3 itself. It reads well on the happy path, but it is not closed under failure. Several states have no exit. One requester event can strand a live flag. And the outbox key scheme collides on the default notification policy. These defects will be copied straight into ST-23 property tests and tasks unless they are fixed first.

---

## Blockers

### B1. Outbox idempotency keys collide on the default notification policy
**Ref:** `04` §5 (key = `H(request_id‖transition_seq‖effect)`); `14` §4 (one row per event per channel; effect = `"notify." + c`). Row 1 (`submit`) emits `requester.stage_entered{received}` and `owner.request_submitted` in one transaction, and both default to `email` (`14` §2.1). Both rows get effect `notify.email` and the same `(request_id, seq)`, so the unique constraint fails and **every submission aborts**. Row 28 collides the same way under any override that emails `owner.flag_enabled`. The suppressed rows (`defaults \ effective`) collide too. Events with no transition behind them (`owner.app_permission_check_failed`, `owner.outbox_dead`) have no `transition_seq` or `request_id` at all.
**Fix:** derive notify keys as `H(source_id‖event_kind‖audience‖channel)`, where `source_id` is `transition_seq` for transitions and the audit or outbox row ID otherwise. Make `outbox.request_id` nullable. Add `audience`, `kind`, `channel`, `policy_version`, `reason` and `message_id` as real columns, not `payload` keys, because `14` §4 filters and groups on them. Add an ST: "row 1 under default policy with a verified email inserts N distinct rows."

### B2. The state machine has dead-end states with no owner exit
**Ref:** `03` §3 rows 4, 8–11, 22–23, 27–28; `04` §5 ("a dead effect never transitions"); `10` §4 ("reject works from every waiting state … the lease is revoked").
- `building{ready}`: if the server's compare re-check fails (row 23 guard), or the push fails after the single mint (invariant 7), there is no event out of `ready` and no `reject`.
- Row 23 says `in_review` "after the PR-open effect succeeds", but there is no `pr_opened` / `pr_open_failed` row. `04` §5 names `pr_opened` as an event. Which state holds the request meanwhile, and where does a `dead` PR-open go?
- `paused_rate_limited`: only `resume` (CLI) or `withdraw` (requester). An owner who abandons the run cannot reject it.
- `merged`: only a deploy event. The 7-day timer alerts, but nothing exits.
- `deployed`: a `dead` `flag.enable_for` leaves the requester in `shipping` forever. The reconciler only reports.
- `planning` / `building{running}`: row 4 excludes them, which contradicts `10` §4.
**Fix:** (a) add `reject` from every non-terminal, non-live state, with lease revocation as an effect. (b) Add `submit_rejected{reason}` → `stalled{phase: build}`, and allow a re-mint after a failed push under a new `submit_attempt` (or re-run `build`). (c) Add an explicit `building{submitting}` sub-state, with `pr_opened` → `in_review` and `pr_open_failed` → `stalled`. (d) Add an owner action `retry_effect{outbox_id}` (+audit) for `dead` effects. (e) Add a liveness invariant to ST-23: from every non-terminal state, an owner-initiated event can reach a terminal or live state.

### B3. `withdraw` from live states strands a live flag; from `in_review` it orphans the PR
**Ref:** `03` row 33 ("any non-terminal state"), rows 29–32 (live-state events only), §2 (`closed` is terminal and accepts no events). A requester can withdraw from `rollout_all`. The request lands in `closed{withdrawn}`, which accepts no events, so the owner can no longer `kill_flag` a feature that is on for everyone. The safety control becomes unreachable through a requester action. Withdrawing from `in_review` leaves the upstream PR open with no closing effect. If the owner then merges, `pr_merged` hits a terminal state and gets a 409.
**Fix:** limit `withdraw` to pre-merge states, and add `close_pr` as an effect when it fires from `in_review` or `changes_requested`. From live states, a requester "withdraw" should only remove their own `sub` from the targets, as an effect, with no state change. Add ST-23 invariant 9: "every live flag remains killable."

### B4. `H_req` covers fields that don't exist when it is first computed
**Ref:** `04` §3 (the canonical revision includes `eligibility_class` and `owner_context`); `03` row 1 (compute `h_req` at submit); row 3 (the G1 guard: "owner chose the eligibility class"; the challenge is over `h_req`). The eligibility class is chosen by the owner at G1, so the `H_req` computed at submit can't include it. Either G1 signs a hash the server recomputes at approval time, which is a different `h_req` from the one PC-S and PC-I recorded (and their guards require a match), or the class is unbound. The hash format becomes a published contract with the first CLI release (`12` §2), so the golden vectors must be right first.
**Fix:** keep `H_req` over requester content only. Bind owner choices in the G1 content hash: `content_hash_G1 = H("sl:g1:v1"‖h_req‖eligibility_class)`, with the CLI recomputing it from the same fields. Treat `owner_context` as `kind: owner_context` revisions (already in `request_revisions`) whose `H_req` is computed when they are created. Publish the vectors after this change.

### B5. The rework and feedback loops are underspecified, and two paths corrupt state
**Ref:** `03` rows 12, 13, 21, 24; `07` §1.2–1.3; `04` `specs.feedback_h_fb`.
- **Run tree for rework.** `07` §3 says the run tree is "an export of `base_sha`". A rework build from `changes_requested` would then start from scratch, not from the PR head. The doc doesn't say whether `submit` fast-forwards or force-pushes the fork branch, what happens when PC-C re-exports at a new base (the branch diverges), or what base the server's compare re-check uses.
- **How rework feedback reaches the agent.** Rework feedback comes from a dashboard session with **no step-up**, or from a GitHub review, and it is fed to a write-capable agent. It has `h_fb` but no receipt. That breaks position 3 ("approvals are content-bound") and G-3. A stolen dashboard session can steer the build without the passkey.
- **`retry` loses context.** Row 12 sends `stalled{plan}` to `owner_approved`, which drops pending plan feedback. It sends `stalled{build}` to `plan_approved`, which drops `rework_of` while a PR is open.
- **`ask_requester` from `changes_requested`** (row 13) sends the request back to `submitted` with the upstream PR still open. A later `pr_merged` returns 409.
**Fix:** specify the rework run tree (an export of the PR `head_sha` from the trusted gitdir), the push mode (fast-forward only, with a rebase as a new run), and the compare base. Bind rework feedback with +SU (`action: rework`, content `H(h_spec‖h_fb)`) and have the CLI verify that receipt. Carry `feedback_id` and `rework_of` in `stalled.state_ctx` and restore them on retry. Remove `changes_requested` from row 13, or close the PR as an effect.

---

## Major

### M1. Webhook ordering drops deploys; the decision 29 (Q2) gates are missing from the table
**Ref:** `03` rows 25, 27; `08` §3; `06` §2. GitHub doesn't guarantee delivery order. Retries reorder. A fast CD pipeline can deliver `deployment_status` before `pull_request.closed`. Row 27 accepts it only from `merged`, so it returns 409, gets marked seen, and the request waits for a deploy that already happened. Separately, `merger_must_be_owner_login` (a row 25 guard) and `dashboard_confirm` (a +SU state between `deployed` and the flag write) appear in `06` §2 and `08` §3 but not in `03`.
**Fix:** always persist verified deployments in `deployments`. On entry to `merged`, evaluate the stored deployments as a `Sys` event. Add the guard, plus a `deployed{awaiting_confirm}` sub-state with a `confirm_enablement` +SU row.

### M2. `retry_precheck` dead-ends for PC-B
**Ref:** `03` rows 7, 18, 35. A PC-B `precheck_unavailable` hold returns to `plan_review` without a valid record. Row 18 requires one, and no CLI command re-runs PC-B from `plan_review` (`plan` starts only from `owner_approved` or `plan_feedback`). G2 is then permanently blocked.
**Fix:** route a PC-B retry to `planning`-eligible (`plan_feedback` with an empty feedback, or a new `rerun_precheck_b` CLI command whose upload replaces the record).

### M3. The throttle penalizes requesters for things they didn't do, and three files disagree
**Ref:** `03` §3 Throttle and row 1 guard; `06` §1.4; `04` `requesters.flag_count_24h`.
- PC-A and PC-B include L2, a **repo** instruction-file diff, and `precheck_unavailable` (classifier outages). Both count toward the requester's throttle. A `CLAUDE.md` commit or an Anthropic outage would shadow-throttle every active requester.
- The row 1 guard says "requester not throttled". That contradicts shadow-accept.
- `06` §1.4 says the throttle uses "the same response as a cap". That contradicts SR-40b.
- A counter column can't implement a rolling 24-hour window.
**Fix:** count only `flagged` verdicts from L1 or L3 over requester content. Derive the count from `prechecks` rows by timestamp. Change the row 1 guard to "if throttled, set `throttled=true`". Correct `06` §1.4.

### M4. Notification events aren't specified per transition
**Ref:** `03` §3 effects column; `14` §1–2. Effects say "owner email" loosely. Rows 5 and 20 (PC-A and PC-C holds) say only "Store record". An implementer following the table would emit no locked `owner.security_hold_entered`. Also undefined:
- which kind a `precheck_unavailable` hold emits (one kind, or both);
- where timer-driven kinds come from (`deploy_wait_exceeded`, a lease-expiry `run_stalled`), and which policy version they pin (the one at timer creation, or at firing);
- where the per-site requester-email opt-in lives (it is not in `sites`; `14` §2.1 says "off by default", but the defaults table shows `[email]`);
- per-request ordering of `ceil_hour` requester rows (parallel workers can send `planning` before `received`).
**Fix:** add an "Events" column to the transition table naming each `NotificationEvent` kind. Model timers as `Sys` events resolved when they fire. Add `sites.requester_email_enabled`. Deliver requester rows in `transition_seq` order per request.

### M5. A successful requester is told "closed"
**Ref:** `03` row 32 and §5; `14` §2.1, ST-59. `retire` from `rollout_all` goes to `closed{shipped}`, which projects to `closed`. The requester then gets the byte-identical "closed" email (the same one rejection uses) for a feature that is on for everyone.
**Fix:** project `closed{shipped}` to `available`, or make `retire` a non-transition (archive flag). Update ST-59's cause list.

### M6. Audit-chain scope, columns and serialization disagree across documents
**Ref:** SR-37; `04` §4 and §2; `09` SR-15 ("optional hash chain"); the `09` §1 table. SR-37 chains approvals, token mints, flag writes, clears, and policy edits, with `prev_hash`/`row_hash`, "serialized per chain", and export after each step-up. `04` chains only `request_transitions` and `audit_events`, has no chain columns in either table, and exports nightly. Nothing says what one chain covers (global, per site, or per table). A single global chain serializes every transition on one head lock. `09` §1 also omits SR-35, SR-36, SR-37 and SR-38 entirely, even though it says it maps "every MUST-MVP SR".
**Fix:** one chain per `(site_id, table)`, appended under `pg_advisory_xact_lock(chain_id)`. Add the columns. Match the SR-37 export cadence. Add the four missing rows to `09` §1 and delete "optional".

### M7. Retention misses several PII stores
**Ref:** `04` §7, SR-27, ST-38. The nightly purge doesn't cover:
- `outbox.payload` (flag effects carry `sub`s; notify rows may carry addresses);
- `idempotency_keys.response` (24 h, but it may echo request text);
- `runs.advisory` (model `spec_gaps` echo requester text);
- `requesters.email_enc` (listed in `14`, absent from `04` §7);
- the flagd document history;
- CLI run directories (`~/.soren-loop/runs/<run_id>/tree/.soren-loop/spec.md`, which is never purged);
- PR, commit and issue text derived from the owner-edited title.
**Fix:** enumerate every column and artifact with a retention rule. Add a CLI `gc` that runs on `pull`, keyed to server purge tombstones. Extend ST-38 to the full list, including removing the `sub` from the flagd document.

### M8. Three deterministic guards have no deterministic definition
**Ref:** `03` row 18 ("paths named in the spec inside the policy"); SR-04(d) ("a test exercises the flag-off path"); ST-05. Extracting paths from free-form markdown isn't deterministic, so it can't gate G2. "Exercises the flag-off path" has no definition a no-LLM checker can evaluate, so ST-05 can't be written. ST-05 also tests "a new dependency **not in the spec**", which implies dependencies in the spec are allowed. That contradicts decision 16 and SR-04(c).
**Fix:** add a structured `paths[]` field to the spec envelope (schema-validated and hashed in `H_spec`). Define flag-off as "the owner's test command passes with the OpenFeature in-memory provider forcing `sl_…=false`, and a test file references the key". Fix the ST-05 wording.

### M9. SR-19 (MUST-MVP, no escape hatch) has no test, and clears are unverified
**Ref:** `09` SR-19 → "ST-06 (receipt variants)"; `04` §6. ST-06 tests server-side assertion checks, not the CLI's offline verifier. Also, the CLI trusts the server's claim that a clearance covers a re-flagged PC-A or PC-C. A compromised server can launder a hold, which is exactly the threat SR-19 exists for.
**Fix:** add an ST that forges a receipt against valid server data for each `04` §6 step (origin, rpIdHash, UV, unpinned key, key added without +SU, challenge mismatch). Have the CLI verify `clear_hold` receipts whenever a local check flags but the server reports it as covered.

### M10. The release gate covers 40 STs; MUST-MVP needs 62
**Ref:** `10` §6 ("ST-01 to ST-40 … release gate"); `12` §4 ("ST-01 to ST-40 MVP subset"). ST-41 to ST-62 (SR-28, SR-29, SR-35 to SR-40) are MUST-MVP tests outside the stated gate. ST-24 is hosted-only but sits inside the range.
**Fix:** tag every ST with a priority, and gate on the tag. SR-13 ("writes only via outbox"), SR-15, SR-16 and SR-17 each need a numbered ST (a lint or an integration test), not a "release checklist".

### M11. Sandbox gaps a compromised agent can use
**Ref:** `07` §1.2 steps 6–7, §3; SR-02.
- Step 6.3 re-runs the checks "inside phase B". If that means the agent's own container, any background process the agent left behind can tamper with check output. Run the checks in a **fresh** phase-B container over the same tree.
- On `--resume` or rework, does phase A run again over an agent-modified tree? An agent-written `.npmrc` or lockfile (deny-listed only at `submit`) would run in hydrate, with registry egress. Rule: phase A only ever runs on a pristine export, and agent-touched trees never hydrate.
- The credential volume is mounted with no stated mode and persists across runs. Mount it read-only, or copy the credential into the per-run config dir.
- SR-02 says "no mounts except the worktree", but `07` §3 mounts four things. Reconcile the text.

### M12. The L1 classifier on the host has no specified config isolation
**Ref:** `06` §4 L1; SR-26a; `07` §2 (fresh `CLAUDE_CONFIG_DIR` only inside the container). L1 runs on the host with `--setting-sources user`, which loads the owner's real user settings, including user-scope MCP servers and plugins. `disableAllHooks` doesn't remove MCP tools, so "zero tools" depends on S6 and on the owner's personal config.
**Fix:** L1 always runs with a fresh `CLAUDE_CONFIG_DIR` (credential only) and `--strict-mcp-config` or its equivalent, or inside the sealed container. Add this to ST-35.

### M13. No credential is specified for fetching a private upstream into the trusted gitdir
**Ref:** `07` §1.1 step 2, §1.3 (minimal `GIT_CONFIG_GLOBAL`, so no credential helper); `02` §7 (the smoke test uses a **private** demo repo). The CLI never holds a PR-App token, and the owner's helper is deliberately excluded. As written, `plan` can't fetch a private repo, and the smoke test can't pass.
**Fix:** specify a server-minted, read-only, per-run fetch token (the PR App's `contents: read`, 1 h, via `GIT_ASKPASS`), or an explicitly scoped use of the owner's helper for fetch only. Audit either one.

### M14. The ~19.5 eng-week MVP is optimistic by roughly 35–50%
**Ref:** `12` §4. 19.5 eng-weeks over two engineers is 9.75 weeks with no slack. That fits the 10–12 week band only with zero spike-driven redesign, and S5, S6 and S7 can force one. The total leaves out:
- owner authentication, sessions and recovery codes;
- the site setup and config UI, and trusted-commit management;
- SR-37's witness export, verifier and CLI head recording;
- the SR-36 OFREP proxy in `packages/node` and `packages/react`;
- the reconciler; the metrics and the metric-label lint;
- the deploy webhook;
- the compose/Caddy quickstart and docs (G-7);
- the blocker fixes above.

Some lines also look thin: ST-01 to ST-62 at 1.5 weeks; the notification seam with coalescing, banners and the inbox at 0.75; the CLI at 3.5 (device flow, `doctor`'s App and fork checks, the offline WebAuthn verifier, the outcome-validator port, SR-28). There is also an external dependency: the agent-workflow-kit PR is still pending upstream (`07` §4).
**Fix:** re-estimate at **26–30 eng-weeks (14–16 calendar weeks for two engineers)**, or cut scope in writing (candidates: `build --interactive`, `rollout_targeted`, issue projection). State the 10x baseline as a target, not an assumption. At 100 requests a week, owner-started foreground builds of about 90 minutes (≈150 machine-hours a week under decision 6) break at the same moment as review bandwidth, so they should be co-ranked first. "Duplicate collapse (MVP)" in `12` §3 has no state-machine or data-model support. Either specify it or drop it from the mitigation.

### M15. A clearance is written by a transition but has no table, and its binding is inconsistent
**Ref:** `03` row 34 (the challenge omits `l2_fingerprint`; the effect writes a "clearance row"); `04` §3 (`content_hash = H(verdict_id‖content_hash‖l2_fingerprint)`); SR-26e (binds `(request_id, verdict_id, content_hash)`). `04` has no `clearances` table, so invariant 4 and ST-32 have no schema to test against.
**Fix:** add `clearances(id, request_id, verdict_id, content_hash, l2_fingerprint, approval_id, created_at)`. Adopt the `04` §3 binding everywhere, and update the challenge in row 34 and the SR-26e text.

---

## Minor

1. **"Live states" is undefined** (`03` rows 29–30). Does it include `flag_off`? `widen_rollout` from `flag_off` would re-enable the flag without `restore_flag`. Enumerate the set.
2. **A second G1 after a requester reply** (row 15 → row 3) runs "mint `sl_`" again, but `requests→flags` is `o|`. Make the mint idempotent per request.
3. **The `start_build` guard trusts a `doctor` attestation** for the path policy (row 21). The server holds `sites.path_policy` and the Q12 +SU confirmation, so check it server-side.
4. **Row 22 (mint) omits the SR-26h pre-check-record guard.** Row 23's "push token was used" is unobservable by the server. Replace it with "the compare API's fork branch head == `head_sha`".
5. **The 90-minute wall-clock cap** (`07` §1.2) is likely below a Zod-gated tdd-pair run on a medium feature, and a timeout restarts from zero. Allow `--resume` after `run_stopped{timeout}` on the preserved tree. Laptop sleep longer than the 15-minute lease also stalls a run, so document it.
6. **`build --interactive` attaches the agent's output to the owner's TTY**, so OSC 52 (clipboard write) and other escape sequences are a host channel. Filter escape sequences, or document the risk under SR-38.
7. **Some STs aren't operational.** ST-62's "latency band" and ST-26's "control-flow trace" need numeric or instrumented definitions (for example, p95 within ±X ms over N samples; trace = an ordered list of guard IDs).
8. **Stale text.** `09` §3 and `12` Phase 3 still list "SR-19 as MUST" as a Phase 3 item.
9. **`14` §4's row count is ambiguous.** With `effective = []`, the pseudocode inserts both the `defaults \ effective` rows *and* `notify.none` ("one row"). ST-54 compares counts, so pick one. Coalescing and SR-11 digests are worker-time decisions, which contradicts "workers never decide whether to send". Say where batching happens.
10. **The mermaid diagrams in `03` §4** omit the PC-A hold from `plan_feedback`, the PC-C hold from `changes_requested`, and `in_review → closed`.
11. **Lease state has two sources:** `state_ctx.lease_id` and `runs.lease_id`. Pick `runs` as the authority. Also, `owners` has no link to `sites` in the ER diagram, despite the `site_id` seams.
12. **The commit in `submit`** uses the owner's identity and optional signing for agent-written code. Add a `Co-authored-by: soren-loop[bot]` trailer, or use the bot identity, so the attribution is honest. **G-7's** "under 30 minutes" with two Apps, a bot org, passkeys and two TLS hosts needs a measured acceptance test, or a softer label.

---

## SR → ST Testability Summary

| Status | SRs |
|--------|-----|
| Testable as written | SR-01, 03, 05, 06, 07, 09, 10, 11, 12, 14, 18, 20, 26 (except h on the mint), 28, 29, 35, 36, 38, 39 |
| Test missing or not operational | SR-19 (M9), SR-04(d) (M8), SR-13 outbox-only writes, SR-15, SR-16, SR-17 (M10), SR-27 scope (M7), SR-37 export-after-step-up (M6), SR-40b latency (minor 7) |
| Requirement text contradicts the RFC | SR-02 mounts (M11), SR-26e binding (M15), SR-04 vs ST-05 dependency wording (M8) |

## Recommended Next Steps

1. Arendt revises `03` §3 for B2, B3, B5, M1, M2 and M4 (add an "Events" column and the missing rows), then reruns the stage-projection check in §5 over the new rows.
2. Revise `04` for B1, B4, M6, M7 and M15. Regenerate the golden vectors after B4.
3. Revise `07` for B5 (rework tree and push mode), M11, M12 and M13.
4. Tag every ST with a priority, and add the missing STs (M8, M9, M10).
5. Re-estimate `12` §4 (M14), or record the scope cuts.
6. Run a delta re-review of `03`, `04` and `07` only. Everything else can go to task breakdown once those land.
