# Postel Delta Re-Review: soren-loop RFC

**Reviewer:** Postel (contract layer). **Date:** 2026-10-31. **Against:** `postel-review.md`
(4 blocker, 9 major, 7 minor), the fix map at `13` §5.

**Scope:**
- `04` §3 (hashing) and §5 (idempotency)
- `05`
- `07` §1–2
- `16` §1 and §5
- `08` §2.1
- `06` §1.1

## Verdict

**Ready for task breakdown.** The fixes close all 20 original findings. Two still wait on
Sentinel (B2 replacement cap, M5 `aud`/leeway), and one waits on S4 (M6). The RFC now names
those dependencies explicitly.

The delta adds **4 major and 8 minor** findings, and no blockers. D-M1 and D-M2 change
`loop-schema/hash`, so they must land before Ada writes the canonical vectors (the first red
batch). The other findings can be carried as acceptance criteria.

**Confidence:** High.

## Original Findings: Status

| ID | Status | Note |
|----|--------|------|
| B1 | Closed | `05` §2 is exactly the proposed problem+json, with `current_state` added. Good addition. |
| B2 | Closed (Sentinel pending) | `04` §5 table; `07` §2.4. Releasing the lock on `412` is right. See d2 for one wording gap. |
| B3 | Closed | `04` §3 is now byte-level. The prefix registry, `sl:g1:v1`, and the N/H/C/R vectors go beyond what I asked for. See D-M1 and D-M2. |
| B4 | Closed | `07` §2. See D-M3 for the async `submit` case and d3 for exit 1. |
| M1 | Closed | `targets[]`, the closed `action` enum mapped one-to-one to prefixes, and one +SU body shape |
| M2 | Closed | See d4 (ETag and missing `If-Match`) |
| M3 | Closed | See d5 (`/v1/meta` on the widget host) |
| M4 | Closed | |
| M5 | Closed (Sentinel pending) | See D-M4 (`aud` ambiguity) |
| M6 | Closed (S4 pending) | The gating question and the fallback provider are the right shape |
| M7 | Closed | See d6 |
| M8 | Closed | See d1 |
| M9 | Closed | |
| m1–m7 | Closed | m3's upstream half is deferred to a kit PR. That is acceptable. |

**Worth repeating:**
- The `action` enum maps each value to exactly one prefix.
- `rollout` binds `doc_version`.
- `next` is never derived from `advisory`.
- The OSC/DCS filter on the interactive TTY.
- Fast-forward-only pushes as exit 6.

These are the right instincts.

---

## New Findings

### Major

**D-M1. Sort order and path normalization are undefined in hash inputs.**
`04` §3.2 and §3.4 (`sl:spec:v1` `paths`, `sl:l2:v1`, `sl:rollout:v1` targets, `sl:webauthn:v1`
targets).

- `sorted(...)` has no defined collation. JS `Array.prototype.sort` compares UTF-16 code units,
  Python's `sorted` compares code points, and the two disagree on astral characters. A future
  non-TS verifier would compute a different hash. `sub` values are opaque host strings, so
  this case is reachable.
- `sorted([{path, status, blob_sha}])` doesn't say which key it sorts by.
- `paths[]` gets no normalization at all. `./src/a.ts`, `src/a.ts` and `src//a.ts` hash
  differently. Whoever emits `paths`, the plan skill or the CLI's extractor, can drift.

**Proposed:**
- Add to `04` §3.2: "Every `sorted` orders by the UTF-8 bytes of the sort key, lexicographically.
  `unique` runs after sorting."
- `sl:l2:v1` sorts by `path`.
- `sl:webauthn:v1` targets sort by `type`, then `id`.
- Add a path rule `P(path)` applied before sorting: POSIX separators, NFC, no leading `./`, no
  empty segments, no `..` (rejected with `422`), case preserved.
- `P` lives in `loop-schema`, and the CLI applies it before upload.
- Add vectors H-14 (an astral-plane `sub` among BMP `sub`s) and H-15 (equivalent path
  spellings, one hash).

**D-M2. Unicode version skew can produce a false `receipt_invalid`.**
`04` §3.1 step 2, `05` §4.

- A Unicode bump is a schema **minor**, so a newer server with an older CLI falls inside the
  compatibility promise.
