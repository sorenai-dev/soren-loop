# 14. Notification Policy (decision 30)

A per-stage, per-event policy that decides which **pushed** notifications are emitted, to whom,
and on which channels, including none. In the MVP it is a seam: shipped defaults plus a
validated site override, so the owner can tune notifications later without code changes.

**Not governed by this policy:** the widget's status feed (`03` §5, `05` §1). The feed always
shows the current requester stage. The policy only covers what soren-loop *pushes*.

## 1. Interface

```ts
type RequesterStage =
  "received" | "needs_your_input" | "planning" | "building" | "shipping" | "available" | "closed";

type Channel = "email" | "dashboard_inbox";            // MVP. Phase 2 extension point: §6

type NotificationEvent =
  | { audience: "requester"; kind: "requester.stage_entered"; stage: RequesterStage;
      request_id: string; stage_since: string }        // hour-rounded; no internal state, by type (§3)
  | { audience: "owner"; kind: OwnerEventKind; request_id?: string; site_id: string };

type OwnerEventKind =
  // locked: always on, at least the default channels (§2.2); SR-39e
  | "owner.security_hold_entered" | "owner.precheck_unavailable"
  | "owner.app_permission_check_failed" | "owner.outbox_dead"
  | "owner.policy_changed" | "owner.audit_chain_mismatch" | "owner.authenticator_changed"
  | "owner.cli_device_approved" | "owner.owner_contact_changed" | "owner.pr_head_changed"
  // tunable
  | "owner.request_submitted" | "owner.plan_ready" | "owner.run_stalled"
  | "owner.rate_limited" | "owner.pr_opened" | "owner.deploy_wait_exceeded"
  | "owner.flag_enabled" | "owner.requester_throttled" | "owner.enablement_confirm_needed";

interface NotificationPolicy {
  resolve(event: NotificationEvent, audience: "owner" | "requester"): Channel[]; // may be []
}
```

`resolve` is pure. It runs **inside the transition transaction**, when the state machine
builds that transition's outbox rows (`04` §5), and it reads the site's policy version pinned
at transaction start. Delivery stays behind `Notifier` (`02` §6). Workers drain
`notify.<channel>` rows. They never call the policy, and they never decide whether to send.
Events with no state transition behind them (`owner.app_permission_check_failed` from the
start-up check, `owner.outbox_dead` from a worker) are resolved inside the transaction that
records them (the audit row, or the outbox status change), under the same rule.

## 2. Policy Shape

### 2.1 Shipped defaults (in code, `apps/server/src/notifications/defaults.ts`)

