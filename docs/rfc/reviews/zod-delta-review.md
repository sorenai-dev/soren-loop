# Zod Delta Re-Review: `03`, `04`, `07`, `15` §2, `17`, `18`

Reviewer: Zod · Date: 2026-10-31 · Baseline: `zod-review.md` (5 blocker / 15 major / 12 minor).
Scope: the files Arendt named, plus the parts of `08` §2, `12` §4 and `13` §5 that the fixes
point to. Wire formats are still Postel's.

## Verdict

**Not ready yet. One targeted pass is needed, not another full review.** 31 of the 32 original
findings are addressed in the RFC (m7 is deferred to Sentinel). 28 are closed outright, M1 and
M8 are partly closed, and M10 waits on Sentinel. Two fixes (M1 and the B5 `--fresh` path)
introduce new defects at the seams they created. One of those, D1, ends live requests in normal
use.

New findings: **1 blocker, 6 major, 5 minor** (one minor withdrawn in favour of Sentinel's
ruling). Fixing D1 to D7 is a narrow edit to `03` rows
22–27 and 43, `04` `deployments`, `07` §1.3–1.4, and `08` §2. I'll verify those by diff, with no
third full pass.

## Closure of the Original Findings

| Finding | Status | Evidence |
|---------|--------|----------|
| B1 | Closed | `04` §5: the key includes `kind`, `audience` and `channel`; `request_id` is nullable; real columns; a row 1 ST was proposed |
| B2 | Closed (one residual, D3) | Row 4 over P, rows 39–41 for `building{submitting}`, row 38 `retry_effect`, row 45 `cancel_run`, invariant 10 |
| B3 | Closed (one residual, D5) | Row 33 limited to P plus `gh.close_pr`; row 43 opt-out; row 32 archives; invariants 9 and 12 |
| B4 | Closed | `04` §3.3–3.4: a closed `sl.request.v1`, `sl:g1:v1(h_req, class)`, LP framing, a prefix registry, vectors H-06 and H-13 |
| B5 | Closed (one residual, D1/D2) | `07` §1.4 table; row 24 +SU `sl:rework:v1`; row 12 restores context; rows 13–14 require no open PR |
| M1 | Partially closed (D2) | Deployments are persisted and evaluated on `merged`, but the matching model is wrong (D2) |
| M2, M3, M4, M5 | Closed | Rows 35 and 44; the derived `requester_attributable` throttle; the Events column and `timers`; `retire` archives |
| M6, M7, M9, M11, M12, M13, M15 | Closed | `04` §4 per-`(site, table)` chain under an advisory lock; the `17` §2 store table plus `gc`; the `17` §1 receipt table with vectors R-02 to R-08; `15` §2 pristine hydrate, credential copy, fresh check container, L1 isolation; `07` §1.1 fetch token; `clearances` plus one binding |
| M8 | Partially closed (D6) | `paths[]` in `H_spec` with a deterministic G2 guard is good. The flag-off gate depends on an SDK hook the architecture excludes. |
| M10 | Handed to Sentinel | Tag-based gate in `09` §1a. I haven't re-verified `security/06`. |
| M14 | Closed | ≈ 29.5 eng-weeks plus a 2-week reserve, every missing workstream added, a pullback table with costs |
| m1–m6, m8–m12 | Closed (D4 is a text conflict from m4) | |

Specific praise: the B2 fix is better than what I asked for. `cancel_run` as a no-transition
flag consumed at heartbeat (row 45) gives the owner a stop button without inventing a
"cancelling" state. Deriving the throttle count from `prechecks.requester_attributable` instead
of a counter removes both the window bug and the attribution bug in one move. And the `17` §2
store-by-store table is the right shape for ST-38: one row per store maps cleanly to one
assertion per store.

---

## Blocker

