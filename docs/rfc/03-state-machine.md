# 03. The Request State Machine

The request is a long-lived aggregate with five external actors. The transition map is data: a
table of `(from, event, guard, to, effects, events)` in `apps/server`. One function applies a
transition inside one Postgres transaction. It checks `version`, evaluates the guard, writes the
new state and `state_ctx`, appends to `request_transitions` (chained, `04` §4), and inserts the
outbox rows. Inside that same transaction it also resolves the notification events (`14` §1).
Nothing else writes `requests.state` (ST-23).

## 1. Principles

1. **Model output can stop a request, never advance it** (SR-18). A run that ends badly moves
   the request to `stalled`. Every forward move comes from a deterministic check, an owner
   action, or a verified external event.
2. **Holds return to where they came from**, and every later gate still applies. A clearance
   binds one `content_hash` and one `l2_fingerprint` (`sl:hold_clear:v1`).
3. **Requester stages are a projection** (§5). Requester events fire only when the stage
   changes.
4. **CLI events are claims about the owner's machine.** They're accepted only under guards the
   server can check: token scope, the `runs` lease, hash equality, pre-check records (ST-34),
   and GitHub state read with the Apps' own tokens. A modified CLI can still lie about local
   facts (PC7, accepted).
5. **Every non-terminal state has an owner exit, and every live flag stays killable** (Zod B2,
   B3; invariants 9 and 10).

## 2. States

`state_ctx` never holds lease data. `runs` is the lease authority (Zod m11).

| State | Kind | Meaning | `state_ctx` |
|-------|------|---------|-------------|
| `intake` | Pre-request | LLM-mode chat draft only | `session_id`, turns |
| `submitted` | Waiting (owner) | Revision `r` stored, PC-S done | `rev`, `h_req` |
| `security_hold` | Waiting (owner) | A pre-check flagged, or couldn't run | `checkpoint`, `reason` (`flagged`/`precheck_unavailable`), `verdict_id`, `content_hash`, `l2_fingerprint`, `return_to` |
| `owner_approved` | Waiting (CLI) | G1 passed for `sl:g1:v1(h_req, eligibility_class)` | `h_req`, `approval_id` |
| `planning` | Running (CLI) | Plan lease held (`runs`) | `run_id`, `base_sha` |
| `plan_review` | Waiting (owner) | Spec and a clean or cleared PC-B record present | `spec_id`, `h_spec` |
| `plan_feedback` | Waiting (CLI) | Feedback recorded; re-plan next | `feedback_id` |
| `needs_info` | Waiting | `from: owner` or `from: requester` | `from`, `question_id` |
| `plan_approved` | Waiting (CLI) | G2 passed for `h_spec` | `h_spec`, `approval_id` |
| `building` | Running / ready / submitting | `running`: lease held. `ready`: deterministic checks passed. `submitting`: pushed; the server re-check and PR open are in flight. | `sub`, `run_id`, `head_branch` (`soren-loop/<public_ref>/<chain>`), `base_sha`, `rework_of`, `head_sha` |
| `paused_rate_limited` | Waiting (CLI) | The CLI saw a rate limit from the process | `resume_to`, `resets_at`, `run_id`, plus the `stalled` context fields |
| `stalled` | Waiting (owner) | A run or submit ended without deterministic success | `phase`, `reason`, `advisory` (untrusted), **`feedback_id`, `rework_of`, `pr_number`** (preserved, Zod B5) |
| `in_review` | Waiting (GitHub) | The active PR (`request_prs`) is open; its head is pinned (SR-41) | `pr_number`, `head_sha` |
| `changes_requested` | Waiting (CLI) | Rework feedback approved with +SU | `feedback_id`, `pr_number` |
| `merged` | Waiting (deploy) | The active PR merged upstream | `merge_sha`, `merged_at`, `needs_confirm` |
| `deployed` | `queued` / `awaiting_confirm` | A verified deploy contains `merge_sha` | `deployment_id` |
| `enabled_for_requester`, `rollout_targeted`, `rollout_percentage` (Phase 2), `rollout_all` | **Live** (the set L) | The flag is on for the requester, a list, a share, or everyone | `flag_id`, `archived` (opt-out is the `requests.requester_opted_out` column, Zod D5) |
| `flag_off` | Killed, or declined | Reversible | `previous` (an L state, or `none` after `decline_enablement`) |
| `matched_existing` | Waiting (Phase 2+) | The matcher picked a self-serve flag | `flag_id`, `needs_owner_confirm` |
| `rejected` | Terminal | Owner rejected | `reason` (owner-only) |
| `closed` | Terminal | `withdrawn`, `no_response`, `pr_closed` | `reason` |