| Audience | Key | Default channels | Locked |
|----------|-----|------------------|--------|
| Requester | `received` | `[email]` | No |
| Requester | `needs_your_input` | `[email]` | No |
| Requester | `planning`, `building`, `shipping` | `[]` | No |
| Requester | `available` | `[email]` | No |
| Requester | `closed` | `[email]` | No |
| Owner | `owner.security_hold_entered`, `owner.precheck_unavailable`, `owner.app_permission_check_failed`, `owner.outbox_dead` | `[email, dashboard_inbox]` | **Yes** |
| Owner | `owner.policy_changed` (otherwise whoever edits the policy could hide the edit), `owner.audit_chain_mismatch` (SR-37), `owner.authenticator_changed`, `owner.cli_device_approved`, `owner.owner_contact_changed` (email to the real owner is how a stolen synced passkey gets noticed) | `[email, dashboard_inbox]` | **Yes** |
| Owner | `owner.pr_head_changed` (SR-41: the active PR's head moved off its pin, or a superseded PR was merged; `reason` carries which) | `[email, dashboard_inbox]` | **Yes** (the tenth locked kind) |
| Owner | `owner.request_submitted`, `owner.plan_ready`, `owner.run_stalled`, `owner.rate_limited`, `owner.deploy_wait_exceeded`, `owner.enablement_confirm_needed` | `[email, dashboard_inbox]` | No |
| Owner | `owner.pr_opened`, `owner.flag_enabled`, `owner.requester_throttled` | `[dashboard_inbox]` | No |

**Requester email (T17, ruled by Sentinel, SR-39c).**
- It is off by default and enabled per site.
- The address comes only from an optional host-JWT `email` claim, and **only when
  `email_verified: true`**. Otherwise a host that doesn't verify addresses would turn
  soren-loop into a phishing relay sending from the owner's domain (T6.5).
- The address is envelope-encrypted at rest (`requesters.email_enc`), never logged, and purged
  under SR-27.
- Mail carries `List-Unsubscribe` and a per-recipient rate limit.
- **Requester templates contain no request title.** They use the product name, "your request",
  the stage, and the link. The `closed` template is byte-identical across every `closed{*}`
  cause (`rejected`, `closed`, `flag_off`), apart from the link, and carries no reason (ST-59).
- With no verified address, a requester entry resolves to `[]` and the row is recorded as
  `suppressed` with reason `no_address`.

A hold that ends in rejection during `planning` looks like an owner rejecting at plan review.
Sentinel accepts that remaining signal as residual (T12.4).

### 2.2 Site override (DB, `notification_policies`)

```json
{
  "schema": "sl.notification_policy.v1",
  "requester": { "planning": { "channels": ["email"] }, "received": { "channels": [] } },
  "owner": {
    "owner.pr_opened": { "channels": ["email", "dashboard_inbox"] },
    "owner.security_hold_entered": { "add_channels": [] }
  }
}
```

Validation (zod, strict) at `PUT` time:

- **Unknown keys are rejected** with `422 policy_unknown_key`. Requester keys must be one of
  the seven stages. Owner keys must be an `OwnerEventKind`. Unknown channels are rejected too.
- **Locked entries are rejected** if they carry `channels` (a replacement list). That returns
  `422 policy_locked_entry`. A locked entry accepts only `add_channels`, so the effective list
  is always `defaults ∪ add_channels`. Its last channel can't be dropped.
- A channel the audience can't use is rejected: `dashboard_inbox` for a requester, and in Phase 2
  `sms` for a requester (SR-33).
- **Content is not overridable.** Templates stay fixed (SR-06: fixed subject, plain text, kind
  plus one link for the owner; the requester rules are in §2.1). A policy chooses only *whether*
  and *where*.

Effective policy = defaults, overlaid with the override per key. `resolve` evaluates against
that.

## 3. Why a Policy Can't Reveal a Hold (A23-5, ST-33)

1. **Requester events exist only on a requester-stage change.** The state machine creates a
   `requester.stage_entered` event exactly when the projection in `03` §5 changes, never for an
   internal transition. A hold never changes the requester stage, so it never creates a
   requester event for any policy to act on.
2. **The policy can't see internal state.** The requester event type carries only `stage`,
   `request_id`, and `stage_since`. Requester keys can only be stage names, and the schema
   rejects anything else. No override can say "notify on `security_hold`", or on any state
   inside a stage.
3. **Timing matches the feed.** Requester `notify.*` rows are scheduled at the next hour
   boundary (`next_attempt_at = ceil_hour(now)`, T18), the same granularity as `stage_since`.
4. **Suppression records are owner-only.** `suppressed` rows are never visible on any widget
   route.
5. **Test (ST-54, extends ST-33).** For a held request and a normally progressing request with
   the same stage history, the requester-audience outbox rows (including `suppressed` rows) and
   the feed responses are identical in kind, stage, count, and scheduled hour, under the
   defaults and under a randomized valid override. ST-55 covers the override-validation cases.

Owner events about holds (`owner.security_hold_entered`, `owner.precheck_unavailable`) are owner
audience only, and the type system keeps them from ever resolving to a requester channel.

## 4. Outbox Rows and Suppression

For each event, inside the transaction that produces it (Zod m9: exactly one rule):

```text
defaults  = Defaults.channels(event)          # timers: evaluated when the timer fires (Zod M4)
effective = policy.resolve(event, audience)
for c in effective:             insert outbox(effect="notify."+c, status=pending)
for c in defaults \ effective:  insert outbox(effect="notify."+c, status=suppressed, reason="policy")
if defaults ∪ effective is empty:
                                insert outbox(effect="notify.none", status=suppressed, reason="policy")
# A requester event with no verified address: email resolves to [] and is recorded as
# suppressed with reason "no_address" under the second loop. No notify.none row is added then.
increment notifications_suppressed_total{kind} once per suppressed row
```

Each row's key is `H("sl:obx:v1"; source_type, source_id, effect, kind, audience, channel)`
(`04` §5), so two events in one transaction never collide (Zod B1).

- **Who decides what.** The policy decides **whether and where**, in the transaction. The
  `Notifier` decides only **how to batch delivery** of rows that are already `pending`: the
  SR-11 digests for unlocked owner kinds, and leading-edge coalescing for locked email. Neither
  can drop a row. A row ends as `done` or `sent_coalesced`, never `suppressed` (Zod m9).
- **Ordering.** Requester rows for one request are delivered in `source_id` order, and each is
  scheduled at `ceil_hour` (Zod M4).
- **Requester email opt-in** is `sites.requester_email_enabled` (default false). When it's
  false, requester email defaults resolve to `[]` with reason `no_address`.

- `suppressed` is a **terminal** outbox status that workers never drain. The row stores `kind`,
  `audience`, `channel`, `stage` (requester only), `policy_version`, and `reason`. It never
  stores the rendered message or an address, so it contains no PII beyond `request_id`. Rows are
  kept for 30 days, then deleted.
- The dashboard's **Notifications → Suppressed** view lists them grouped by kind ("would have
  emailed the requester on `planning` 14 times this week"), so the owner can tune with real
  data.
- **Locked alerts are never digested** (T20). Unlocked owner kinds follow the SR-11 digest rule.
- **Coalescing of locked email (T19, Sentinel's conditions, ST-56):**
  - It is per `(site, kind)`, so a flood of `precheck_unavailable` never buries a
    `security_hold_entered`.
  - It is **leading-edge**: the first event is sent immediately, and only later events in the
    15-minute window are batched.
  - The batched email lists every `request_id`, grouped by requester, so a flood from one
    account is obvious.
  - `dashboard_inbox` is never coalesced: one item per event.
  - Each row ends as `sent_coalesced`, with the delivered message ID.

### 4.1 Locked alerts can't be silenced indirectly (SR-39f, ST-57)

- Changing the owner's email address or the SMTP configuration requires +SU. It emits
  `owner.owner_contact_changed` to the **old** address as well as the new one.
- If a locked channel can't be delivered (no SMTP configured, or a locked `notify.email` row
  that went `dead`), the dashboard shows a **persistent banner** until it's fixed, and `doctor`
  fails.
- `owner.outbox_dead` about a `notify.*` row resolves to `dashboard_inbox` only, whatever the
  policy says, so a broken mail path can't create a dead-letter loop.

## 5. Changing the Policy

- `PUT /v1/owner/sites/{id}/notification-policy` requires +SU with action
  `notification_policy.update`. The challenge's content hash binds the **site and the base
  version** as well as the content:
  `H("sl:notification_policy:v1" ‖ site_id ‖ base_version ‖ JCS(override))`. An assertion for
  site A can't apply to site B. A stale base returns `409 policy_version_conflict`, so an old
  override can't be replayed to revert a later change. One step-up per change (SU-2, SR-35,
  ST-58).
