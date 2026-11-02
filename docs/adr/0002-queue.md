# ADR 0002: Outbox Drain and Timer Queue

- **Status:** Accepted
- **Date:** 2026-11-02
- **Decision source:** project brief decision 35; RFC `02` §6 (queue row), `04` §5

## Context

The `outbox` table is the source of truth for every side effect (RFC `04` §5). Workers claim rows
with `FOR UPDATE SKIP LOCKED`, `gh.*` effects are serialized per request through the
`effect_claims` lease, and retries follow our own schedule (10 attempts over about 24 hours, then
`dead`). The queue library therefore does not own effect state. It has three jobs:

1. **Wake** a worker promptly when a transition commits outbox rows.
2. **Run timers**: SLA reminders, lease expiry, retry backoff, and delayed requester delivery
   (`ceil_hour`). Timers must be rescheduled or cancelled by key when the request moves on.
3. **Run the nightly reconciler** (RFC `10` §4) on a schedule.

Enqueueing must commit in the **same transaction** as the transition, or a crash between the two
loses the wake-up.

## Options

| Criterion | graphile-worker 0.18 | pg-boss 12.x |
|-----------|---------------------|--------------|
| Maintenance (checked 2026-11-02) | Active; last release 2026-09-08 | Active; last release 2026-10-13 |
| Enqueue inside our transaction | `select graphile_worker.add_job(...)` is plain SQL, so it runs on the Kysely transaction with no adapter | `send(..., { db })` with an `executeSql` adapter wrapping the Kysely transaction |
| Keyed timers (reschedule/cancel) | `job_key` with `replace` / `preserve_run_at` modes; `remove_job(key)` | `singletonKey` plus `startAfter`; cancel by job ID |
| Schedules | Built-in crontab | Built-in `schedule()` |
| Wake latency | `LISTEN/NOTIFY`, with polling as a fallback | Polling (interval configurable) |
| Coexists with our own `SKIP LOCKED` claim | Yes: jobs carry only `{ outbox_id }` | Yes, same shape |
| Runs on PGlite | No (needs `LISTEN` and its own schema functions) | No |

## Decision

**graphile-worker.** The deciding factors are the transactional enqueue (plain SQL on the same
Kysely transaction as the state transition, with no adapter to get wrong) and `job_key`, which maps
directly onto timers that must be replaced or removed when a request changes state.

Rules for using it:

- A job payload is only an identifier (`{ outbox_id }` or `{ timer_id }`). No PII and no effect
  data go in the payload; the worker reads the outbox row (RFC `04` §5, Zod M7).
- Our outbox owns attempts and backoff. Jobs use `max_attempts := 1`; a failed attempt
  re-enqueues the wake-up with `run_at` set from the outbox's backoff schedule and
  `job_key := 'obx:' || outbox_id`.
- Timers use `job_key := 'timer:' || timer_id`, so a transition that cancels or moves a timer
  replaces or removes exactly one job.
- graphile-worker's schema is migrated by its own installer, called from our `db:migrate`
  migration that adds it, with a matching `down`.

## Consequences

- Worker and timer tests need real Postgres. They are `@pg` tests and run in the `test-db` CI job.
- graphile-worker is pre-1.0. Pin a minor version, and read its changelog on every bump.
- If graphile-worker stalls, pg-boss is a drop-in at the boundary above (both receive only an
  identifier and both enqueue transactionally). Only the enqueue helper and the worker bootstrap
  would change.
