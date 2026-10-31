# 07. Deep Dive: CLI (`pull`, `plan`, `build`, `submit`, machine contract)

`claude -p` hardening, the sandbox phases, `/tdd-pair` packaging and outcome handling are in
`15-sandbox-and-packaging.md`.

## 1. CLI Command Flow

```text
soren-loop login        device flow (+SU approval in the dashboard), keychain storage, pin WebAuthn keys
soren-loop doctor       environment and repo checks; refuses build without a path policy
soren-loop pull         list actionable requests (plan / build / rework / resume)
soren-loop plan <id>    verify H_req (+receipt) → export run tree → PC-A → claim → plan skill → PC-B → upload
soren-loop build <id>   verify H_spec (+receipt) → PC-C → claim → hydrate → seal → tdd-pair → checks
soren-loop submit <id>  SR-04 policy → commit → mint push token → push to fork → server opens PR
soren-loop status <id>  owner-facing detail
soren-loop mark-deployed <id> --sha <sha>   manual deploy fallback (audited)
```

Every command that changes server state sends an `Idempotency-Key` derived from
`(command, request_id, run_id)`, so re-running after a network failure is safe.

### 1.1 `pull` / `plan`

**Default.**

1. Fetch the revision, the approvals, and the policy. Recompute `H_req` with
   `@sorenai/loop-schema`. Verify the G1 receipt against the pinned keys (SR-19, MUST by decision 29 / Q7; there is no escape hatch). Never read the
   GitHub issue (SR-05).
2. Fetch `origin/<default>` into the CLI's trusted gitdir, and export `base_sha` into a fresh
   run directory with no `.git` entry (SR-28a, §1.3). The skill's headless pre-flight sees "not
   a git repo" and proceeds, which its contract allows. Branch `soren-loop/<public_ref>` exists
   only in the trusted gitdir.
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
   2. A non-zero exit, a timeout (wall clock default 90 min), the turn cap, or a stream schema
      violation in a safety-relevant event → `run_stopped{process_error}`.
   3. Otherwise, parse the outcome (`15` §4). Then **re-run the deterministic checks itself** (the
      owner-configured test, lint, and typecheck commands), inside phase B, plus the local
      SR-04 policy. All pass → `build_checks_passed`. Any fail → `run_stopped{checks_failed}`,
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
     (SR-28b, ST-41 to ST-43).
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
   `.pre-commit-config.yaml`), `.vscode/**`, `.idea/**`, `.envrc`; (b) the owner's allow
   globs, default deny; (c) no manifest or lockfile changes; (d) the flag key `sl_…` is
   referenced in code (not only in comments, using a tokenizer-level check for the repo's
   language, with a regex fallback) **and** a test exercises the flag-off path; (e) a secret
   scan of the diff, commit message, and PR body; (f) no binaries; a diff-size cap (default
   1,500 changed lines).

   Hard blocks for (a), (c), (e), and binaries have no override (decision 15). An
   out-of-eligibility path under (b) can be overridden with +SU in the dashboard. The override
   is logged and puts a `soren-loop:policy-override` label on the PR.
3. Commit with a Conventional Commit subject derived from the owner-edited title, and a body
   listing the `public_ref`, `H_spec`, and the batch names from the advisory outcome (labelled
   advisory). One commit per submit, because the owner's repo usually squashes.
4. Mint a single-use push token (`POST /runs/{id}/push-token`). It comes from the **push
   App**, scoped to the fork only, with `contents: write`, for 1 h, never `workflows` (`08`
   §1.4). The CLI treats any error as fatal. Push from the trusted gitdir to an **explicit fork
   HTTPS URL** (`https://github.com/<bot-org>/<repo>.git`), with the ephemeral token supplied
   through a CLI-owned `GIT_ASKPASS` helper, **never argv** (SR-09, T7.5). Remote config,
   `insteadOf`, and proxy settings are never consulted (SR-28c, ST-42).
5. `POST /runs/{id}/submit {head_sha, risk_summary}`. The server re-checks the pushed diff
   through the compare API against the server-checkable SR-04 rules (deny-list, manifests,
   size, binaries). This is defense in depth behind GitHub's own workflow-file rejection (S1 Q3).
   Then it opens the PR with the PR App as an outbox effect, always with
   `maintainer_can_modify: false`.

**PR body** (deterministic template fill): the repo's own PR template with soren-loop's
sections appended. The appended content is: `public_ref`, flag key, `H_spec`, the risk summary
(files outside the expected set, the dependency diff (always empty in V1), any blocked
attempts, new hosts or URLs in the diff, flag-check results, diff size), and a fixed line: "This
PR was written by an agent. Review it as untrusted code." No spec text, no requester text, and
`@`/`#` neutralized; never pre-check, hold, or clearance terms (SR-17, SR-40a).