- The dashboard renders the **effective-policy diff** (current effective vs proposed effective)
  that the owner is signing, not the raw override JSON.
- Each accepted change creates a new `notification_policies` version row, writes an
  `audit_events` row `notification_policy.change` (with the diff digest and the approval ID),
  and emits `owner.policy_changed`.
- `DELETE` (reset to defaults) is also +SU, with the same `site_id` and `base_version` binding
  over an empty override.
- Policy edits are part of the SR-37 hash chain.
- Transactions pin the version they read, so a change mid-transition applies from the next
  transition on.

## 6. Phase 2 Extension Point: New Channels

A channel is an entry in the `Channel` enum (an additive schema change, `05` §4) plus a
`Notifier` adapter registered under that name, plus an audience allowlist:

| Channel | Audience | Requirements |
|---------|----------|--------------|
| `sms` | Owner only | SR-33: verified owner numbers, destination rate limits, no tokens in bodies |
| `web_push` | Owner only | VAPID push to the dashboard PWA |
| `webhook` | Owner, and a requester relay | HMAC-signed with a timestamp (like the deploy webhook, `08` §2). Owner endpoint: the three-layer SSRF defense at registration and at send time, and a minimal payload `{kind, request_id}`. Requester relay: posts `{request_id, stage, stage_since}` to the host app at `ceil_hour` like email (SR-39b). The host delivers through its own channels, and soren-loop holds no requester address (the preferred T17 path). |

Adapters receive only the rendered fixed template and the destination. Policy evaluation stays
in the transaction. Adding a channel never changes `resolve`'s contract.

## 7. Where This Lands Elsewhere

`04` §2 (tables `notification_policies` and `inbox_items`; outbox statuses `suppressed` and
`sent_coalesced`; `requesters.email_enc`), `05` §1 (policy, suppressed-log, inbox, and
owner-contact routes), `09` (SR-39, SR-40), `10` §1 (metrics), `12` §4 (estimate: about 3.5
days with SR-39 and SR-40), `13` §3 (T17 to T21).
