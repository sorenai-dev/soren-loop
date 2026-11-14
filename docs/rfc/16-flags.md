# 16. Deep Dive: Flags

Split out of `08`, which keeps the GitHub fork model and deploy detection.


## 1. The `FlagWriter` port (`packages/flag-adapters`; Postel M8)

```ts
export const FLAG_WRITER_API = 1;   // community adapters will treat this port as public
type FlagKey = `sl_${string}`;     // runtime check too: refuses anything outside the namespace (SR-13)
interface WriteOpts { version: number }          // = flags.doc_version; for native preconditions
interface WriteResult { applied: boolean }       // false = skipped as stale, recorded (Postel d1)
interface FlagState { key: FlagKey; enabled: boolean; targets: string[]; basisPoints: number | null;
                      all: boolean; version: number | null }
interface FlagWriter {
  ensureFlag(key: FlagKey, o: WriteOpts): Promise<WriteResult>;                   // off by default; no metadata
  setTargets(key: FlagKey, targets: string[], o: WriteOpts): Promise<WriteResult>; // absolute, ≤ limits().maxTargets
  setRollout(key: FlagKey, basisPoints: number, o: WriteOpts): Promise<WriteResult>; // 0..10000, Phase 2
  enableAll(key: FlagKey, o: WriteOpts): Promise<WriteResult>;
  disable(key: FlagKey, o: WriteOpts): Promise<WriteResult>;
  describe(key: FlagKey): Promise<FlagState>;
  limits(): { maxTargets: number; supportsPercentage: boolean };
}
class FlagWriterError extends Error {
  code: "auth" | "not_found" | "conflict" | "rate_limited" | "unavailable" | "invalid";
  retryable: boolean; retryAfterSeconds?: number;    // camelCase in TS; the wire stays snake_case
}
```

- **Absolute writes, with the fence in the worker** (Postel d1). The server computes the full
  target list from the `flags` row, always excluding an opted-out requester (Zod D5). The worker
  serializes effects per flag key, and it **drops a job whose `version` is older than
  `flags.doc_version`** before calling the adapter, recording `{applied: false}`. Adapters stay
  stateless. They may use `version` for a native precondition where the vendor API offers one.
  Two out-of-order jobs can't let the older list win.
- **Typed errors** drive the outbox: a `retryable` error backs off and retries, and a
  non-retryable one goes `dead`, with the locked `outbox_dead` alert.
- **No metadata reaches an adapter.** `meta.requestId` is dropped (SR-13).
- Every call is an outbox effect of a transition, never an inline call.

## 2. Default: flagd sourced from Postgres (ADR-6)

- The server renders one flagd document per site from `flags`. Each targeted flag is
  `{state: ENABLED, variants: {on: true, off: false}, defaultVariant: "off", targeting:
  {"if": [{"in": [{"var": "targetingKey"}, [<targets>]]}, "on", "off"]}}`. When `all` is set,
  the flag is rendered `{state: ENABLED, variants: {on: true, off: false}, defaultVariant: "on"}`
  with **no `targeting` rule**. flagd uses the variant the targeting returns, so keeping the
  rule's `"off"` else-branch would leave every user outside the target list off (Sentinel, S4).
  A unit test renders `all` and evaluates a non-targeted identity as on. `pct` uses
  `fractional`, salted by flag key (Phase 2).
- **The sync endpoint is internal and authenticated** (S4 F1, ST-19). It binds to a separate
  listener (`--flagd-listen 127.0.0.1:8014` or a private network), never the public hostnames,
  and requires a bearer credential. flagd's HTTP source sends it with `authHeader: "Bearer …"`
  on every poll and honours `ETag`/`If-None-Match`, so unchanged polls are 304s. A missing
  credential gets 401. A wrong credential at start makes flagd exit 1 (fails closed, loudly).