**P** (pre-merge, enumerated, Zod m2) = {`submitted`, `security_hold`, `owner_approved`,
`planning`, `plan_review`, `plan_feedback`, `needs_info`, `plan_approved`, `building`,
`paused_rate_limited`, `stalled`, `in_review`, `changes_requested`, `matched_existing`}.
**L** = {`enabled_for_requester`, `rollout_targeted`, `rollout_percentage`, `rollout_all`}.
`retire` doesn't leave L. It sets `archived`, and `kill_flag` stays available (Zod M5, ST-76).

**Active PR (Zod D1).** `request_prs` records every PR, each one `active` or `superseded`, and a
request has at most one active PR. Rows 24–26, 40 and 46–47 act only on the active PR's
`pr_number`. Events for a superseded PR are recorded and acknowledged without a transition
(row 46).

## 3. Transition Table

Actors: **Rq** requester, **Ow** owner (+SU = a step-up per SR-35, action and content hash per
`04` §3.4), **CLI** the CLI on behalf of the owner, **GH** a verified webhook, **Sys** a worker
or timer. In the Events column, `Rq:stage` means `requester.stage_entered`, and it fires only if
the §5 projection changes. Owner kinds drop the `owner.` prefix, and a **bold** kind is locked
(`14` §2.1). Every hold entry emits **security_hold_entered** for `flagged`, or
**precheck_unavailable** for `precheck_unavailable`. That's one kind per reason (Zod M4).

