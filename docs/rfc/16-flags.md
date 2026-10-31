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

- The server renders one flagd document per site from `flags`. Each flag is
  `{state: ENABLED, variants: {on: true, off: false}, defaultVariant: "off", targeting:
  {"if": [{"in": [{"var": "targetingKey"}, [<targets>]]}, "on", "off"]}}`. `all` sets
  `defaultVariant: "on"`. `pct` uses `fractional`, salted by flag key (Phase 2).
- **The sync endpoint is internal.** It binds to a separate listener (`--flagd-listen
  127.0.0.1:8014` or a private network), never the public hostnames. It requires a bearer
  credential if flagd can send one. That is **UNVERIFIED** (S4). If it can't, the endpoint is
  network-restricted only, or moves to gRPC sync with auth or mTLS (ST-19, T11.2).
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
purge effect, and an internal-only endpoint.

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

**Gating question for S4 (UNVERIFIED).** Postel reports that the stock OpenFeature OFREP **web**
provider evaluates in bulk (`POST /ofrep/v1/evaluate/flags`), to fit the static-context model.
SR-36 currently says the bulk path is never proxied. If both are true, the stock provider gets
404s and every flag silently resolves to its default, which is "off". **S4 must confirm** whether
the web provider can be configured for single-flag evaluation
(`/ofrep/v1/evaluate/flags/{key}`).

**Default (SR-36 as amended and confirmed by Sentinel; S4 confirms provider compatibility,
ST-68).** `@sorenai/loop-node` ships the proxy, so hosts never hand-roll a security-critical
handler:

```ts
createOfrepHandler({ flagdUrl, allowlist: FlagKey[], getUser: (req) => SorenLoopUser | null })
  : (req: Request) => Promise<Response>      // Fetch API, mountable in any framework
```

- It strips any browser-sent evaluation context, and injects `evaluationContext(user)`, which
  sets `targetingKey` from the host session.
- It forwards single-flag requests only for allowlisted keys, and returns 404 for anything
  else.
- **Bulk handling:** the handler accepts `POST /ofrep/v1/evaluate/flags` too, forwards it to
  flagd, **filters every response to allowlisted keys**, and drops all metadata. Enumeration is
  closed by the allowlist and the injected `targetingKey`, not by blocking the path.
- **The allowlist is the `sl_` keys present in the shipped client bundle**, generated at build
  time. It is never "all `sl_` keys" (Sentinel).
- `createWidgetToken` and `evaluationContext` take the same `SorenLoopUser` type
  (`{sub, name?, email?, emailVerified?}`), so `sub` and `targetingKey` can't drift.

**Fallback contract, only if S4 shows the stock provider can't work through the handler.**
`@sorenai/loop-react` ships
`SorenLoopFlagProvider`. This is a thin OpenFeature web provider that calls the proxy's
single-flag route per key, on demand, with a short cache and an explicit `keys` prop for
prefetch. It is a provider wrapper, not an evaluator: flagd still evaluates. Its cost is a small
custom provider to maintain, against discovery's "no custom provider" preference.
