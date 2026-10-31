# 16. Deep Dive: Flags

Split out of `08`, which keeps the GitHub fork model and deploy detection.


## 1. The `FlagWriter` port (`packages/flag-adapters`, server-only)

```ts
interface FlagWriter {
  ensureFlag(key: FlagKey, meta: { requestId: string }): Promise<void>;     // off by default
  setTargets(key: FlagKey, targetingKeys: string[]): Promise<void>;         // absolute, ≤ 500
  setRollout(key: FlagKey, pct: number): Promise<void>;                     // Phase 2
  enableAll(key: FlagKey): Promise<void>;
  disable(key: FlagKey): Promise<void>;
  describe(key: FlagKey): Promise<FlagState>;
}
type FlagKey = `sl_${string}`; // runtime check too: refuses anything outside the namespace (SR-13)
```

Discovery's `enableFor(key, ids)` becomes `setTargets` with **absolute** semantics. A retried
outbox job then can't double-apply. The server computes the full list from the `flags` row
(existing targets plus the new `sub`), so the DB stays the single source of the target list.
Every call is an outbox effect of a transition (SR-13), never an inline call from a request
handler.

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
  the recommended pattern. For browser evaluation, the host proxies OFREP *single-flag*
  evaluation through its own backend. flagd's evaluation port is not exposed to browsers by
  default, so bulk evaluation can't enumerate keys (AB6). This adds work for host apps. Postel
  should review the `packages/react` ergonomics here.
- **The 500-target cap** per flag (R9). Past it, `widen_rollout` refuses explicit targets with
  `suggested_action: use percentage rollout`.

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
decrypted only in the worker (SR-13, SR-14, T11.3). Exact endpoint paths are left for Postel to
pin against the current Unleash docs (**UNVERIFIED** here).

## 4. The flag gate in code (R3, T11.5)

`build`'s prompt contract injects the flag key and the rule "flags are rollout controls, not
authorization". `submit` enforces SR-04(d): a code reference to the key, plus a test that
exercises the flag-off path. After deploy, the SR-23 probe (SHOULD) evaluates the flag as a
synthetic non-targeted identity and alerts if it's `on`. Owners are told plainly that gated
code may expose only what the server already authorizes for that user (T11.1).

