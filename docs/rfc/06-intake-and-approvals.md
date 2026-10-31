# 06. Deep Dives: Intake, Approval Gates, Step-Up, Pre-Check Orchestration

Each deep dive gives a **default**, an **alternative**, and the **second-order cost** with its
mitigation.

## 1. Intake

### 1.1 Identity (both modes)

The host backend signs a JWT with
`createWidgetToken({sub, name?, email?, emailVerified?}, {siteId, audience, key, kid})`. The
token is `sl.widget_jwt.v1` in `loop-schema` (Postel M5):

- **Header:** `alg` ∈ {`ES256`, `EdDSA`}; `kid` required; `typ: "sl-widget+jwt"` (RFC 8725
  explicit typing).
- **Claims:** `iss` = the site ID; `aud` = the **widget host origin**, the verifying endpoint
  of `/v1/widget/sessions`, as an exact string `scheme://host[:port]` with no trailing slash
  (Postel D-M4; per-install, never a shared constant; the audience is the recipient); `sub`; `iat`; `exp`; `jti`; optional
  `name`, `email`, and `email_verified` (honoured only with the site opt-in).
- The validation rules (30 s leeway, `iat` not in the future beyond the leeway,
  `exp − iat ≤ 300`, `jti` TTL = `exp` + leeway) are SR-07 as confirmed by Sentinel (ST-67).
- Rejected tokens record a reason for the owner (`05` §1.1). Integrators debug with the
  owner-only token check, `POST /v1/owner/sites/{id}/widget-token/check`.

The host page passes `getToken` to the loader. The iframe requests a token over
`postMessage` with a strict origin check, then moves to a `MessageChannel`, and exchanges the
token at `POST /v1/widget/sessions` (SR-07). Identity never comes from props, `data-`
attributes, or URLs (ST-12).

### 1.2 Form mode (default, decision 5)

**Default.** A guided form with four fields: title (≤ 120 chars), problem (≤ 2,000),
acceptance criteria (≤ 5 × 300), and "where in the app" (a site-configured select, not free
text). On submit, the server normalizes the fields, hashes them, runs **L3 inline** (PC-S,
A23-1), and returns `received` either way.

**Alternative.** A single free-text box, with structuring left entirely to `plan`.

**Second-order cost.** In form mode, the "structured request" the owner approves at G1 *is*
raw attacker text (threat model `03` §1). That puts all the weight on SR-03 (`plan` is
read-only and sealed) and on the G1 review aids. The "where" select is a small structural win:
it keeps one attacker-chosen string out of the plan prompt. Its cost is site configuration
work. Mitigation: ship a default of `["Settings", "Dashboard", "Other"]`.

### 1.3 LLM chat mode (owner API key, Phase 2, SR-30)

**Default.** A stateless Haiku-class conversation per draft, with **no tools**. The model's only
job is to fill the same four-field schema. The output is zod-validated, and the owner sees both
the transcript and the structured result at G1. On `submit`: L3 inline (PC-S), then PC-I (L1
plus L3) as an outbox job on the owner's API key, through the Messages API. There is no
`claude -p` on the server.

Spend controls: a monthly hard cap per site. When the cap is hit, the site **falls back to
form mode** and the owner is notified. There are also per-`sub` turn and token caps (T3.3).

**Alternative.** No server-side LLM. Run the structuring step inside the owner's `plan` only.
That is form mode, and it is the default for good reason.

**Second-order cost.** Two L1 implementations (server API call, CLI `claude -p`) can drift.
Mitigation: a single prompt and verdict schema in `packages/schema`, and a shared golden corpus
(ST-27, ST-30) run against both in CI. The model's chat replies render in the widget, which
makes the widget host the XSS-exposed origin (T1.4). That is exactly why it is a separate host.

### 1.4 Abuse controls at intake

SR-11 caps: 3 open requests per `sub`, plus a daily cap per `sub` and per site. Field caps. An
owner "pause intake" switch. A silent "block requester". Near-duplicate collapse in the owner
queue: a submission whose normalized `title` + `problem` match (after case-folding) an open
request from the same site within 7 days is shown grouped under it, with a
`duplicate_of` link. This is display-only; there's no state change (Zod M14). Email digests
after N per hour. The A23-8 throttle pauses a requester after 3 **requester-attributable**
flagged pre-checks in a rolling 24 h. A pause is shadow-accept, not an error (`03` §3, SR-40b).

