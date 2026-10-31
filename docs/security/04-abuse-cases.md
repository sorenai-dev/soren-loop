# Threat Model 04: Abuse Cases

Abuse cases use the system as designed, for goals the owner doesn't want. No bug is required.
Most of them succeed against a perfectly implemented system unless product policy (caps,
defaults, copy, review UX) is designed for them. Status codes R, D, and N are defined in `02`.

---

### AB1. Spam and cost exhaustion

- **Actor / goal:** A requester, or a script with many cheap host accounts (Sybil `sub`s),
  wants to burn the owner's money or attention, or bury legitimate requests.
- **Vectors:** Intake LLM spend (owner API key); email volume; DB growth; **owner attention**
  (the approval queue). The build quota is *not* directly reachable, because builds are
  owner-started (Decision 6). That decision is a strong cost control; keep it.
- **L/I:** H / M.
- **Controls:** Per-`sub` open-request cap (default 3) and per-day cap; per-site daily cap; a
  monthly intake hard cap that falls back to form mode **(R)**; field size caps; a duplicate
  and near-duplicate collapse in the queue; notification digests **(N)**; an owner "block
  requester" action that is silent to the requester **(N)**; host-side signal hooks (account
  age, plan tier passed as optional JWT claims) used only for ranking **(N)**.
- **Residual:** M. Sybil floods are bounded by per-site caps, which also starve legitimate
  users. Owners need a "pause intake" switch.
- **Detection:** Requests per site per hour, distinct `sub`s per hour, cap-hit metrics.

### AB2. Social-engineering existing flags via "already built" matching (Phase 2+)

- **Actor / goal:** A requester learns or guesses an internal feature (an admin export, a beta
  tier, a paid feature) and phrases a request so the matcher enables it for them.
- **L/I:** M / H.
- **Controls:** Only flags explicitly marked self-serve-eligible can be auto-enabled **(R)**.
  The matcher selects from that list only (enum-constrained output; it can never name a key)
  **(N)**. The self-serve mark requires step-up and defaults off for flags not created by
  soren-loop **(N)**. Paid or entitlement features must never be self-serve: entitlements
  are authz (T11.1) **(N)**. The match result is shown to the requester only after the flag
  is enabled, so a non-match is indistinguishable from "submitted" (AB6) **(N)**.
- **Residual:** L.

### AB3. Approval fatigue and needle-in-a-haystack

- **Actor / goal:** Get one malicious request through G1, G2, and G3 by surrounding it with
  plausible ones, or by making each artifact long and boring. Variant: build up a history of
  benign requests from one account, then strike.
- **L/I:** M / H. This is the most realistic route for LLM01 to succeed.
- **Controls:** Review aids at every gate (`03` §2) **(N)**. Deterministic blocking at
  `submit` means the dangerous classes (deny-listed paths, new dependencies, out-of-policy
  files) cannot be approved by fatigue alone; they need an explicit, step-up override that is
  logged **(N)**. Queue UX shows the requester's history but **does not** auto-approve on
  reputation **(N)**. No bulk approve **(N)**. Spec size caps: a spec over N lines is sent back
  as "split this request" **(N)**.
- **Pre-check (decision 23, SR-26):** lowers the likelihood that a crude payload reaches G2
  unflagged, and its deterministic layers catch hidden characters and instruction-file
  changes. It **adds** a fatigue vector of its own: forced false positives that train the owner
  to clear holds reflexively (`03` §7.3 PC2). Controls for that: a per-requester flag-rate
  throttle, bulk reject but never bulk clear, and Retry rather than Clear for outages.
- **Residual:** M. Human review quality is the last line. A pre-check false-positive rate
  above a few percent would push this towards H; measure it.

### AB4. Harassment, abusive, or illegal content in requests

- **Actor / goal:** Use the request channel to harass the owner or staff, or to place illegal
  content (including CSAM) into the owner's systems, email, or GitHub. Variant: get the
  owner's Anthropic account flagged by sending abusive content through the owner's intake key.
- **L/I:** M / H (legal exposure, account standing, staff wellbeing).
- **Controls:** Nothing is projected to GitHub before owner approval, and projection is
  minimal (T10.10) **(N)**. Request text is not inlined in email (T6.1) **(N)**. Reject plus
  block plus purge (hard-delete text, keep a tombstone for audit) **(N)**. In LLM intake mode,
  per-user caps and documented owner responsibility, with a recommendation to run a moderation
  step before the model call; whether a given provider offers one is **UNVERIFIED** **(N)**.
  A report-abuse path for hosted mode **(later)**.