### D1. Events on a superseded PR end the live request
**Ref:** `07` §1.4 (`--fresh` pushes `soren-loop/<public_ref>-<n>`, the server opens a new PR
and **closes the old one**); `03` rows 25–26 (guard: "verified and deduped; the head repo is
the bot fork", with no PR-number check).
When the server closes the superseded PR, GitHub sends `pull_request.closed` (unmerged) for it.
Row 26 accepts it from `in_review`, so the request moves to `closed{pr_closed}` while its
replacement PR is open. That is a terminal state: the new PR's later `pr_merged` returns 409,
and enablement never happens. The mirror case is just as bad: if a human merges the stale PR on
GitHub before it is closed, row 25 records the wrong `merge_sha`. This happens on the normal
`--fresh` path.
**Fix:** add `pr_number = state_ctx.pr_number` to the guards on rows 24, 25 and 26. Record
every PR in a `request_prs(request_id, pr_number, head_branch, status: active|superseded)`
table. Webhooks for a superseded PR are recorded and acknowledged with no transition. A merge
of a superseded PR emits a locked-class owner alert, because unreviewed code may now be on the
default branch. Add ST-23 invariant 13: "no event on a non-active PR changes `requests.state`."

## Major

### D2. The deployment-matching model can't express one deploy containing many merges
**Ref:** `04` `deployments.request_id` ("nullable until matched"); `08` §2 ("for each stored
deployment, it calls compare"); `03` row 27.
A production deploy is per repo, not per request. One deployment satisfies every request whose
`merge_sha` it contains, but a single nullable `request_id` can match only one of them. The
evaluation also has two gaps:
- **On `merged` entry**, "each stored deployment" is unbounded. It means O(all deploys ever)
  compare calls against GitHub's rate limit.
- **On deploy arrival** while N requests sit in `merged`, the fan-out rule isn't stated.

**Fix:**
- Make `deployments` site-scoped with no `request_id`, and add
  `deployment_evaluations(deployment_id, request_id, compare_status, evaluated_at)`.
- On arrival, enqueue an evaluation for each request in `merged` at that site.
- On `merged` entry, evaluate only deployments with `received_at ≥ pr_merged_at − 10 min`,
  newest first, and stop at the first `ahead`/`identical`.
- Test with two requests merged before one deploy: both enable, one compare call each.

### D3. A rejected first submit has no deterministic path back
**Ref:** `03` rows 12 and 39–41; `07` §1.3 step 5 (fast-forward only; non-FF is exit 6) and
§1.4 (`--fresh` is defined for rework only); `18` §2 ("retry (build, no PR)" → `plan_approved`).
After `submit_rejected` or `pr_open_failed` on the **first** build, the fork branch already
holds the rejected commit. `retry` goes to `plan_approved`, and the next build exports
`base_sha` fresh. Its commit isn't a descendant of the pushed one, so the push is non-FF and
fails with exit 6, a hard block. The owner's only remaining action is `reject`. The same thing
happens when `gh.open_pr` went `dead` after GitHub had actually created the PR: the PR is open
but `rework_of` is null, so `retry` sends the request down the non-rework path.
**Fix:** use one branch per build run, `soren-loop/<public_ref>/<run_seq>`. Record
`runs.head_branch`, and have row 23 compare the head of *that* branch. FF-only then applies
within one rework chain, and `--fresh` becomes "new run, new branch" from any build-start
state. Base the row 12 routing on `request_prs` having an active PR (D1), not on `rework_of`.

### D4. `reject` or `withdraw` during `building{submitting}` races `gh.open_pr`
**Ref:** `03` rows 4 and 33 (P includes `building{submitting}`; the effect is `gh.close_pr`);
`04` §5 (workers claim with `SKIP LOCKED`, with no per-request ordering for non-notify
effects); invariant 12 ("without a queued `gh.close_pr`").
`gh.close_pr` can run before `gh.open_pr` finishes. It finds no PR and succeeds. `open_pr` then
creates one, and `pr_opened` hits `rejected`, which returns 409. The result is an orphaned agent
PR upstream, on a possibly public repo. Invariant 12 passes, because it checks only that a
close was *queued*.
**Fix:** serialize `gh.*` effects per request (an advisory lock on `request_id`, or
`next_attempt_at` ordering by `source_id`). `gh.open_pr` re-reads `requests.state` and aborts if
the state is terminal. `pr_opened` against a terminal state enqueues `gh.close_pr` and is
recorded with no transition, instead of returning 409. Change invariant 12 to "no PR remains
open after the effect queue drains."

### D5. A requester opt-out before enablement is overwritten
**Ref:** `03` row 43 (allowed from `merged` and `deployed`); §2 (`requester_opted_out` lives in
the **L** `state_ctx` only); row 27 and `16` §1 (`setTargets` computes "existing targets plus the
new `sub`").
A requester who opts out in `merged` has nowhere to store that fact, because `merged.state_ctx`
has no such field. Row 27 then adds their `sub` anyway. Row 43 is also a flag write with no
transition behind it, which contradicts SR-13's "writes happen only through outbox effects of
state transitions" and makes invariant 8 harder to state.
**Fix:** add a `requests.requester_opted_out` column, and have every `setTargets` computation
exclude it. Amend the SR-13 wording (Sentinel) to "outbox effects of state-machine events,
including no-transition events in the table." Add a test: opt out in `merged`, deploy, and the
`sub` is absent from the flagd document.

### D6. The flag-off gate needs an SDK hook the architecture excludes
**Ref:** `07` §1.3(d) (`SOREN_LOOP_FLAG_OVERRIDES`, honoured by `@sorenai/loop-node`/`-react` "in
test mode only"); `02` §3 (those packages do **not** own flag evaluation; host apps use stock
OpenFeature providers); decision 16 / SR-04(c) (no manifest changes).
Host code that evaluates through the stock OpenFeature client never sees this variable. Every
compliant PR would then fail the gate (fail-closed, so the loop is blocked), unless the host
routes evaluation through our SDK, which `02` says it doesn't. Separately, an environment
variable that rewrites flag values inside a production SDK is a flag bypass wherever "test
mode" is inferred, for example from `NODE_ENV`.
**Fix:** define the gate on OpenFeature's own `InMemoryProvider`, which ships in the SDK that is
already an onboarding prerequisite (Q14), so there's no new dependency. The CLI runs the owner's
test command with `SL_FLAG_FIXTURE=<path>`, read by a test-setup file that the owner adds once at
onboarding (checked by `doctor`). No production package reads it. Remove the override from the
`@sorenai/loop-node` and `-react` surface.

### D7. The owner can't decline enablement
**Ref:** `03` rows 25, 27 and 42 (`needs_confirm` → `deployed{awaiting_confirm}`, whose only
exit is `confirm_enablement`); P excludes post-merge states, so `reject` doesn't apply;
`kill_flag` is L-only.
`dashboard_confirm` and `merger_must_be_owner_login` exist so the owner can refuse enablement
when someone else merged. Right now the owner can only confirm, or leave the request in
`shipping` forever. Invariant 10 passes only because `confirm_enablement` reaches L.
**Fix:** add `decline_enablement` (owner session, no step-up, the safe direction) from
`merged{needs_confirm}` and `deployed{awaiting_confirm}` → `flag_off{previous: none}`, with an
`Rq:stage` event to `closed`. Also allow `kill_flag` from `deployed{queued}` (see m3).

## Minor

1. **Invariant 7 contradicts row 22.** Row 22 and `04` §5 allow `{replace: true}`, with
   `push_mints ≤ 2`, but invariant 7 forbids a second mint per `run_id`. Restate it as: "at most
   2 mints per run, only in `building{ready}`, and the first is revoked before the second is
   issued."
2. **P is defined by table order** ("`submitted` through `changes_requested`"), and
   `security_hold` sits inside that range only by position. Enumerate P explicitly in §2,
   because guards and ST-23 generators need a set, not a range.
3. **Invariant 9 has a gap.** A `setTargets` that applied at flagd but whose
   `flag_write_succeeded` hasn't been processed, or whose report went `dead`, leaves the flag
   live while the state is `deployed{queued}`, where `kill_flag` isn't allowed. Allow
   `kill_flag` from `deployed{queued}`.
4. *(Withdrawn. Sentinel's queued ruling, "count only flags with spans in requester text",
   covers this, and I agree with that direction.)*
5. **The rework fetch uses "a read-only push App token"** (`07` §1.4), but the push App holds
   `contents: write`. Specify the down-scoped mint (`permissions: {contents: read}`) and audit
   it like the fetch token in §1.1.
6. **Lease expiry has two sources again.** `timers.kind = lease_expiry` and
   `runs.lease_expires_at` both describe it. Make the timer a pointer that re-reads `runs` when
   it fires (a heartbeat extends `runs` only), and say so in `04` `timers`.

## Sentinel's Queued Rulings (not re-flagged)

I checked the direction of each one. L1 in the sealed container only, the SR-02 read-only
dependency layer and credential handling, the throttle spans rule, the gate at ST-01–72 except
ST-24, the `09` rows for SR-35–41, and SR-41 (pinning the PR `head_sha`) all look right to me.
SR-41 complements D1 but doesn't replace it: an *unmerged* close of a superseded PR still needs
the `pr_number` guard.

One condition, not an objection: if SR-37 chains only `request_transitions` and `audit_events`,
then every write to `approvals`, `clearances`, `trusted_commits` and `notification_policies`
must also emit an `audit_events` row carrying that row's digest. Otherwise a DB writer could
silently delete a clearance or roll back a trusted-commit pointer. `04` §4 should state that
rule when Arendt narrows the chained-table list.

## What I Did Not Re-Verify

- `security/06` (the M10 gate, the SR-02/SR-13/SR-26e text, numbered STs), which is with
  Sentinel.
- `05` and `16`, apart from the parts cited above.
- `14`, beyond the row-count rule.
- Whether the ≈ 29.5 figure now covers D1–D7. My estimate is +0.5 eng-weeks, mostly D2 and D3.

---

## Round 3: D1–D7 Verified by Diff (2026-10-31)

Checked: `03` rows 4, 12, 22–31, 33, 38–48, §2 P, §6 invariants 7–14; `04` `requests`, `runs`,
`request_prs`, `deployments`, `deployment_evaluations`, `timers`, §4, §5; `07` §1.3(d), §1.4;
`08` §2.

| Finding | Status | Evidence |
|---------|--------|----------|
| D1 | **Closed** | `request_prs` with a partial unique index on `active`; a `pr_number` guard on rows 24–26; row 46; invariant 13 |
| D2 | **Closed** | Site-scoped `deployments` plus `deployment_evaluations`; arrival fan-out, and a bounded newest-first rule on `merged` entry (`08` §2); row 27 keys on the evaluation |
| D3 | **Closed** | Chains `soren-loop/<public_ref>/<chain>`; `runs.expected_head`; row 12 routes on the active PR; `--fresh` from every build-start state |
| D4 | **Closed** (minor R3 below) | Per-request `gh.*` serialization; the `open_pr` state re-read; terminal handling on row 40; invariant 12 checks the drained queue |
| D5 | **Closed** | `requests.requester_opted_out`; the exclusion on rows 27 and 43; invariant 14 |
| D6 | **Closed** (major R2 below) | `InMemoryProvider` plus `SL_FLAG_FIXTURE`; the SDK override is removed |
| D7 | **Closed** (minor R4 below) | Row 48; row 31 restores from `none`; row 30 is allowed from `deployed{queued}` |
| Minors 1–3, 5–6 | **Closed** | Invariant 7; P enumerated; row 30; the `{contents: read}` down-scope; the lease timer is a pointer |
| SR-37 condition | **Met, and exceeded** | `04` §4: all six tables are chained directly, and every other category is an `audit_events` row in the same transaction with the row's digest |

### New in round 3: 2 major, 3 minor

**R1 (major). Row 25's SR-41 merge guard fails on squash and rebase merges.** "The merge
commit's parent head equals the pinned `head_sha`" only holds for a merge commit. A squash
commit's only parent is the base branch, and a rebase merge rewrites the SHAs. `07` §1.3 notes
that owners' repos usually squash. In those repos every legitimate `pr_merged` fails the guard,
and the request stays in `in_review` after the merge. SR-41's direction ("the merge head must
equal the active PR's pin") is right. Only the RFC's mechanism is wrong.
**Fix:** compare `pull_request.head.sha` from the verified `closed`+`merged` payload with
`request_prs.pinned_head_sha`. Record `merge_commit_sha` separately as `merge_sha` for the
deploy compare. Add a test for each of merge, squash and rebase.

**R2 (major). The flag-off gate's setup file is agent-writable.** The onboarding test-setup file
that installs the `InMemoryProvider` lives in the repo. It isn't on the SR-04 deny-list, so a
compromised build agent can edit it to ignore `SL_FLAG_FIXTURE`. The gate then passes with the
flag never forced off. That defeats SR-04(d) and the G-5 check, under the RFC's own A6
assumption.
**Fix:** record the setup file's path at onboarding (in the site config, +SU), add it to the
SR-04(a) hard-block list (with Sentinel), and have `doctor` check that its hash matches the one
recorded at onboarding.

**Minor R3.** Row 40 handles `pr_opened` "if the state has become terminal", but its `From` is
`building{submitting}`. Under the "any pair not in the table → 409" rule, that event on
`rejected` or `closed` is a 409. Add an explicit row with From `rejected` or
`closed{withdrawn}`, event `pr_opened`, no transition, and effect `gh.close_pr`, so the table
stays the single source of truth. Also hash the key: `pg_advisory_xact_lock(request_id)` needs
`hashtextextended(request_id, 0)`, because the ID is text. And don't hold the transaction open
across GitHub calls: take the lock, mark the row `running`, commit, then call GitHub.

**Minor R4.** Row 31 restores `previous: none` to `deployed{queued}` even when the decline
happened in `merged{needs_confirm}`, before any deploy was verified. The requester would see
`available` before the code ships. **Fix:** restore to `merged` (with `needs_confirm = false`)
when no `deployment_evaluations` row matched, and to `deployed{queued}` otherwise.

**Minor R5.** Row 23 has a new chain supersede the old active PR, and row 40 inserts the new
`request_prs{active}` row. The two writes must happen in one transaction, superseding the old
row first, or the partial unique index rejects the insert. Say so in row 40's effects.

### Round 3 verdict

**Ready for task breakdown once R1 and R2 are applied.** Both are wording changes to a single
guard and the deny-list, with no new state. They need no further Zod pass. A spot-check of row
25 and SR-04(a) is enough. R3 to R5 can land during breakdown as task acceptance criteria.

## Round 4: Spot-Check of R1 to R5 (2026-10-31)

| Finding | Status | Evidence |
|---------|--------|----------|
| R1 | **Closed** | `03` row 25 guards on `pull_request.head.sha = request_prs.pinned_head_sha`; `merge_commit_sha` is used only for the deploy compare; tests for merge, squash and rebase |
| R2 | **Closed** | `flag_fixture_path` is site config with +SU (`05` §1.2); it's in the SR-04(a) enumeration in both `07` §1.3 and `security/06`; its blob hash is checked against base in the fresh container; ST-77 |
| R3 | **Closed** | Row 49 (`rejected`/`closed` + `pr_opened`, no transition); `hashtextextended` is used; the GitHub call runs outside the transaction through `effect_claims` |
| R4, R5 | **Closed** | Row 31 picks the restore target by whether an evaluation matched; row 40 supersedes then inserts in one transaction |

One acceptance criterion for the outbox task (not a finding): the `effect_claims` lease must be
longer than the GitHub client's hard timeout, and a worker must re-check that it still holds
the claim before reporting the effect's outcome. Otherwise a slow `gh.open_pr` could be
overtaken by a `gh.close_pr` after its lease expires. List `effect_claims` in the `04` §2 table.

**Final verdict: ready for task breakdown.** No further Zod pass is needed on this RFC.