## 2. Owner Gates

| Gate | Where | What is bound | Step-up | Review aids |
|------|-------|---------------|---------|-------------|
| **G1** request approval | Dashboard | `H_req` of the current revision | WebAuthn, UV required | Stripped and invisible characters shown; L3 flags with highlighted offsets; "what the model will see" view; for a revision > 1, a diff against the previous one; the requester's history (shown, never used to auto-approve) |
| **G2** spec approval | Dashboard | `H_spec` (which includes `H_req`) | WebAuthn, UV required | SR-22: request-to-spec diff; extracted paths, hosts, auth/session/payment/env references; policy violations **block** approval; PC-B flags |
| **G3** merge | **GitHub** (not soren-loop) | The PR head the owner reviews | GitHub's own auth | Deterministic risk summary in the PR body; a `soren-loop:careful-review` label when any heuristic fires; the PR body never claims safety (AB12) |
| **G4** rollout widening | Dashboard | Digest of the target set / percentage / `all` | WebAuthn, UV required | Time enabled for the requester; error rates if the host reports them |

**G3 is not a soren-loop ceremony.** soren-loop can't put a WebAuthn step-up on a GitHub
merge button. G3's integrity therefore rests on the fork model (the bot can't merge),
CODEOWNERS and branch rules in the owner's repo, and the merger's GitHub account security. The
consequence: under assumption A2, any collaborator who can merge can also trigger enablement
for the requester. Decision 29 (Q2) keeps automatic enablement as the default and adds two
site options: `merger_must_be_owner_login`, and `dashboard_confirm`, a +SU "accept for
enablement" step between `deployed` and the flag write.

### 2.1 No bulk, no auto

There is no bulk approve, no bulk clear (bulk *reject* is allowed), and no reputation-based
auto-approve (AB3, A23-8). Every gate action is per request and per content hash. The cost is
owner time at volume. That is intentional friction, and §6 of `12` names it as the first thing
to break at 10x.

## 3. WebAuthn Step-Up

**Default.**

- SimpleWebAuthn. `userVerification: "required"`. The challenge is **derived** from
  `(action, request_id, content_hash, nonce)` (`04` §3). The server-side record is single-use
  and expires after 2 minutes.
- **RP ID = the exact dashboard/API hostname** (for example `loop-app.example.com`), and the
  widget host must not be a subdomain of it (for example `loop-widget.example.com`, not
  `widget.loop-app.example.com`).
- Enrollment requires two authenticators, or one plus recovery codes. Adding or removing an
  authenticator is itself a +SU action. There is no email-only recovery (SR-10, T5.6).
- The session is rotated on step-up. A step-up authorizes exactly one action. There is no
  "stepped up for 5 minutes" window, because a window would let one UI-redressed click cover a
  second action (T5.1).