| # | From | Event | Guard | To | Effects | Events | Actor |
|---|------|-------|-------|----|---------|--------|-------|
| 1 | — / `intake` | `submit` | Session for `(site, sub)`; closed `sl.request.v1`; SR-11 caps; intake not paused. **If the requester is paused, set `throttled`** (shadow-accept). | `submitted`, or a hold `{PC-S}` | Rev 1, `h_req`; L3 inline; PC-I queued (LLM mode, not throttled); matcher (Phase 2+, not throttled) | `Rq:stage`; `request_submitted` (not if throttled); a hold kind | Rq |
| 2 | `submitted` | `precheck_result{PC-I}` | Record for the current `h_req` | Same, or a hold `{PC-I}` | Store the record | A hold kind | Sys |
| 3 | `submitted` | `approve_request` (G1) | +SU `request.approve` over `sl:g1:v1(h_req, class)`; PC-S record (and PC-I in LLM mode) for `h_req`; class ∈ site classes | `owner_approved` | Receipt; set `eligibility_class`; mint `sl_` **only if `flag_id` is null** (Zod m2); `ensureFlag(off)`; issue projection with `public_ref` | `Rq:stage` | Ow |
| 4 | Any state in **P** | `reject` | Owner session; `If-Match` version (Postel M2) | `rejected` | Revoke the active run's lease and any push token; `gh.close_pr` for every open PR; close the projection; purge timer. `gh.*` effects are serialized per request (Zod D4). | `Rq:stage` | Ow |
| 5 | `owner_approved`, `plan_feedback` | `precheck_reported{PC-A}` | CLI token; record over `h_req` (+ `h_fb`) and `base_sha` | Same, or a hold `{PC-A}` | Store the record | A hold kind | CLI |
| 6 | `owner_approved`, `plan_feedback` | `start_plan` | CLI-sent `h_req` = the server's; clean or cleared PC-A for `(h_req, base_sha)`; no live lease | `planning` | `runs` row with a lease (`05` §1.4) | — | CLI |
| 7 | `planning` | `plan_uploaded` | Lease holder; the envelope `{body_md, paths[]}` is schema-valid and size-capped; `parent = h_req`; a PC-B record over `(h_req, h_spec)` | `plan_review`, or a hold `{PC-B, return_to: plan_review}` | Store the spec; review aids | `plan_ready`, or a hold kind | CLI |
| 8 | `planning`, `building{running}` | `rate_limited{resets_at?}` | Lease holder; detected from the process, or owner-declared in interactive mode | `paused_rate_limited` | End the run; keep the context | `rate_limited` | CLI |
| 9 | `paused_rate_limited` | `resume` | CLI token; same tree; PC-C L2 re-run for builds | `resume_to` | New lease | — | CLI |
| 10 | `planning`, `building{running}` | `run_stopped{reason}` | Lease holder, or `Sys` on lease expiry; `reason` ∈ `process_error`, `timeout`, `checks_failed`, `lease_lost`, `cancelled`, `outcome_blocked`, `outcome_needs_info` | `stalled` (context preserved) | End the run | `run_stalled` | CLI / Sys |
| 11 | `building{running}` | `build_checks_passed` | Lease holder; fresh-container check results attached (`15` §2) | `building{ready}` | End the run | — | CLI |
| 12 | `stalled` | `retry` | Owner session | Plan phase: `plan_feedback` if `feedback_id` is set, else `owner_approved`. Build phase: `changes_requested` if **`request_prs` has an active open PR**, else `plan_approved` (Zod D3). | — | — | Ow |
| 13 | `plan_review`, `stalled{phase: plan}` | `ask_requester{question}` | Owner text ≤ 500 chars, SR-06; **no PR open** | `needs_info{requester}` | Deadline timer (14 d) | `Rq:stage` | Ow |
| 14 | `plan_review`, `stalled` (no PR open) | `park_for_owner_context` | Owner session | `needs_info{owner}` | — | — | Ow |
| 15 | `needs_info{requester}` | `requester_reply` | Same `(site, sub)`; caps | `submitted` (rev `r+1`), or a hold `{PC-S}` | New `h_req`; L3 inline | `Rq:stage` | Rq |
| 16 | `needs_info{owner}` | `add_owner_context` (G1′) | +SU `request.approve` over `sl:g1:v1(h_req', class)` | `owner_approved` | An `owner_context` revision; receipt | — | Ow |
| 17 | `needs_info{requester}` | `info_timeout` | The timer fires | `closed{no_response}` | Purge timer | `Rq:stage` | Sys |
| 18 | `plan_review` | `approve_spec` (G2) | +SU `spec.approve` over `h_spec`; `parent` = the current `h_req`; PC-B clean or cleared; **every `paths[]` entry matches the site's confirmed allow globs and none hits the SR-04 deny-list** (deterministic, Zod M8) | `plan_approved` | Receipt | — | Ow |
| 19 | `plan_review` | `send_plan_feedback` | Owner text; size cap | `plan_feedback` | `feedback` with `h_fb` | — | Ow |
| 20 | `plan_approved`, `changes_requested` | `precheck_reported{PC-C}` | The record cites the PC-B record for `h_spec`; L2 over the actual base | Same, or a hold `{PC-C}` | Store the record | A hold kind | CLI |
| 21 | `plan_approved`, `changes_requested` | `start_build` | CLI-sent `h_spec` = the server's; PC-C for this `base_sha`; **the server checks `sites.path_policy` is confirmed** (Zod m3); from `changes_requested`, the CLI has verified the rework receipt | `building{running}` | A `runs` row (`tree_source` = `pr_head` for rework) | — | CLI |
| 22 | `building{ready}` | `mint_push_token{head_sha}` (no transition) | `h_spec` matches; the CLI declares the commit `head_sha` it will push (stored as `runs.expected_head`, SR-41); PC-B and PC-C records present (SR-26h); first mint for this run, or `{replace: true}` with `push_mints < 2`, and the prior token is revoked first (SR-09) | — | Push App token, fork only; non-201 = hard error (F3); audit | — | CLI |
| 23 | `building{ready}` | `submit{head_sha}` | The head of **this run's branch**, read with the push App, equals `head_sha`, which was declared at mint time (Zod D3, m4). Branches: a build from base (the first build, `retry` without an active PR, `--fresh`) starts a new chain `soren-loop/<public_ref>/<chain>`; a rework run fast-forwards its chain's branch. | `building{submitting}` | `gh.open_pr`: re-read `requests.state` and abort unless it's `building{submitting}` (Zod D4); compare re-check of the cumulative diff (SR-04 server rules). A new chain **opens** a PR (`maintainer_can_modify: false`) and supersedes any previously active PR (`gh.close_pr`, revoke its tokens). A rework run **updates** the active PR. Either way, **pin `head_sha`** (SR-41). `expected_head` is **consumed at pin**, after the SR-04 re-check (ST-78). | — | CLI |
| 24 | `in_review` | `owner_feedback` | **`pr_number` = `state_ctx.pr_number`** (the active PR, Zod D1); +SU `rework.approve` over `sl:rework:v1(h_spec, h_fb)` (Zod B5, ST-74). A GitHub `changes_requested` review by the owner login creates a **pending** feedback row and an inbox item, but this transition needs the +SU (T23). | `changes_requested` | Store feedback and receipt | — | Ow |
| 25 | `in_review`, `changes_requested` | `pr_merged` | Verified and deduped; **`pr_number` = `state_ctx.pr_number`** (the active PR in `request_prs`, Zod D1); the webhook's **`pull_request.head.sha` equals `request_prs.pinned_head_sha`** (SR-41). This works for merge, squash, and rebase merges alike, and `merge_commit_sha` is kept only for the deploy compare (Zod R1). Integration tests cover a merge commit, a squash, and a rebase merge. | `merged` (`needs_confirm` = `enablement_mode` is `dashboard_confirm`, or the merger ≠ the owner login under `merger_must_be_owner_login`) | Record `merge_sha`, `merged_at`; deploy-wait timer (7 d); **enqueue `evaluate_deployments`** for this request (`08` §2, Zod D2) | `Rq:stage` | GH |
| 26 | `in_review`, `changes_requested` | `pr_closed_unmerged` | Verified and deduped; **`pr_number` = `state_ctx.pr_number`** (the active PR, Zod D1). A superseded PR closed without merging is row 46: recorded, no transition. | `closed{pr_closed}` | Purge timer | `Rq:stage` | GH |
| 27 | `merged` | `deployment_succeeded{deployment_id}` | A `deployment_evaluations` row for (this deployment, this request) has `compare_status` `ahead` or `identical` (`08` §2). Sources: GH, `evaluate_deployments` (Sys), the deploy webhook, `mark-deployed` (CLI, audited). | `deployed{queued}`, or `deployed{awaiting_confirm}` if `needs_confirm` | `setTargets` (when queued), computed **excluding** the `sub` if `requests.requester_opted_out` (Zod D5) | `enablement_confirm_needed` (when awaiting) | GH / Sys / CLI |
| 28 | `deployed{queued}`, `matched_existing` | `flag_write_succeeded` | The effect ID matches | `enabled_for_requester` | SR-23 probe | `Rq:stage`; `flag_enabled` | Sys |
| 29 | L | `widen_rollout` | +SU `rollout.widen` over `sl:rollout:v1` (with `doc_version`) | `rollout_targeted` / `rollout_percentage` / `rollout_all` | `FlagWriter` with `{version}` | — | Ow |
| 30 | L, `deployed{queued}` | `kill_flag` | Owner session (the safe direction). Allowed from `deployed{queued}` because the flag may already be live at flagd (Zod m3). | `flag_off{previous}` | `disable` | `Rq:stage` | Ow |
| 31 | `flag_off` | `restore_flag` | +SU `flag.restore` | `previous`. When `previous` is `none`: `deployed{queued}` if a deployment evaluation matched, else **`merged`**, which re-runs `evaluate_deployments` (Zod R4) | Replay, or `setTargets` | `Rq:stage` | Ow |
| 32 | `rollout_all` | `retire` (no transition) | Owner session | — | `archived = true`; the dashboard hides it from the live list | — | Ow |
| 33 | Any state in **P** | `withdraw` | Same `(site, sub)` | `closed{withdrawn}` | Revoke the lease and any push token; `gh.close_pr` for every open PR (serialized, Zod D4); purge timer | `Rq:stage` | Rq |
| 34 | `security_hold{flagged}` | `clear_hold` | +SU `hold.clear` over `sl:hold_clear:v1(request_id, verdict_id, content_hash, l2_fingerprint)` (Zod M15); no bulk | `return_to` | A `clearances` row | — | Ow |
| 35 | `security_hold{precheck_unavailable}` | `retry_precheck` | Owner session; Clear isn't offered | `return_to` (record invalidated; PC-I re-queued; PC-A/B/C re-run by the next CLI command, **PC-B by `plan <id> --recheck`**, Zod M2) | — | — | Ow |
| 36, 37 | `submitted` / `matched_existing` | `match_found` / `confirm_match` (Phase 2+) | Self-serve enum (SR-32) / +SU | `matched_existing` / same | `setTargets` | — | Sys / Ow |
| 38 | Any state | `retry_effect{outbox_id}` (no transition) | The row is `dead`; owner session | — | Reset attempts; audit row (Zod B2d) | — | Ow |
| 39 | `building{submitting}` | `submit_rejected{reason}` | Reported by `gh.open_pr` (re-check failed) | `stalled{build}`; the next run may re-mint under row 22 | — | `run_stalled` | Sys |
| 40 | `building{submitting}` | `pr_opened{pr_number}` | Reported by `gh.open_pr` | `in_review` | In **one transaction**: mark the prior active `request_prs` row `superseded`, **then** insert the new `active` row, so the partial unique index never rejects it (Zod R5); label | `pr_opened` | Sys |
| 41 | `building{submitting}` | `pr_open_failed` | `gh.open_pr` went `dead` | `stalled{build}` | — | `run_stalled` | Sys |
| 42 | `deployed{awaiting_confirm}` | `confirm_enablement` | +SU `enablement.confirm` over `sl:enable_confirm:v1` | `deployed{queued}` | `setTargets` | — | Ow |
| 43 | `merged`, `deployed`, L, `flag_off` | `requester_opt_out` (no transition) | Same `(site, sub)`; removes **only the caller's own session `sub`** (ST-76) | — | Set `requests.requester_opted_out`; `setTargets` without the `sub` (an outbox effect of a table event, SR-13) | — | Rq |
| 44 | `plan_review` | `precheck_reported{PC-B}` | `plan --recheck`; record over `(h_req, h_spec)` | Same, or a hold `{PC-B}` | Replace the record | A hold kind | CLI |
| 45 | `planning`, `building{running}` | `cancel_run` (no transition) | Owner session | — | `runs.cancel_requested`; the next heartbeat returns it, and the CLI ends with row 10 `cancelled` | — | Ow |
| 46 | Any state | `pr_event{superseded}` (no transition) | The event's `pr_number` is a **superseded** PR | — | Record it. If it's a **merge** of a superseded PR, emit the locked alert: unreviewed code may now be on the default branch (Zod D1). | **pr_head_changed** (`reason: superseded_pr_merged`) on merge | GH |
| 47 | `in_review`, `changes_requested`, `building` (with an active PR) | `pr_head_changed` | A `synchronize` event on the active PR, or a fork head, that is neither the pinned `head_sha` nor an **unconsumed** `expected_head` of this request's run in `building{ready, submitting}`. `expected_head` is consumed at pin (row 23), and a `replace` mint overwrites it. Any `synchronize` after the pin is tampering, even one that matches an old `expected_head` (SR-41, ST-78). | `stalled{build, reason: head_tampered}` | Add the `soren-loop:do-not-merge` label; revoke push tokens | **pr_head_changed** | GH / Sys |
| 48 | `merged{needs_confirm}`, `deployed{awaiting_confirm}` | `decline_enablement` | Owner session (the safe direction, Zod D7) | `flag_off{previous: none}` | — | `Rq:stage` | Ow |
| 49 | `rejected`, `closed` | `pr_opened{pr_number}` (no transition) | Reported by `gh.open_pr` after a `reject` or `withdraw` raced the open (Zod D4, R3) | — | Insert `request_prs{closed}`; enqueue `gh.close_pr` | — | Sys |

