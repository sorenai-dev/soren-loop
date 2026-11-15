# Spike S4: flagd HTTP Sync Auth and Latency, and the OFREP Web Provider Bulk Question

Answers the four S4 questions in `rfc/12` §5, with the OFREP bulk question as the gate for T25
(`13` §3a). Date: 2026-11-14. flagd image
`ghcr.io/open-feature/flagd@sha256:a1b6de22…b764a` (built 2026-10-28); `@openfeature/web-sdk` 1.10.0,
`@openfeature/ofrep-web-provider` 0.4.3 (`ofrep-core` 2.3.0), used unpatched in headless Chromium
(Playwright 1.65.1). All local: flagd in Docker on 127.0.0.1, a stub of the server's sync endpoint, and
a prototype of `createOfrepHandler` written to the `16` §5 signature.

## Verdict

**The `16` §5 default branch applies: allowlist-filtered bulk in `createOfrepHandler`.** The stock
web provider evaluates **only** through the bulk endpoint and has no single-flag mode, so a handler that
blocks bulk would break it. Through a handler that forwards bulk and filters to the allowlist, the stock
provider works unchanged: allowlisted flags resolve, everything else resolves to its default, and the
browser's own context is ignored. `SorenLoopFlagProvider` (the fallback) is not needed. **Sentinel
signed off with ten conditions (see Sign-off); T25 can close once the owner signs off too** (Task 005
acceptance; required before Task 082).

Three findings change the design beyond T25:

1. **A sync that breaks after start fails silently** (F3): flagd keeps serving its last good document,
   reports healthy and ready, and a killed flag stays on.
2. **flagd advertises an SSE stream the handler must handle** (F6): drop it and, without polling, the
   browser never learns of a kill.
3. **The provider's default cache serves a killed flag as on at startup** (F7), from `localStorage`.

| # | `12` §5 question | Result | Key observations |
|---|------------------|--------|------------------|
| 1 | Can flagd HTTP sync send a bearer header? (ST-19) | **Yes** | `authHeader: "Bearer …"` sent on every poll; `If-None-Match`/`ETag` honoured (unchanged polls are 304); no credential → 401 at the endpoint; wrong credential at start → one 401, then flagd **exits 1**; credential broken after start → flagd **keeps running on stale flags** (F3) |
| 2 | Reload latency p50/p95, DB change → evaluation change | Bounded by the poll interval | 1 s: p50 593, p95 979, max 1012 ms (n=20) · 5 s: 1655 / 4338 / 4523 ms (n=20) · 10 s: 6286 / 9988 / 9988 ms (n=10); none missed |
| 3 | Can the stock OFREP web provider use single-flag only, or does it need bulk? | **Bulk only** | only `POST /ofrep/v1/evaluate/flags` observed; works through the allowlist-filtered handler (ST-68 shape passes) |
| 4 | Does flagd persist any document to disk? | **No** | `docker diff` on the flagd container is empty after repeated syncs and after failed syncs |

Raw evidence: `spikes/s4/results/run-20261114T215039.json`, kept in history at `7abb099` (31 rows, all matching the recorded
baseline; the per-run sync credential is redacted and was confirmed absent).

## Setup

- `spikes/s4/docker-compose.yml`: flagd with one HTTP source
  (`{"uri", "provider": "http", "authHeader", "interval"}`), every port bound to `127.0.0.1`.
- `lib/sync-stub.ts`: serves the `16` §2 document shape from an in-memory table on `127.0.0.1:8099`,
  requires `Bearer <random per run>`, sets `ETag`, and logs each poll (credential present, correct or
  wrong; never its value). It stands in for the server, so latency excludes the server's render time.
- `lib/ofrep-handler.ts`: a prototype of `createOfrepHandler({flagdUrl, allowlist, getUser})`. It
  injects `targetingKey` from the session (a cookie here), forwards single-flag requests only for
  allowlisted keys, forwards bulk and filters it to the allowlist, and drops `metadata`. flagd's
  `eventStreams` are dropped by default or relayed with `sse: 'proxy'` (F6). It is spike code, not the
  Task 082 implementation.