**Why the RP ID choice matters.** It departs from discovery Q8 ("set the RP ID to the
registrable parent domain from day one"). Per the WebAuthn spec, a page may use any RP ID that
is a registrable suffix of its own origin's host. If the RP ID were the parent domain and the
widget lived under it, script running on the widget origin (the origin most exposed to XSS via
LLM output) could start assertion ceremonies for the owner's credentials. It would still need
the owner's user verification, but it would open a UI-redress path. Pinning the RP ID to the
exact dashboard host closes that. The cost: moving the dashboard to a new hostname later means
re-enrolling passkeys. Mitigation: document the hostname choice as permanent in the setup
guide. `doctor` warns if the widget host is a subdomain of the RP ID.

**Primary control: exact origin checks (SR-29).** The RP ID is defense in depth. The primary
control is the server verifying every assertion against the **exact** dashboard origin
(`expectedOrigin: "https://loop-app.example.com"`), and never a pattern or a suffix. Sibling hosts
such as `loop-app.example.com` and `loop-widget.example.com` are **same-site**, so `SameSite`
cookies alone don't separate them. Therefore:

- Every state-changing route requires `Sec-Fetch-Site: same-origin` (Fetch Metadata). The
  value `same-site` is rejected with 403.
- Every state-changing route requires an exact `Origin` match and a CSRF token.
- The server reads only `__Host-` prefixed cookies. A cookie tossed from a sibling host
  (domain-scoped, without the prefix) is ignored.
- The widget host is never listed in WebAuthn related origins.

ST-47 covers all four, plus an assertion made from the widget origin in a test harness.

**Alternative.** TOTP or email-link confirmation. Rejected: phishable, and link scanners
prefetch links (T5.2).

**Second-order cost.** Owners on machines without a platform authenticator need a security key
or a phone (hybrid transport). Single-owner installs that lose every authenticator need the
recovery codes. Mitigation: enrollment refuses to finish without the second factor, and
`doctor` reminds the owner when only one authenticator remains.

## 4. Pre-Check Orchestration (decision 23, SR-26, A23-1 to A23-8)

The pre-check is a **block-only detector**. It can put a request into `security_hold`. It can't
approve, skip, or soften any later control, and a `clean` verdict has no effect anywhere. It is
not counted as a defense against prompt injection. L1 shares the build agent's model family, so
its failures are correlated with the agent's. L2 and L3 are the independent, deterministic
layers. The controls that bound a successful injection are the sealed sandbox, the
deterministic `submit` policy, and the owner's G2 and G3 review.

| Checkpoint | Runs where | Layers | Input | Binds | State hook |
|------------|------------|--------|-------|-------|------------|
| PC-S (A23-1) | Server, inline at submit, every mode | L3 | Normalized revision | `H_req` | Row 1 |
| PC-I | Server, outbox job, LLM mode | L1 (Messages API, owner key) + L3 | Revision plus transcript | `H_req` | Row 2 |
| PC-A | CLI, step 0 of `plan` | L1 + L2 + L3 | Revision (+ plan feedback); instruction-file diff | `H_req`, `base_sha`, trusted SHA | Row 5 |
| PC-B (A23-2) | CLI, right after spec generation, before upload | L1 + L2 + L3 | Revision plus spec | `H_req`, `H_spec` | Row 7 |
| PC-C (A23-2) | CLI, at `build` start | Verify the PC-B record; **re-run L2** against the real base | Instruction-file diff | `H_spec`, `base_sha` | Row 20 |

**L1 invocation (A23-7; SR-26a).** L1 runs as a separate `claude -p` process, **by default inside
a sealed phase-B container**; host execution is S6-gated (`15` §2, Zod M12). Its cwd is a fresh
empty directory. Its input arrives on stdin, wrapped in a fixed data fence. It runs
with the SR-01 flags and **zero tools** (`--allowedTools ""` plus a deny-all `permissions`
block; exact flag spelling **UNVERIFIED**, S6 addendum). Its output is a single JSON object
validated against the verdict schema (`additionalProperties: false`, a category enum, span
caps). Anything else, including prose around the JSON, two objects, a refusal, a timeout, or a
non-zero exit, becomes a hold: schema failures as `flagged` with
`precheck_invalid_output`, process failures as `precheck_unavailable` (ST-27, ST-29).

**L2.** `git diff --name-status <trusted_sha>..<base_sha> -- CLAUDE.md AGENTS.md '.claude/**'
.mcp.json`. Any change holds. A missing trusted commit, or one that isn't an ancestor of
`base_sha` (`git merge-base --is-ancestor`), holds (ST-31). The trusted pointer only moves
through `PUT /v1/owner/sites/{id}/trusted-commit` with +SU. Merging a bot PR never moves it.

**L3.** A deterministic rule set in `packages/schema`: invisible, bidi, and confusable
characters (mixed-script tokens); base64 or hex runs over a length threshold; URLs and
hostnames; shell-like strings (`$(`, backticks, `| sh`, `curl `, `&&`). The CLI and server
share the implementation and a corpus (ST-30).

**Rendering (A23-4, PC9).** The dashboard renders flags only as highlights at verified offsets
in the *original* normalized input. It never renders a model-written string. A clean verdict
renders as muted text: "No automated flags. This is not a safety review." It never renders as a
badge.

**Default.** All five checkpoints as above.

**Alternative.** Run L1 only on the server, on the owner's API key, in every mode. Rejected:
form mode (the default) has no key, and decision 2 forbids subscription use on the server.

**Second-order cost.** False positives are the control's main failure mode (PC2). Each one
costs a step-up clear, and a steady stream trains owners to clear reflexively. Mitigations: the
per-requester throttle; holds grouped by requester in the queue; Retry (not Clear) for outages;
a `precheck_flag_rate` metric per site and per layer from day one, with a target of under 3% of
requests. The L3 rules for URLs and shell-like strings will be the noisiest. Tune their
thresholds against real traffic in Phase 1. Don't drop them.