Any `(from, event)` pair not in the table returns `409 invalid_transition` with
`allowed_actions` (`05` §2) and writes nothing. **Timers** (`04` `timers`) fire as `Sys` events
and resolve notifications at fire time. `deploy_wait` emits `deploy_wait_exceeded` with no
transition. `lease_expiry` drives row 10.

**Throttle (A23-8; SR-26i, PC10, ST-66).** The count is derived from `prechecks` rows with
`requester_attributable = true` within a rolling 24 h. A row is attributable only if it is
`flagged` by L1 or L3 **with at least one verified span inside a requester-supplied field**.
Spanless L1 flags, spans only in owner-authored fields, L2 hits, `precheck_unavailable`, and
owner-cleared holds never count (Zod m4). At the site threshold (default 3), the
requester is paused. A pause is **shadow-accept** (SR-40b). Submissions are stored as `received`
and marked `throttled`. They're grouped in the owner queue (bulk reject is available), count
toward the SR-11 caps, and emit only one `requester_throttled` notice. They run PC-S but skip
PC-I and the matcher (AB1, LLM10). Un-throttling a submission triggers PC-I, through row 3's
guard. Intake chat is unchanged. A repo `CLAUDE.md` change or a classifier outage never counts
against a requester.

**Clearances and L2 at build start.** PC-C re-runs L2 against the real base. A clearance
covers the exact `(content_hash, l2_fingerprint)`. The same diff doesn't re-hold, and a new diff
does (ST-31, ST-40).

