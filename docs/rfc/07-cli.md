# 07. Deep Dive: CLI (`pull`, `plan`, `build`, `submit`, machine contract)

`claude -p` hardening, the sandbox phases, `/tdd-pair` packaging and outcome handling are in
`15-sandbox-and-packaging.md`.

## 1. CLI Command Flow

```text
soren-loop login        device flow (+SU approval in the dashboard), keychain storage, pin WebAuthn keys
soren-loop doctor       environment and repo checks; refuses build without a path policy
soren-loop pull         list actionable requests (plan / build / rework / resume)
soren-loop plan <id> [--recheck]   verify G1 receipt → fetch → export run tree → PC-A → claim → plan → PC-B → upload
soren-loop build <id> [--resume|--fresh|--interactive]   verify G2 (or rework) receipt → PC-C → claim → hydrate → seal → tdd-pair → checks
soren-loop submit <id>  SR-28 hygiene → SR-04 policy → commit → mint push token → fast-forward push → server re-checks, opens PR
soren-loop status <id> | gc | schema | mark-deployed <id> --sha <sha>
```

Every command emits the §2 machine contract. Idempotency keys are per logical operation (§2.4).

### 1.1 `pull` / `plan`

**Default.**

1. Fetch the revision, the approvals, and the policy. Recompute `H_req` with
   `@sorenai/loop-schema`. Verify the G1 receipt against the pinned keys (SR-19, MUST by decision 29 / Q7; there is no escape hatch). Never read the
   GitHub issue (SR-05).
2. Fetch `origin/<default>` into the CLI's trusted gitdir (SR-28c, T24):
   - **Default:** the owner's own git credential, used only for `git fetch` of the exact
     upstream HTTPS URL into the trusted gitdir. The server mints no repo-read capability, so a
     stolen CLI token gains nothing.
   - **Fallback**, when the owner has no usable credential: the server-minted read-only PR App
     token (`POST …/fetch-token`; `05` §1.3). It requires a DPoP-bound CLI token, and it is
     supplied through the CLI-owned `GIT_ASKPASS` (ST-75).
   - Neither credential ever enters the sandbox.

   Then export `base_sha` into a fresh run directory with no `.git` entry (SR-28a, §1.3). The
   skill's headless pre-flight sees "not a git repo" and proceeds, which its contract allows.
   Branch chains `soren-loop/<public_ref>/<chain>` exist in the trusted gitdir and on the fork
   (`03` row 23).
3. **PC-A**: L3 and L1 over the revision; L2 over `trusted_sha..base_sha`. Post the record. A
   flag or an error stops here, and the server moves the request to `security_hold`.
4. Claim the plan lease (`POST /runs`).
5. Run the `plan` skill in the **sealed** sandbox (phase B only; planning needs no hydrate).
   The run tree is mounted **read-only**. The skill's `allowed-tools` is `Read, Grep, Glob`
   (decision 22, SR-03). The spec comes back as the final message, inside a fenced markdown
   block. There is no Write tool at all, which makes "no write outside the spec file" true by
   construction instead of by path rules.
6. Extract and normalize the spec, and compute `H_spec`. Run **PC-B** over revision plus spec.
   Upload the spec together with the PC-B record (one call, so the server never holds a spec
   without its pre-check, ST-40).

**Alternative.** Run `plan` unsandboxed, but with read-only tools. Rejected: in form mode the
plan input is raw attacker text, and tool restrictions alone don't stop repo-supplied
execution (T8.1) or egress.

**Second-order cost.** A cold container start for every plan (the S5 timing question).
Mitigation: reuse the per-repo image, and start the container only after PC-A passes.

### 1.2 `build`

**Default.**

1. Fetch the spec. Recompute `H_spec` and check that its parent is the current `H_req`. Verify
   the G2 receipt.
2. **PC-C**: verify that a PC-B record exists for this `H_spec`, then `git fetch` and re-run L2
   against the base the build will actually use. If `origin/<default>` moved since `plan`,
   re-export the run tree at the new base *before* the agent runs (nothing has been written
   yet, so nothing is lost) and run L2 on the new base (A23-2, ST-40).
