# 17. Approval Receipts and Retention

This was split out of `04` to keep both files under 300 lines. The hash prefixes and framing
used here are defined in `04` §3.

## 1. Approval Receipts (SR-19, MUST-MVP by decision 29 / Q7)

At `soren-loop login`, the CLI fetches the owner's authenticator public keys, plus the
dashboard origin and RP ID, shows their fingerprints, and pins them. A key added later is
pinned only after the CLI verifies the `authenticator.add` receipt, which must be signed by an
already-pinned key, at the next `login` or `pull`.

**What the CLI verifies, and when.**

| Before | Receipt | `content_hash` the CLI recomputes |
|--------|---------|-----------------------------------|
| `plan` | G1 / G1′ (`request.approve`) | `H("sl:g1:v1"; h_req, eligibility_class)` from the fetched revision (Zod B4) |
| `build` | G2 (`spec.approve`) | `H_spec` from the fetched envelope |
| `build` from `changes_requested` | Rework (`rework.approve`) | `H("sl:rework:v1"; h_spec, h_fb)` (Zod B5) |
| Any checkpoint where a **local** PC-A or PC-C check flags but the server reports a covering clearance | Hold clear (`hold.clear`) | `H("sl:hold_clear:v1"; …)` from the local verdict and fingerprint (Zod M9) |

**Steps, for each receipt:**

1. Recompute `content_hash` locally, as in the table.
2. Recompute the challenge as `H("sl:webauthn:v1"; action, JCS(targets), content_hash,
   nonce)`.
3. Check that `clientDataJSON.challenge` equals it, that `type` is `webauthn.get`, and that
   `origin` is the pinned dashboard origin.
4. Check that `authenticatorData.rpIdHash` equals `SHA256(pinned RP ID)` and that the UV flag
   is set.
5. Verify `signature` over `authenticatorData || SHA256(clientDataJSON)` with a pinned key.

Any failure exits with code 8 (`receipt_invalid`; `07` §2). There is no override and no retry.
A compromised server or DB can't forge an approval, a clearance, or rework instructions without
the owner's authenticator (T7.3). It can still withhold work. That residual is accepted.

Test coverage: vectors R-01 to R-08 (`04` §3.5); **ST-63** (forged receipts, one per step);
**ST-64** (hold laundering through a server-claimed clearance); **ST-74** (rework receipts).
The pin set grows only through a receipt from an already-pinned key (SR-19).

## 2. Retention (SR-27, decision 19; Zod M7)

**Clocks.**
- `purge_after = closed_at + 90 d`, or immediately on a deletion request.
- For a live feature, `text_purge_after = enabled_at + 90 d` (decision 29, Q10). The `sub`
  stays in the flag targets while the feature is live.

| Store | What is PII or request text | Rule |
|-------|------------------------------|------|
| `request_revisions.fields`, `questions.body`, `feedback.body`, `specs.envelope.body_md` | Request text, plus spec text that can echo it | Deleted at `text_purge_after` or `purge_after`, whichever comes first |
| `runs.advisory` | Model `spec_gaps` and findings that echo request text | Deleted with the text |
| `requesters.sub`, `display_name`, `email_enc` | Identity and address | Replaced with a tombstone ID at `purge_after`. `email_enc` is also deleted when the site turns off `requester_email_enabled`. |
| `flags.targets` and the rendered flagd document | `sub`s | A `FlagWriter` effect removes the `sub` at `purge_after`, and the document re-renders. flagd keeps no history, because it is served from the DB (S4 verifies no on-disk cache). |
| `outbox.payload` | None by design (`04` §5) | `suppressed` and `done` rows are deleted after 30 days |
| `idempotency_keys.response` | Can echo submitted text | Expires after 24 h; a sweeper deletes it |
| `inbox_items` | The fixed title (the owner-edited title) | Deleted with the request text |
| CLI `~/.soren-loop/runs/<run_id>/` (tree, `.soren-loop/spec.md`, logs) | Spec and request text on the owner's disk | `soren-loop gc` runs at the start of `pull` and deletes run directories whose request has a server purge tombstone, or that are older than 30 days after the request closed |
| CLI `~/.soren-loop/ops/` (idempotency op files, `07` §2) | IDs only | Deleted when the operation is terminal |
| GitHub PR, commit, and issue text | The owner-edited title and the diff | Outside soren-loop's control. Documented: the owner edits the title before projection, and closed PRs remain on GitHub. |

**Kept:** IDs, all hashes, transitions, approvals (assertions carry no PII), clearances,
prechecks (offsets only), audit events and chain heads.

**ST-38** extends to every row of the table, including removal of the `sub` from the flagd
document and the CLI `gc`.
