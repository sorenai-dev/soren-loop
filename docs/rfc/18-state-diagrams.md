# 18. State Machine Diagrams

These diagrams illustrate the table in `03` §3. They aren't normative: where they differ, the
table wins. The `reject` edges from every state in P, and the `withdraw` edges to `closed`, are
left out to keep the diagrams readable (`03` rows 4 and 33).

## 1. Main Lifecycle

```mermaid
stateDiagram-v2
  [*] --> submitted: submit (PC-S)
  submitted --> owner_approved: G1 +SU
  submitted --> matched_existing: match_found (Phase 2+)
  owner_approved --> planning: start_plan (PC-A)
  planning --> plan_review: plan_uploaded (PC-B)
  plan_review --> plan_feedback: send_plan_feedback
  plan_feedback --> planning: start_plan (PC-A)
  plan_review --> plan_approved: G2 +SU
  plan_review --> needs_info: ask / park
  needs_info --> submitted: requester_reply (rev r+1)
  needs_info --> owner_approved: add_owner_context +SU
  plan_approved --> building: start_build (PC-C)
  building --> submitting: submit (head verified)
  submitting --> in_review: pr_opened
  in_review --> changes_requested: owner_feedback +SU
  changes_requested --> building: start_build (PC-C, PR head)
  in_review --> merged: pr_merged
  in_review --> closed: pr_closed_unmerged
  merged --> deployed: deployment verified
  deployed --> awaiting_confirm: needs_confirm
  awaiting_confirm --> deployed: confirm_enablement +SU
  awaiting_confirm --> flag_off: decline_enablement
  deployed --> flag_off: kill (queued)
  deployed --> live: flag write ok
  matched_existing --> live: flag write ok
  live --> live: widen +SU / retire (archive)
  live --> flag_off: kill
  flag_off --> live: restore +SU
```

`building`, `submitting`, `deployed`, and `awaiting_confirm` are sub-states (`03` §2). `live`
stands for the set L.

## 2. Holds, Pauses, Stalls

```mermaid
stateDiagram-v2
  state "security_hold" as H
  state "paused_rate_limited" as P
  submitted --> H: PC-S / PC-I
  owner_approved --> H: PC-A
  plan_feedback --> H: PC-A
  planning --> H: PC-B (return_to plan_review)
  plan_review --> H: PC-B recheck
  plan_approved --> H: PC-C
  changes_requested --> H: PC-C
  H --> submitted: clear +SU / retry
  H --> owner_approved: clear +SU / retry
  H --> plan_feedback: clear +SU / retry
  H --> plan_review: clear +SU / retry
  H --> plan_approved: clear +SU / retry
  H --> changes_requested: clear +SU / retry
  H --> rejected: reject
  planning --> P: rate_limited
  building --> P: rate_limited
  P --> planning: resume
  P --> building: resume
  planning --> stalled: run_stopped
  building --> stalled: run_stopped
  submitting --> stalled: submit_rejected / pr_open_failed
  in_review --> stalled: pr_head_changed (SR-41)
  stalled --> owner_approved: retry (plan, no feedback)
  stalled --> plan_feedback: retry (plan, feedback)
  stalled --> plan_approved: retry (build, no active PR)
  stalled --> changes_requested: retry (build, active PR)
  stalled --> needs_info: ask / park (no PR)
  stalled --> rejected: reject
```