## 4. Diagrams

The lifecycle and overlay diagrams are in `18-state-diagrams.md` (moved to keep this file under
300 lines).

## 5. Requester-Visible Stage Mapping

| Requester stage | Internal states | Notes |
|-----------------|-----------------|-------|
| `received` | `submitted`, `matched_existing`, `security_hold` with `return_to: submitted` | A match stays hidden until enabled (T12.3) |
| `needs_your_input` | `needs_info{from: requester}` | The only stage that carries text: the owner-authored question |
| `planning` | `owner_approved`, `planning`, `plan_review`, `plan_feedback`, `needs_info{from: owner}`, `plan_approved`, `paused_rate_limited{resume_to: planning}`, `stalled{phase: plan}`, `security_hold` with `return_to` ∈ {`owner_approved`, `plan_feedback`, `plan_review`, `plan_approved`} | PC-A, PC-B, and PC-C holds all sit inside this stage |
| `building` | `building{running, ready, submitting}`, `paused_rate_limited{resume_to: building}`, `stalled{phase: build}`, `in_review`, `changes_requested`, `security_hold{return_to: changes_requested}` | |
| `shipping` | `merged`, `deployed{queued, awaiting_confirm}` | An owner confirmation wait looks like a deploy wait |
| `available` | L, including `archived` | The requester stays targeted through widening. An opt-out changes no stage. |
| `closed` | `rejected`, `closed{withdrawn, no_response, pr_closed}`, `flag_off` | A rejection after a hold looks like any other rejection. A shipped feature never shows `closed` (Zod M5). |