- **Residual:** M. The owner still has to read it once, and stored content creates retention
  obligations.

### AB5. Requester impersonation

- **Vectors:** A leaked host signing key (T2.3); JWT replay (T2.2); host XSS (T1.1); shared
  household or company accounts; display-name spoofing (T2.6); a widget forced to send
  identity through props or URL (rejected by design).
- **Goal:** Submit requests attributed to someone else (harassment, framing), or receive
  someone else's feature enablement.
- **L/I:** M / M.
- **Controls:** As in TB2. Identity is only the verified `sub`. Requester-facing receipts show
  the request title so a victim notices **(N)**.
- **Residual:** L to M, bounded by the fact that impersonation yields only requests.

### AB6. Using the status feed for reconnaissance

- **Vectors:**
  - Owner activity timing (when stages move) → working hours, team size.
  - Rejection as a signal ("they won't build X").
  - `matched_existing` as an oracle for unreleased features (Phase 2+).
  - Sequential request IDs → request volume and customer count.
  - Flag keys and descriptions visible in client bundles or OFREP bulk responses → the roadmap.
  - Public issue projection → the roadmap and the requesters.
- **L/I:** H / L to M.
- **Controls:** Stage names only **(R)**. Random IDs **(N)**. Matching hidden behind the
  "submitted" stage **(N)**. Opaque `sl_<random>` keys, metadata server-side, no bulk
  evaluation of unrelated flags **(N)**. Minimal issue projection **(N)**. Optional coarsened
  timestamps **(N)**.
- **Residual:** L. Some timing leakage is inherent and accepted.

### AB7. Notification abuse

- **Vectors:** Phishing via an attacker-chosen title in our own trusted email (T6.1); email
  bombing (T6.2); later, **SMS pumping / toll fraud** if requester-facing SMS is ever added;
  link-scanner side effects (T5.2).
- **L/I:** M / M to H.
- **Controls:** As in TB6. SMS goes only to verified owner numbers **(R)**. Never send SMS to
  requesters. Never put tokens in SMS or email bodies **(D)**. Per-destination rate limits and
  a country allowlist if SMS lands **(later)**.
- **Residual:** L.

### AB8. Privilege change dressed as UI

- **Actor / goal:** A "show admins' view on my settings page" request that is really an
  authorization change; a "faster login" request that weakens session checks.
- **L/I:** M / H.
- **Controls:** The eligibility policy (V1: UI and read paths only, no migrations, authz, or
  billing) **(R)**, enforced **deterministically by owner-configured path globs at `submit`**
  with default deny **(N, DC3)**; G2 extraction of auth, session, and permission references
  **(N)**; "flags are not authz" (T11.1) **(N)**.
- **Residual:** M. Authz logic is not always in recognisable paths, so owners must configure
  the globs for their codebase. `doctor` should refuse to run builds when no policy is
  configured.

### AB9. Device-code and dashboard-link lures inside requests

Request text tries to get the owner to approve a CLI device code, visit a look-alike
dashboard, or "re-enroll" a passkey. Controls are in T7.1 and T6.1: flag codes and URLs in
request text, and show device-approval context. L/I: M / H. Residual: L.

### AB10. Free code generation from public repos

On a public repo, every bot PR is public. A requester can ask for generically useful code
("implement a PDF parser for the settings import") and harvest the PR, with the owner's
subscription paying. Controls: the owner gate at G1, and the eligibility policy. Document it.
L/I: M / L. Residual: L.

### AB11. Collaborator edits the issue to change what gets built

From discovery. Fully mitigated by building from the hash-pinned backend spec **(R)**, and by
never reading issue content (`03` §4). Residual: L.

### AB12. Trading on the bot's credibility

PRs from `soren-loop[bot]` carry implied endorsement ("spec-reviewed, TDD, auditor-gated").
Owners, and other reviewers on the team, may skim (`03` §2, automation bias). Controls: the
PR body states findings, not assurance; a "requires careful review" label when heuristics
fire; CODEOWNERS on sensitive paths still applies to bot PRs. Residual: M.