- `page/app.ts`: the stock provider pointed at the host origin. It sets a forged `targetingKey: "bob"`
  to test that browser context is ignored. Flags: `sl_on_alice` (targets alice), `sl_off` (carol),
  `sl_bob_only` (bob), all allowlisted, and `sl_secret_alice` (targets alice, **not** allowlisted).

## Findings

**F1. flagd sends the sync credential, and the endpoint can require it (ST-19).** `authHeader` is sent
verbatim on every poll. The documented alternatives are custom `headers` and OAuth; neither was needed.
The `16` §2 UNVERIFIED marker can be removed, and the "network-restricted only" and gRPC fallbacks are
not needed for auth.

**F2. The credential is visible in flagd's container arguments.** With `--sources` on the command line,
`docker inspect` shows the bearer. flagd also reads sources from a config file (`--config`, YAML with
`authHeader` per the docs); mounting that file read-only would keep the credential out of process
arguments. **UNVERIFIED**: the config-file path was not run here.

**F3. A sync that breaks after a good start does not stop flagd, and it serves stale flags.** With the
credential rotated at the server while flagd ran, every poll got 401 and flagd logged `error fetching …
401 Unauthorized` each second, but kept running (`running 0`). `healthz` and `readyz` stayed 200, and a
flag killed at the source still evaluated **on**. The sync metrics don't separate this from "no
change": `feature_flag_flagd_sync_client_flag_config_received_total` counts only 200 responses, and
unchanged polls are 304s. So the kill switch can fail with nothing reporting it. By contrast, a wrong
credential **at start** makes flagd exit 1 after one 401: that case fails closed and loudly.
Recommended mitigations, for the RFC (strengthened by Sentinel, conditions 7 and 8):
- Tracking the last **authenticated** poll is not enough on its own: an accepted poll whose document
  flagd rejects would look healthy while flagd serves the old flags (Sentinel H1; untested, but
  consistent with flagd's keep-last-good behaviour). Use a **canary**: a non-allowlisted `sl_` flag
  whose value changes with every document generation, evaluated through flagd by a server-side
  probe. Older than 3× the interval raises a locked alert, tracked per flagd instance.
- While a flagd instance is stale, `createOfrepHandler` returns 503 for it, so browsers fall back to
  defaults (off). This only fails closed with the browser cache disabled (F7).
- Credential rotation accepts the old and new credential during an overlap, and restarts flagd after
  the switch; a test checks an overlapped rotation never produces a 401 poll.

**F4. Kill-switch latency at the flagd layer is the poll interval.** The worst case was about one
interval plus a few milliseconds, and nothing was missed. Because unchanged polls are 304s, a 1 s
interval is cheap. Browser latency adds the browser's own refresh path on top (F6).

**F5. The stock web provider needs bulk, and allowlist filtering makes bulk safe.** The provider's
options (`baseUrl`, `headers`, `headersFactory`, `query`, `fetchImplementation`, `pollInterval`,
`changeDetection`, `cacheMode`, …) have no single-flag mode, and its code calls only
`postBulkEvaluateFlags`. Through the filtering handler:
- the allowlisted flag targeting the session user resolves `true` / `TARGETING_MATCH` (the
  prototype let `reason` through, which SR-36 forbids; Sentinel M3, condition 2);
- the forged browser `targetingKey: "bob"` is ignored (`sl_bob_only` is `false`);
- the non-allowlisted `sl_secret_alice` resolves to its default with `FLAG_NOT_FOUND`;
- the bulk body the browser received held exactly the three allowlisted keys, with no `metadata` and
  no `eventStreams`.

The control matters: **flagd's own bulk endpoint returns every flag**, including `sl_secret_alice`, so
enumeration is closed only by the filter. flagd's OFREP port must never be reachable from a browser
(SR-36's private binding is necessary, not defence in depth). Without a host session the handler
returns 401; the provider then fails to initialise and every flag resolves to its default (fails
closed). That was shown with the cache disabled only; under the default cache mode a logged-out
first render can still show cached values (F7).

The prototype also passed flagd's ETag through. flagd computes it over the unfiltered body, so it
changes when a hidden flag's evaluation for that user changes (a side channel), and a client holding
an old ETag gets 304 after the allowlist changes and never sees a new key (Sentinel M2). The handler
must compute its own ETag over the filtered body and the allowlist version (condition 1).

**F6. flagd advertises an SSE change stream; the handler's choice decides browser kill latency.**
flagd's bulk response includes `eventStreams: [{type: "sse", endpoint: {requestUri: "/ofrep/v1/sse"}}]`,
and the provider's default `changeDetection` is `sse`. Measured from the sync-source change to the
browser seeing the flag off, with flagd polling every 1 s:

| Browser setup | Result |
|---------------|--------|
| `changeDetection: polling`, `pollInterval: 1000` | 1553 ms |
| SSE advertised by flagd but **dropped** by the handler, no polling | **never** in a foreground tab (not within 12 s). The page set `disableVisibilityRefresh: true`; by default the provider also refetches when a tab becomes visible again. It has no polling by default (`DEFAULT_POLL_INTERVAL = 0`). |
| SSE **relayed** by the handler (`GET /ofrep/v1/sse` streamed through) | 517 ms |

So bounded browser kill latency must be the **default**, not a host choice: either the handler serves
its own SSE route, or the soren-loop provider factory sets `pollInterval` (Sentinel condition 4). The
prototype's relay is not the design. It copied flagd's `eventStreams` and streamed flagd's bytes, one
upstream connection per tab with no abort on disconnect (Sentinel M1). The handler must build its own
`eventStreams` entry, hold one upstream subscription per process, check the session, and send clients
only `{"type": "refetchEvaluation"}` (condition 3). The stock provider reads only `type`, `etag` and
`lastModified` from SSE messages, so this settles the question of what flagd's messages contain: none
of their bytes reach the browser.

**F7. The provider's default cache returns a killed flag as on at startup.** The default
`cacheMode: 'local-cache-first'` stores evaluations in `localStorage`
(`ofrep-web-provider:v2:<hash>`, 30-day TTL) and resolves from it before the network. After a kill
and a reload, the flag read **on** at `ready`, then turned off on the background refresh (by the next
read here, under 50 ms on loopback; slower on real networks). A first render reads the stale value.
The cache also keeps per-user evaluations in the browser for 30 days, which SR-27 purges can't reach.
It is worse than that (Sentinel H2): the cache key is the base URL, auth headers, domain and the
**browser-side** `targetingKey`. The handler ignores that context and the session is a cookie, so two
users on one browser share a cache entry, and user B's first render can show user A's evaluations.
An earlier draft said `network-first` also avoids this; it doesn't. `network-first` still writes the
30-day cache and falls back to it on 5xx or network errors, which is exactly what F3's 503 would
trigger. **Only `cacheMode: 'disabled'` is safe**, pinned by a soren-loop provider factory
(condition 6).

**F8. flagd writes nothing to disk** (question 4). `docker diff` is empty after successful and failed
syncs, so the SR-27 purge (Task 087) needs no flagd step beyond rewriting the served document. The
browser cache in F7 is the persistence to account for instead.

## Sign-off

- **Branch:** allowlist-filtered bulk in `createOfrepHandler` (the `16` §5 default).
- **Sentinel (2026-11-14): SIGN-OFF WITH CONDITIONS.** Enumeration is closed by the filter and the
  injected `targetingKey`, and the fallback provider is not needed. The prototype is not a safe basis
  for Task 082 as written. Conditions:
  1. (082) The handler computes its own ETag over the filtered body and the allowlist version, and
     handles 304 itself; flagd's ETag never reaches the browser and the browser's `If-None-Match`
     never reaches flagd.
  2. (082) Each entry is rebuilt from an allowed field list (`key`, `value`, `variant`, `errorCode`):
     no `reason`, no `metadata`.
  3. (082) No flagd SSE bytes reach the browser: one upstream subscription per process, a session
     check, clients get only `{"type": "refetchEvaluation"}`, and streams close on disconnect and on
     session expiry.
  4. (082) Bounded browser kill latency is the default (the handler's SSE or a factory-set
     `pollInterval`): a sync change reaches a foreground tab within the flagd interval + 2 s.
  5. (082) Forwarded-request hardening: no browser headers upstream; an upstream timeout failing
     closed with a generic 503; malformed input gives 4xx/503, never a thrown 500;
     `Cache-Control: private, no-store`, no CORS headers; construction fails on an empty allowlist or
     a key outside the `sl_<random>` pattern; uniform 404 bodies.
  6. (082/087) The browser cache is disabled by a soren-loop provider factory. ST-68 adds: after a
     kill and a reload the value at `ready` is off, and on one browser profile user B never sees user
     A's evaluations. SR-27 and Task 087's docs name the provider cache.
  7. (081) Sync staleness is detected end to end with a canary flag, per flagd instance, raising a
     locked alert (SR-39(e)), and the handler returns 503 for a stale instance.
  8. (081) Credential rotation with an overlap window, then a flagd restart.
  9. (081) The sync credential is kept out of process arguments and the environment (a read-only
     config-file mount; F2 still UNVERIFIED). ST-19 adds: neither `docker inspect` nor
     `/proc/<pid>/cmdline` shows the bearer. Scope the credential to one site's document, since the
     document carries `sub` lists (Sentinel M4).
  10. (spec) ST-51 still says "the bulk path returns 404", which contradicts this branch: supersede it
      with ST-68 or rewrite it. Drop "UNVERIFIED" from SR-36 and `16` §5 in the same change.
- **Owner sign-off:** pending.

**Also raised by Sentinel (rollout semantics, not security):** in the `16` §2 document, `all` sets
`defaultVariant: "on"`, but the targeting rule's else-branch returns `"off"`, and flagd uses the
variant the targeting returns. So under `all`, users outside the target list still get off. The stub
copied that shape and the spike did not test `all`. The `16` §2 render needs fixing (for example, no
targeting rule when `all` is set).

## RFC Sections This Changes (for Arendt)

| Section | Change |
|---------|--------|
| `16` §2 | Bearer sync is supported (`authHeader`): UNVERIFIED → verified (F1); keep the credential out of process args (F2); add the stale-sync monitor and rotation overlap (F3) |
| `16` §5 | Gating question answered: bulk only, default branch confirmed (F5); handler relays or drops `eventStreams` (F6); recommended `cacheMode` (F7); the fallback provider is not needed |
| `10` §4 | Kill-switch latency: the flagd poll interval (F4), plus the browser refresh path (F6); recommend a 1 s interval |
| `10` §2 | Metric and locked alert for "no authenticated sync poll within N intervals" (F3) |
| `13` §3a T25 | Close with the default branch once the owner and Sentinel sign off |
| `16` §2 | The `all` render bug (Sentinel aside, above) |
| `06` SR-36 | Bulk confirmed (drop "UNVERIFIED"); the handler's own ETag, allowed-field rebuild, own SSE route, hardening (conditions 1–5) |
| `06` ST-51 | Contradicts this branch ("bulk returns 404"): supersede with ST-68 or rewrite (condition 10) |
| `06` ST-68, ST-19 | Both shapes pass against the prototype; add the condition 6 and condition 9 assertions (Tasks 081, 082) |
| `06` SR-27 / Task 087 | No flagd disk step (F8); name the provider cache and why the factory disables it (F7) |
| `06` SR-39(e) | Add the stale-sync canary alert as a locked kind (condition 7) |

## Reproduce

The scripts and raw evidence under `spikes/s4/` are no longer tracked. Restore them from history with `git checkout 7abb099 -- spikes/s4`.

```bash
cd soren-loop/spikes/s4        # Node 24, Docker; first run: npm install && npx playwright install chromium
node run.ts                    # all questions (about 5 minutes; latency sampling dominates)
node run.ts --only 3           # the provider and handler checks only
node run.ts --quick            # fewer latency samples
```

Exit 0: every row matches the recorded baseline. The expected values encode the behaviour above,
including F3 and F7, so a change in flagd or the provider surfaces as a failure.