- The server accepts a code point assigned in the new version. The older CLI then runs `N()`
  during receipt verification, rejects that code point as `\p{Cn}`, and exits 8 ("never
  retry"). Legitimate work gets stuck, behind an escalation code.
- Separately, `\p{Cn}` in a JS regex follows the runtime's ICU, not the pinned 15.1. "Pinned"
  is therefore not true as written.

**Proposed:**
- Split `N` into `N_intake` (includes the Cn rejection, runs on the server only) and `N_hash`
  (steps 1 and 3–6, used everywhere hashes are recomputed).
- NFC is stable for newly assigned characters (composition exclusions), so `N_hash` is
  version-safe.
- Implement Cn as a generated assigned-ranges table for the pinned version, never as a regex.
- `/v1/meta` adds `unicode_version`.
- Add vector N-10: a code point assigned after 15.1, hashed through `N_hash`.

**D-M3. `submit` is asynchronous, but the exit-code table only covers synchronous outcomes.**
`05` §1.3 (`→ 202`, `building{submitting}`), `07` §1.3 step 5 and §2.1.

- A `202` maps to exit 0, which an agent reads as "PR opened". The real outcome
  (`pr_opened`, or `submit_rejected` from the server's cumulative re-check) arrives later, and
  nothing in the contract tells the agent to wait.

**Proposed:**
- `submit` polls `GET /v1/cli/requests/{id}` for up to `--wait-seconds` (default 120).
- `in_review` → exit 0 with `result: {pr_number, public_ref}`.
- `submit_rejected` → exit 6 with the problem document.
- A timeout → exit 0 with `result: {pending: true}` and
  `next: [{argv: ["soren-loop","status","<id>","--wait"]}]`.
- Add `status <id> --wait [--until <state>]` with the same semantics. This becomes the general
  pattern for any `202` the CLI receives.

**D-M4. JWT `aud` is ambiguous, and host developers can't debug a `401`.**
`06` §1.1, `05` §1.1.

- "This install's API origin" has two candidates: the widget host, where
  `/v1/widget/sessions` lives, and the dashboard/API host.
- A host developer who picks the wrong one gets the deliberately generic
  `widget_auth_failed`. That generic error is correct for requesters, but it leaves the
  integrator with nothing to go on. This will be the most common support ticket.

**Proposed:**
- `aud` is the **widget host origin**, the verifying endpoint, as an exact string:
  scheme://host[:port], with no trailing slash.
- Rename the option to `createWidgetToken(user, {siteId, audience, key, kid})`.
- The server records a reason against `trace_id` for every rejected token: `aud_mismatch`,
  `iss_unknown`, `kid_unknown`, `typ_missing`, `alg_disallowed`, `exp_too_long`, `expired`,
  `jti_replay`, `bad_signature`.
- The reasons go to the owner trace view and `widget_auth_failures_total{reason}`, never to the
  widget.
- Add an owner-only `POST /v1/owner/sites/{id}/widget-token/check {token}` that returns the
  reason. `doctor` uses it.

### Minor

- **d1. Placement of the `FlagWriter` fence** (`16` §1).
  - "The adapter ignores older versions" forces stateful adapters, because Unleash has nowhere
    natural to keep the last applied version.
  - Move the fence to the worker: drop a job whose `o.version < flags.doc_version` before
    calling the adapter. Keep `version` in `WriteOpts` for adapters that can use a native
    precondition.
  - Return `{applied: boolean}`, so a skip is recorded and not silent.
  - Use camelCase `retryAfterSeconds` in TS (the wire stays snake_case).
  - Define `FlagState`.
- **d2. Reusing a CLI operation key after a crash** (`07` §2.4).
  - "A fresh invocation mints a new key" contradicts "stored until a terminal response".
  - State it as: a plain invocation reuses an existing **non-terminal** ops file for the same
    `(command, subject.id)` (no response was received). A terminal response deletes the file,
    so the next run mints a new key.
  - Name the file `<command>-<subject_id>.json`.
- **d3. Exit 1 is unassigned** (`07` §2.1). Define it as "internal error (CLI bug)", reported
  with a `trace_id` where one exists. Agents should escalate.
- **d4. `If-Match` mechanics** (`05` §1.2).
  - The detail `GET` returns `ETag: "<version>"`.
  - A missing `If-Match` returns `428 precondition_required` (`refetch_and_retry`), and the
    `428` releases the lock row.
  - `allowed_actions[].path` is concrete, with the IDs filled in, not a template.
- **d5. `/v1/meta` on the widget host** (`05` §1).
  - Serving `server_version` and `capabilities` there widens the T1.4 surface and helps
    fingerprinting.
  - On the widget host, return only `{api_version}`. The full document stays on the API host.
- **d6. Standard Webhooks details** (`08` §2.1).
  - The secret format is `whsec_<base64>`, which the reference libraries decode.
  - An unknown `site_id` returns the same `401` as a bad signature, so sites can't be
    enumerated.
  - A non-production `environment` returns `202` and is ignored (logged).
- **d7. A code name collides with an envelope member** (`05` §2). The widget `code`
  `invalid_params` shares its name with the `invalid_params[]` member. Rename the code to
  `invalid_request`.
- **d8. Prose `suggested_action`** (`16` §2: "`suggested_action: use percentage rollout`").
  - The value isn't in the enum.
  - Use `fix_arguments_and_retry` with a `detail`, and a `limit_type: "flag_targets_max"`
    (500) the dashboard can show.

## Queued Sentinel Rulings (not re-flagged)

Arendt will apply these: no push-token caching, with a repeat request returning `409` and no
token; at most two replacements, each revoking the old token, and a CLI revoke after the push;
a per-install `aud`, 30 s leeway, and required `typ` and `kid`; SR-36 bulk evaluation only
through the host handler, filtered to the allowlist; and `retry_after_seconds: null` on every
widget `limit_reached`. None of them conflicts with this review.

D-M4 doesn't contest the per-install `aud` ruling. It asks only that the ruling name *which*
origin, because the install has two. m5 and d7 are unaffected.

## Hand-offs

- **Ada:** D-M1 and D-M2 change `loop-schema/hash` and add vectors H-14, H-15 and N-10. Fold
  them into the first red batch.
- **Sentinel:** D-M4's owner-only token check endpoint. It is an oracle, but only to an
  authenticated owner.
- **Arendt:** fold D-M1 to D-M4 into `04` §3, `07` §1.3, §2, and `06` §1.1.

**Counts (delta):** 0 blocker, 4 major, 8 minor.