3. Claim the build lease. Start a heartbeat.
4. **Phase A (hydrate)**, then **phase B (sealed)**: `15` §2.
5. In phase B, run `claude -p` with the `15` §1 flags and the prompt
   `/soren-loop:tdd-pair auto --headless <spec-path>`. The CLI writes the spec file to
   `.soren-loop/spec.md` inside the run tree. That path and `.claude/tdd-state*` are in the
   CLI's own excludes for file selection (§1.3), so neither is ever committed.
6. On process exit, classify in this order, from the process and never from model text:
   1. A rate-limit signal in the stream, or the documented exit path → `rate_limited{resets_at}`
      (S2).
   2. A non-zero exit, the turn cap, or a stream schema violation in a safety-relevant event →
      `run_stopped{process_error}`. The wall-clock cap (default 180 min, configurable) →
      `run_stopped{timeout}`. `build --resume` continues a timed-out run on its preserved tree
      instead of restarting (Zod m5).
   3. Otherwise, parse the outcome (`15` §4). Then **re-run the deterministic checks itself**
      (the owner-configured test, lint, and typecheck commands) in a **fresh** phase-B
      container over the same tree, never in the agent's container, so leftover agent processes
      can't tamper with the results (Zod M11). Then run the local SR-04 policy. All pass → `build_checks_passed`. Any fail → `run_stopped{checks_failed}`,
      with the advisory outcome attached for the owner to read (ST-21).
7. `--resume` after `paused_rate_limited` re-claims the lease, keeps the run tree, and invokes
   `/soren-loop:tdd-pair resume --headless` (the skill's state file survives in the
   run tree).

**Alternative.** Trust the outcome's `done` and skip re-running the checks. SR-18 rules this
out. **Second-order cost:** the test suite runs twice. The owner can scope the CLI's check
commands, and it's worth paying, because it's the only evidence that isn't model-reported.

**Rate limit and decision 6.** The default on `rate_limited` is to **exit** with `resets_at`
printed. The owner re-runs `build --resume`. A foreground `--wait` that sleeps until
`resets_at` and resumes would be convenient, but it starts to look like the unattended gray
zone (a′ in `01` §Q1). Decision 29 (Q4) allows it in Phase 2 only, as an opt-in flag on an
owner-started run, capped at one resume per invocation.

**`build --interactive` (decision 27).** The owner sits in the auditor's chair:
`/soren-loop:tdd-pair start .soren-loop/spec.md` runs in `claude` (not `-p`), attached to the
owner's terminal through `docker run -it` into the **same** phase-B container. Steps 1 to 4
(the `H_spec` and receipt checks, PC-C, the lease, hydrate then seal), the `15` §1 flags (only
`--output-format` and `--permission-prompts none` are dropped, because a human now answers
prompts; the deny rules still win), the SR-28 run tree, and the step-6 deterministic checks are
identical. Only the auditor changes. What differs follows from that:
- There is no outcome JSON, so classification goes straight from process exit to the checks.
- Rate limits aren't machine-detected. On a non-zero exit, the CLI asks the owner whether the
  session hit a usage limit. A "yes" is an owner-declared `rate_limited` with no `resets_at`.
- The skill's commit offer fails harmlessly, because the run tree has no `.git`. Commits stay
  in `submit`.
- The wall-clock cap is 4 h by default, and the heartbeat continues while the session is open.
- The CLI relays the TTY through a filtering PTY wrapper (SR-38, ST-70). It strips OSC
  (including OSC 52 clipboard writes), DCS, APC, PM, and **every non-SGR CSI**: terminal queries
  would make the terminal type replies into stdin, and cursor movement can hide text from the
  reviewing owner. A bare `\r` that would overwrite a line is rendered as a visible break. Only
  SGR styling passes through. The wrapper stays until ST-70 shows the TUI strips these itself.
- `--interactive` is refused under `--agent` (exit 2).

### 1.3 `submit`

**Default.** It runs on the host, outside the sandbox, with no LLM:

1. **Host-side git and tree hygiene (SR-28).** The agent had write access to the tree. Anything
   host-side git reads from that tree (a `.git` entry, config includes, attribute drivers,
   symlinks) could become code execution or file disclosure on the host. So:
   - The tree never contains a gitdir. The CLI exports `base_sha` from its own **trusted
     gitdir** (`~/.soren-loop/git/<repo>.git`, a bare clone the CLI owns) into a CLI-owned
     run directory `~/.soren-loop/runs/<run_id>/tree` that has **no `.git` entry** (SR-28a,
     e). The sandbox mounts only that plain tree, so no gitdir of the owner's repo, per-worktree
     or common, is ever visible to the agent (ST-46).
   - Every host git command in `submit` (and `inspect`) runs with the trusted
     `--git-dir`, `--work-tree=<run tree>`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL`
     pointing at a CLI-owned minimal file (the owner's identity and opt-in signing settings
     only), `GIT_TERMINAL_PROMPT=0`, no pager, and `-c core.hooksPath=/dev/null -c
     core.fsmonitor=false -c protocol.file.allow=never -c protocol.ext.allow=never`
     (SR-28b, ST-41 to ST-43). Commits are **authored** by the push App's bot identity and
     **committed** by the owner (optional signing), so attribution is honest (Zod m12).
   - The CLI walks the tree with **lstat only** and never follows symlinks. New symlinks,
     gitlinks, FIFOs, devices, and `.git`-equivalent path components (`.GIT`, `git~1`,
     ignorable code points) are hard-blocked (SR-28d, ST-44).
   - If a `.git` entry appears in the run directory, or a pre-run hash doesn't match after the
     run, `submit` hard-fails and quarantines the tree (SR-28e).
   - **File selection uses the base commit's ignore rules.** The CLI decides which files to stage
     from `.gitignore` as it was at `base_sha` in the trusted gitdir, never the tree's current
     ignore files, plus the CLI's own excludes (`.soren-loop/`, `.claude/tdd-state*`). A file
     ignored at base stays out even if the agent un-ignores it (ST-45).
2. Compute the diff against `base_sha`. Apply SR-04: (a) the deny-list, including `.github/**`,
   `.claude/**`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `.devcontainer/**`, `CODEOWNERS`,
   `.gitattributes`, `.gitmodules`, `.npmrc`, `.yarnrc*`, `.husky/**`, Dockerfiles, and CI and
   build config, plus Sentinel's additions: `.git` in any path component (case-insensitive,
   after Unicode normalization), `.gitignore`, hook-manager configs (`lefthook*.yml`,
   `.pre-commit-config.yaml`), `.vscode/**`, `.idea/**`, `.envrc`, and the **registered
   flag-fixture setup file** (`flag_fixture_path`, ST-77); (b) the owner's allow
   globs, default deny; (c) no manifest or lockfile changes, with no exception (decision 16);
   (d) **the flag gate, defined deterministically (Zod M8):** the key `sl_…` appears in a
   non-comment token of a changed source file (a tokenizer per supported language, and the
   check fails closed for unsupported languages), **and** a changed test file references the
   key, **and** the owner's test command passes in a fresh phase-B container with the key
   forced to `false` by **OpenFeature's own `InMemoryProvider`** (Zod D6). The CLI passes
   `SL_FLAG_FIXTURE=<path>` (a JSON file `{"sl_…": false}`). The owner adds a test-setup file
   once, at onboarding, that reads it and installs the provider. The file's path is **registered
   in site config with +SU** (`setting = flag_fixture_path`) and is hard-blocked from agent edits
   under SR-04(a). The checks verify that its blob hash equals the base commit's, so an edit
   can't make the gate pass vacuously. `doctor` checks that the file exists **and that its hash
   matches the registered path's blob at the default branch head** (Zod R2). No `@sorenai`
   package may honour the variable (SR-04, ST-77), so there is no SDK bypass and no new
   dependency (the SDK is already a Q14 prerequisite); (e) a secret
   scan of the diff, commit message, and PR body; (f) no binaries; a diff-size cap (default
   1,500 changed lines).

   Hard blocks for (a), (c), (e), and binaries have no override (decision 15). An
   out-of-eligibility path under (b) can be overridden with +SU in the dashboard. The override
   is logged and puts a `soren-loop:policy-override` label on the PR.
3. Commit with a Conventional Commit subject derived from the owner-edited title, and a body
   listing the `public_ref` and `H_spec`. One commit per submit.
4. Mint a single-use push token (`POST /runs/{id}/push-token`). It comes from the **push
   App**, scoped to the fork only, with `contents: write`, for 1 h, never `workflows` (`08`
   §1.4). The CLI treats any error as fatal. Push from the trusted gitdir to an **explicit fork
   HTTPS URL** (`https://github.com/<bot-org>/<repo>.git`), with the ephemeral token supplied
   through a CLI-owned `GIT_ASKPASS` helper, **never argv** (SR-09, T7.5). Remote config,
   `insteadOf`, and proxy settings are never consulted (SR-28c, ST-42).
5. Push **fast-forward only** to this run's chain branch `soren-loop/<public_ref>/<chain>`.
   A build from base starts a new chain, and a rework run continues its chain (`03` row 23,
   Zod D3). The CLI never force-pushes, and a rejected non-fast-forward is exit 6. The CLI
   **revokes the push token right after the push** (SR-09). Then
   `POST /runs/{id}/submit {head_sha, risk_summary}`:
   - The server checks the chain branch head against `head_sha`, as declared at mint time.
   - `gh.open_pr` re-checks the **cumulative** diff `compare(original base_sha ... chain
     head)`, then opens or updates the PR and **pins `head_sha`** (SR-41), or it reports
     `submit_rejected` (row 39).
   - If the push fails after the mint, the CLI calls `push-token {replace: true}` once (capped
     at 2 per run, `04` §5).
   - `submit` then **waits** (§2.1) instead of exiting on the `202`.

**PR body** (deterministic template fill): the repo's own PR template with soren-loop's
sections appended. The appended content is: `public_ref`, flag key, `H_spec`, the risk summary
(files outside the expected set, the dependency diff (always empty in V1), any blocked
attempts, new hosts or URLs in the diff, flag-check results, diff size), and a fixed line: "This
PR was written by an agent. Review it as untrusted code." No spec text, no requester text, and
`@`/`#` neutralized; never pre-check, hold, or clearance terms (SR-17, SR-40a).


### 1.4 Rework Runs (`changes_requested` → `build`; Zod B5)

| Question | Contract |
|----------|----------|
| Instructions | Only owner-approved feedback: +SU `rework.approve` over `sl:rework:v1(h_spec, h_fb)`. The CLI verifies that receipt before running (`17` §1). A GitHub review on its own steers nothing (`03` row 24). |
| Run tree | An export from the trusted gitdir at the **recorded, pinned `head_sha`** (SR-41, ST-74; `runs.tree_source = pr_head`), never at a fetched fork head. If the commit is missing locally (on another machine), the CLI fetches **that SHA** from the fork with a push App token **down-scoped at mint to `{contents: read}`**, 1 h, audited (Zod m5), and verifies the object ID. Hydrate still comes from the pristine `base_sha` export (SR-02). |
| Base and PC-C | The run keeps the PR's original `base_sha`. PC-C runs L2 over `trusted_sha..base_sha`. The bot's commits can't touch instruction files (deny-list). |
| Push | Fast-forward onto the active chain's branch. The server's re-check covers the cumulative diff from the original base. The pin moves to the new head (SR-41). |
| Upstream moved, conflicts, or a rejected first submit | There is no rebase in V1. `build --fresh` is allowed from any build-start state (`plan_approved`, `changes_requested`, `stalled{build}`). It exports the current `origin/<default>`, runs a full build, and starts a **new chain**. The server opens the new PR, then supersedes the old one: it closes it with a link and revokes its tokens, and `request_prs` records both (`03` rows 23, 40, 46; Zod D1, D3). There is never a force-push. Superseded chain branches are deleted from the fork after 30 days. |
| Context on `retry` | `stalled` keeps `feedback_id` and `rework_of`. `retry` routes by whether `request_prs` has an **active open PR** (`03` row 12, Zod D3) |

## 2. CLI Machine Contract (Postel B4)

### 2.1 Exit Codes

| Exit | Meaning | What an agent should do |
|------|---------|-------------------------|
| 0 | Success. For async operations, `result.pending: true` means the outcome isn't known yet. | Proceed, or run the `next` step (`status --wait`) |
| 1 | Internal error (a CLI bug), with `trace_id` where one exists (Postel d3) | Escalate |
| 2 | Usage error, or an interactive requirement under `--agent` | Fix the arguments |
| 3 | Auth required, revoked, or expired | `soren-loop login` (a human) |
| 4 | Not found or not permitted | Abort |
| 5 | `409 invalid_transition` | Read `allowed_actions` and `next` |
| 6 | Policy hard block (SR-04, SR-28, or a non-fast-forward push) | Abort; the owner reviews |
| 7 | The request entered `security_hold` | Owner action in the dashboard |
| 8 | Verification failure (`receipt_invalid`, an `H_*` mismatch, a `VENDORED.json` mismatch, a backward audit head) | **Never retry**; escalate |
| 9 | Claude rate limit | `build --resume` after `resets_at` |
| 10 | Deterministic checks failed | The owner reviews: `retry` or `reject` |
| 11 | Agent process error, timeout, `lease_lost`, or `cancelled` | The owner reviews |
| 12 | Server unreachable, or `5xx` | Retry with backoff |
| 13 | `cli_too_old` / `server_too_old` (a missing capability) | Upgrade |

Exit codes are a versioned surface, with a deprecation window of ≥ 1 CLI major (`05` §4).

**Async outcomes (Postel D-M3).** `submit` polls `GET /v1/cli/requests/{id}` for up to
`--wait-seconds` (default 120):
- `in_review` → exit 0, with `result: {pr_number, public_ref}`;
- `submit_rejected` / `pr_open_failed` → exit 6 / 11, with the problem document;
- a timeout → exit 0, with `result: {pending: true}` and
  `next: [{argv: ["soren-loop", "status", "<full id>", "--wait"]}]`.

`status <id> --wait [--until <state>]` has the same semantics. This is the general pattern for
any `202` the CLI receives.

### 2.2 Output

- `--output text|json`. JSON is the default when stdout isn't a TTY, or when `CI` is set.
- **stdout** carries exactly one document: `{schema: "sl.cli.result.v1", command, ok,
  exit_code, subject: {type, id}, run_id, state, result, advisory: {untrusted: true, …} | null,
  error: <RFC 9457 problem> | null, next: [{argv, reason}]}`. `next` is **never** derived from
  `advisory`, because model-written `spec_gaps` must not steer an agent driving the CLI (Postel
  m3, LLM01).
- **stderr** carries progress and warnings, as NDJSON under JSON output:
  `{event: "step", step: "pc_a", status: "passed"}`.
- `soren-loop schema` prints the JSON Schema for every command result and the error-code list.
- `doctor --output json` emits stable check IDs (`doctor.widget_rp_subdomain`,
  `doctor.pr_app_contents_above_read`, …).

### 2.3 `--agent`

`--agent` implies JSON output, never prompts, and fails with exit 2 wherever a prompt would
occur.

### 2.4 Idempotency on the CLI (Postel B2)

The CLI generates a UUIDv7 per **logical operation** and stores it in
`~/.soren-loop/ops/<command>-<subject_id>.json` (Postel d2):
- A **terminal** response (any stored `2xx` or final `4xx`) deletes the file.
- A plain invocation **reuses** an existing non-terminal file for the same
  `(command, subject.id)`, meaning a crash or network loss happened before any response, so the
  server's lock row and the key still match.
- After a terminal response, the next invocation mints a new key. A deliberate re-run (for
  example, `submit` after the owner fixes the tree) therefore never hits
  `422 idempotency_key_reused`, and a retry after a crash never double-applies.