Rules that make a hold indistinguishable (A23-5, ST-33):

- Requester events are emitted **only on a change of requester stage**. The brief's "every
  transition emits a coarse status event" is implemented as "every transition is evaluated,
  and an event is emitted when the projected stage changes" (`13` T1). Pushed notifications follow the same rule ([`14`](14-notifications.md)).
- The feed exposes `stage` and `stage_since`. `stage_since` is rounded to the hour by default
  (T12.2), so time spent in a hold and time spent waiting on the owner look the same.
- No requester notification is ever sent on entering or leaving a hold. The notification policy
  enforces this by construction: it only sees requester-stage changes (`14` §3).
- Every PC-C hold happens before `building`, so it never pulls a request back out of the
  `building` stage. PC-C on rework (`changes_requested`) holds inside `building`, where the
  request already is.

`flag_off` maps to `closed` rather than inventing a "paused" stage. A requester whose feature
disappears gets a clear signal, and the owner decides the copy (decision 29, Q9).

## 6. Invariants (ST-23 property tests)

Random event sequences over the table, run against a real Postgres in CI, must never:

1. reach a state not in §2;
2. reach `building` without G1 for the current `h_req`, G2 for an `h_spec` whose parent is that
   `h_req`, and a PC-C record for the exact `(h_spec, base_sha)`;
3. leave `security_hold` toward any state except through `clear_hold` (+SU), `retry_precheck`
   (for `precheck_unavailable` only), or `reject`;
4. let one clearance cover a different `content_hash` or `l2_fingerprint`;
5. advance on any event whose only evidence is model output (`stalled` is the only state a
   model-reported status can lead to);
6. emit a requester event for a transition that doesn't change the requester stage;
7. mint more than 2 push tokens for one run, mint outside `building{ready}`, or issue a second
   token before the first is revoked (Zod m1);
8. enable a flag for anyone but the request's `sub` without a +SU `widen_rollout` row;
9. reach a state where the flag is enabled and `kill_flag` (or `reject`) is unavailable (every
   live flag stays killable, Zod B3);
10. leave a non-terminal state with no owner-initiated event that reaches a terminal or live
    state (liveness, Zod B2e);
11. deliver requester notify rows for one request out of `source_id` order (Zod M4);
12. leave any PR open once the request's effect queue drains after `rejected` or
    `closed{withdrawn}` (Zod B3, D4);
13. change `requests.state` on an event for a non-active PR (Zod D1);
14. write a flag that includes an opted-out requester's `sub` (Zod D5).

Concurrency: every transition is `UPDATE ... WHERE id = $1 AND version = $2`. A losing writer
gets `409 version_conflict` with `suggested_action: refetch_and_retry`. A stale `If-Match` on an
owner action returns `412` (Postel M2). Webhooks and CLI retries carry
idempotency keys (`05` §3), so a retried event is a no-op instead of a second transition.