- **The credential.** One credential per site, scoped to that site's document only, because the
  document carries `sub` lists (Sentinel M4). It is kept out of flagd's process arguments and
  environment: flagd reads its sources from a config file (`--config`) mounted read-only. With
  `--sources` on the command line, `docker inspect` shows the bearer (F2). The config-file path
  is **UNVERIFIED** (S4 didn't run it); ST-19 checks that neither `docker inspect` nor
  `/proc/<pid>/cmdline` shows it (Sentinel condition 9, Task 081).
- **Rotation.** The sync endpoint accepts the old and new credential during an overlap window,
  then flagd is restarted on the new one and the old one is revoked. A test checks that an
  overlapped rotation never produces a 401 poll (condition 8).
- **Stale-sync detection** (S4 F3, condition 7). A sync that breaks after a good start does not
  stop flagd: it keeps serving its last good document, `healthz` and `readyz` stay 200, and a
  killed flag stays on. flagd's sync metrics can't tell this from "no change", because 304s
  aren't counted. Tracking the last authenticated poll isn't enough either: flagd keeps its last
  good document when it rejects an accepted one. So each site's document carries a **canary**,
  a non-allowlisted `sl_` flag whose value changes with every document generation. The server
  also regenerates the document on a fixed canary period (proposed 30 s), so a quiet site still
  has a fresh canary while most polls stay 304s. A server-side probe evaluates the canary through
  each flagd instance. A served canary that lags the server's current one by more than 3× the
  poll interval marks that instance stale and raises the locked `flag_sync_stale` alert (`10` §1, SR-39(e)). While
  an instance is stale, `createOfrepHandler` returns 503 for it, so browsers fall back to
  defaults (off; this fails closed only with the browser cache disabled, §5). Host backends
  using the flagd provider directly get the same signal from the metric.
- **Poll interval: 1 s by default.** The flagd interval bounds kill latency at the flagd layer
  (`10` §4), and unchanged polls are 304s, so a short interval is cheap.
- **flagd writes nothing to disk** (S4 F8), so the SR-27 purge needs no flagd step beyond
  re-rendering the served document. The browser's provider cache is the persistence to account
  for instead (§5).
- **Host evaluation.** Server-side evaluation through the flagd provider in the host backend is
  the recommended pattern. Browser evaluation is in §5.
- **The 500-target cap** per flag (R9). Past it, `widen_rollout` returns `422` with
  `suggested_action: fix_arguments_and_retry`, `limit_type: "flag_targets_max"`, and a
  `detail` that suggests a percentage rollout (Postel d8).

**Alternative.** Make Unleash the default store. Rejected for the MVP: it's an extra service for
self-hosters who don't already run it, and decision 8 makes it the first *vendor adapter*, not
the default.

**Second-order cost.** The flagd document carries `sub` lists. That's PII on a second system
(SR-27 purge must rewrite the document), and its size grows linearly. Mitigation: the cap, the
purge effect, a per-site credential, and an internal-only endpoint. The canary probe and
rotation overlap are extra moving parts, but without them a broken sync is a silent kill-switch
failure.

## 3. Unleash adapter (decision 8; Phase 2 by decision 29, Q3)

| `FlagWriter` | Unleash Admin API mapping |
|--------------|---------------------------|
| `ensureFlag` | Create the feature in the configured project; add a disabled flexible-rollout strategy in the configured environment |
| `setTargets` | Replace the strategy's `userId IN [...]` constraint at 100% (Unleash warns that constraint values grow the payload, hence the shared cap) |
| `setRollout` | Flexible rollout `rollout = pct`, stickiness `userId` |
| `enableAll` / `disable` | Environment toggle on / off |

Credential: an Unleash token scoped to one project and environment, envelope-encrypted, and
decrypted only in the worker (SR-13, SR-14, T11.3). The exact endpoint paths are pinned by the
Phase 2 adapter task, with a verification step against the current Unleash docs (Postel M8;
**UNVERIFIED** here). `setTargets` maps the `version` fence onto Unleash's strategy update, and
falls back to a read-compare-write if the API has no ETag.

## 4. The flag gate in code (R3, T11.5)

`build`'s prompt contract injects the flag key and the rule "flags are rollout controls, not
authorization". `submit` enforces SR-04(d), using the deterministic definition in `07` §1.3
(a non-comment code reference, a test that references the key, and a test run with the key
forced off). After deploy, the SR-23 probe (SHOULD) evaluates the flag as a
synthetic non-targeted identity and alerts if it's `on`. Owners are told plainly that gated
code may expose only what the server already authorizes for that user (T11.1).


## 5. Browser Evaluation: OFREP Contract (FL-1, SR-36, decision 28; Postel M6)

**The gating question is answered (S4 F5; T25 closed: owner approval 2026-11-14 (S4), with Sentinel's ten conditions).** The stock
OpenFeature OFREP web provider evaluates **only** in bulk (`POST /ofrep/v1/evaluate/flags`). It has
no single-flag mode, so a handler that blocks bulk would make every flag resolve to its default.
Through a handler that forwards bulk and filters it to the allowlist, the stock provider works
unchanged (ST-68 shape passes). The default branch below is confirmed, and the
`SorenLoopFlagProvider` fallback is **not needed** and is dropped. flagd's own bulk endpoint
returns every flag, so enumeration is closed only by the handler's filter: flagd's OFREP port must
never be reachable from a browser (SR-36's private binding is necessary, not defence in depth).

**The handler (SR-36 as amended; Sentinel's S4 conditions 1 to 5, Task 082).**
`@sorenai/loop-node` ships the proxy, so hosts never hand-roll a security-critical handler:

```ts
createOfrepHandler({ flagdUrl, allowlist: FlagKey[], getUser: (req) => SorenLoopUser | null })
  : (req: Request) => Promise<Response>      // Fetch API, mountable in any framework
```

- **Context.** It strips any browser-sent evaluation context, and injects
  `evaluationContext(user)`, which sets `targetingKey` from the host session. A forged browser
  `targetingKey` is ignored (S4). No session → 401; the provider then fails to initialise and
  every flag resolves to its default.
- **Single flag.** It forwards single-flag requests only for allowlisted keys, and returns a
  uniform 404 body for anything else.
- **Bulk.** It accepts `POST /ofrep/v1/evaluate/flags`, forwards it to flagd, and **rebuilds every
  entry from an allowed field list**: `key`, `value`, `variant`, `errorCode`. No `reason`, no
  `metadata`, no flagd `eventStreams`. Non-allowlisted keys are dropped (condition 2).
- **Its own ETag** (condition 1). The handler computes the ETag over the filtered body and the
  allowlist version, and answers `If-None-Match` with 304 itself. flagd's ETag (computed over the
  unfiltered body, so a side channel on hidden flags) never reaches the browser, and the
  browser's `If-None-Match` never reaches flagd. An allowlist change changes every ETag, so a
  client never misses a new key.
- **Its own change stream** (conditions 3, 4). The handler advertises its own `eventStreams`
  entry for a handler-owned SSE route. It holds **one upstream flagd subscription per process**,
  checks the session when a client connects, sends clients only `{"type": "refetchEvaluation"}`
  (no flagd bytes; the stock provider reads only `type`, `etag` and `lastModified`), and closes
  each stream on disconnect and on session expiry. Bounded browser kill latency is the default,
  not a host choice: a sync change reaches a foreground tab within the flagd interval + 2 s
  (`10` §4). Without a change stream or polling, the stock provider never sees a kill in a
  foreground tab (S4 F6).
- **Forwarded-request hardening** (condition 5). No browser headers go upstream. An upstream
  timeout fails closed with a generic 503. Malformed input gives a 4xx or 503, never a thrown 500.
  Responses carry `Cache-Control: private, no-store` and no CORS headers (same-origin only).
  Construction fails on an empty allowlist or on any key outside the `sl_<random>` pattern.
- **Stale instance.** While the canary marks the flagd instance stale, the handler returns 503
  (§2, condition 7).
- **The allowlist is the `sl_` keys present in the shipped client bundle**, generated at build
  time. It is never "all `sl_` keys" (Sentinel).
- `createWidgetToken` and `evaluationContext` take the same `SorenLoopUser` type
  (`{sub, name?, email?, emailVerified?}`), so `sub` and `targetingKey` can't drift.

**The provider factory** (condition 6, Tasks 082 and 087). `@sorenai/loop-react` ships a factory
that builds the **stock** OFREP web provider against the handler's base URL and pins
`cacheMode: 'disabled'`. It is configuration, not a custom provider: flagd still evaluates. The
reason is the stock cache (S4 F7):

- The default `local-cache-first` keeps evaluations in `localStorage` for 30 days and resolves
  from them before the network, so after a kill and a reload a flag reads **on** at `ready`, and a
  first render shows the killed feature.
- Its key is built from the base URL, headers, domain and the **browser-side** `targetingKey`.
  The handler ignores that context and the session is a cookie, so two users on one browser share
  an entry, and user B's first render can show user A's evaluations (Sentinel H2).
- `network-first` is not a fix: it still writes the 30-day cache and falls back to it on 5xx and
  network errors, which is exactly what the stale-instance 503 triggers.
- The cache also holds per-user evaluations the SR-27 purge can't reach.

ST-68 adds two assertions: after a kill and a reload the value at `ready` is off, and on one
browser profile user B never sees user A's evaluations. Task 087's docs name the provider cache
and why the factory disables it. Hosts that build the provider themselves are told to set the
same option; `doctor` can't check browser code, so this is documentation, not enforcement.
