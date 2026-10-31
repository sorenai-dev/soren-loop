# 15. Deep Dive: `claude -p` Hardening, Sandbox, `/tdd-pair` Packaging, Outcome Handling

Split out of `07` (which keeps the CLI command flows) to keep both files under 300 lines.

## 1. `claude -p` Hardening (SR-01, SR-20, SR-24)

The invocation the CLI builds for `plan` and `build`. Exact spellings are **UNVERIFIED** until
S6 runs.

```text
claude -p "<prompt>"
  --output-format stream-json --verbose
  --setting-sources user                      # no project .claude/settings*.json, no .mcp.json
  --settings '{"disableAllHooks": true, "permissions": {"deny": ["WebFetch","WebSearch"]}}'
  --plugin-dir /opt/soren-loop/plugin       # read-only mount of the CLI's own copy, hash-verified
  --disallowedTools WebFetch WebSearch
  --permission-prompts none                   # S6: must deny, not allow
  --max-turns <N>
```

The environment inside the container:

- `CLAUDE_CONFIG_DIR` points at a fresh per-run directory. Only the credential file is carried
  over (SR-24). This kills auto-memory and plugin-cache persistence across runs (T8.5).
- The CLI writes a user settings file into that directory per run.
- The only auth variable passed is `CLAUDE_CODE_OAUTH_TOKEN` (when the owner exported their own),
  or none (the owner ran `/login` inside the container's credential volume). `ANTHROPIC_API_KEY`
  is passed only in explicit API-key mode, and `doctor` warns when a stale one would silently
  win (`01` §Q1).
- Never passed: `ANTHROPIC_BASE_URL`, proxies, or any other host variable (T8.1, T8.4).

The repo's `CLAUDE.md` still loads, because conventions matter. Whether it loads under
`--setting-sources user` is the core S6 question. If it doesn't, the CLI inlines `CLAUDE.md` and
`AGENTS.md` into the prompt inside a data fence, and strips `.claude/` and `.mcp.json` from the
mount.

**Stream parsing (ADR-1).** Every line is validated against a zod schema keyed by `type`.
Unknown informational events are ignored. An unknown or malformed `result`, error, or
rate-limit event aborts the run as `process_error` (fail closed, R8). The minimum Claude Code
version is pinned in the image, and a CI matrix runs against the latest release.

## 2. Sandbox Phases (SR-02, decision 20)

**Default: two containers sharing the run tree**, rather than one container that switches
firewall rules mid-run. A fresh container per phase means the agent never runs in a container
whose firewall it could have influenced, and phase B's rules are applied by a root init step
that runs before the capabilities are dropped.

| | Phase A: hydrate | Phase B: sealed agent |
|-|------------------|-----------------------|
| Image | Reference-devcontainer-derived, pinned by digest | Same |
| Runs | `npm ci --ignore-scripts` (or the ecosystem equivalent from the lockfile only); an owner-allowlisted set of packages may run install scripts | `claude -p` (plan read-only / build read-write); the CLI's check commands |
| Egress | Registries for the detected ecosystem only | Anthropic endpoints only, from the reference firewall script; DNS restricted to the same |
| Mounts | Pristine `base_sha` export, dependency cache volume. **Produces a read-only dependency layer.** | **Exactly as SR-02 lists them:** run tree (rw for the build agent, ro for plan and for the check container), **dependency layer (ro)**, plugin (ro), and the per-run config dir with the credential (a copied file, or `CLAUDE_CODE_OAUTH_TOKEN` in the env). There is no persistent rw credential volume; S5 checks refresh behaviour (ST-65). |
| User | Non-root | Non-root `agent`; `NET_ADMIN` dropped after init; no sudo; no Docker socket; no SSH agent; no git credential helper |
| Host env | None | Only the Claude auth variable |

The run tree is an export of `base_sha` (or of the PR head for rework, `07` §1.4), so it holds
only tracked files, has no `.git` entry, and contains no untracked `.env*` files. `doctor` fails
if `.env*` files are *tracked*.

**Rules from Zod M11:**
- **Phase A only ever runs on a pristine export**, freshly produced from the trusted gitdir
  before any agent has run. An agent-touched tree never hydrates. `--resume` and rework reuse
  the hydrated dependency volume, or re-export and re-hydrate from scratch; they never
  re-hydrate the agent's tree. An agent-written `.npmrc` or lockfile therefore can't run with
  registry egress.
- **Deterministic checks run in a fresh phase-B container** over the same tree (`07` §1.2).
  Agent-spawned background processes die with the agent's container.
- **The registered flag-fixture setup file** (site config `flag_fixture_path`, `07` §1.3(d)) is
  hard-blocked from agent edits under SR-04(a). The fresh check container verifies that its blob
  hash equals the base commit's before running the flag-off test (ST-77).
- **The dependency layer is read-only in phase B** for both the agent and the check container.
  Dependencies never live inside the agent-writable run tree, so the agent can't patch the test
  runner in `node_modules` and make the fresh-container checks pass falsely (SR-02).

**Where L1 runs (Zod M12, SR-26a).** **By default, inside a sealed phase-B container**, with a
fresh `CLAUDE_CONFIG_DIR` (credential only), an empty strict MCP config (flag name
**UNVERIFIED**, in S6), no plugins, zero tools, and an empty cwd. Running L1 on the host with the
same configuration is an **S6-gated optimization**. It's enabled only once S6 shows that the
init event lists zero tools and zero MCP servers (ST-35).

**No-Docker fallback.** `@anthropic-ai/sandbox-runtime` (beta) wrapping `claude`, plus the
sandboxed Bash tool, with the same two-phase egress. It is accepted as a fallback only once S5
shows egress parity and process-wide coverage. `doctor` labels it beta (R10).

**Alternative.** A single container with an in-container firewall switch (the reference
devcontainer's pattern). Rejected as the default: the switch needs `NET_ADMIN` at some point
inside the agent's container, and the T8.3 mitigations then depend on the drop being correct
every time.

**Second-order cost.**

- Dependencies that need install scripts (native modules) fail in hydrate unless the owner
  allowlists them.
- Tests that need network fail in phase B. That is correct behaviour, but it is friction.
  Mitigation: `doctor` runs the owner's test command in a phase-B dry run at setup, so the
  owner finds out before the first build.
- DNS and Anthropic-bound exfiltration remain (decision 20, accepted). The **S7 red test**
  (ST-01 to ST-03 against the real image) gates builds: if any probe succeeds, builds stay
  disabled.

## 3. `/tdd-pair` Packaging (decisions 11 and 21, SR-20)

**Upstream.** `mandelbro/agent-workflow-kit` now contains the skill (local clone: commit
`9211bee` "add tdd-pair as a managed skill asset"; the PR is pending upstream).
`assets/skills/tdd-pair/` holds `SKILL.md`, `outcome.schema.json`, and `worked-example.md`.
`assets/agents/` holds `Ada.md` and `Zod.md`. The kit is a Python package
(`agent-workflow-kit` 0.3.0). soren-loop vendors **the asset files, not the package**.

**Vendored layout in Repo 2:**

```text
plugin/
  .claude-plugin/plugin.json
  VENDORED.json                       # {source, commit, files: {path: sha256}}
  skills/tdd-pair/SKILL.md            # vendored, unmodified
  skills/tdd-pair/outcome.schema.json # vendored, unmodified
  skills/plan/SKILL.md                # soren-loop-owned; allowed-tools: Read, Grep, Glob
  agents/ada.md, agents/zod.md        # vendored
scripts/vendor-sync.ts                # pulls a given commit, rewrites VENDORED.json, opens a PR with the prompt diff
```

- The CLI verifies every hash in `VENDORED.json` before each run, and refuses on any mismatch
  (ST-22).
- The plugin is loaded from the CLI's installed npm package (one provenance chain), never from
  the marketplace, for soren-loop builds (SC2). The marketplace stays available for
  interactive users.
- `disable-model-invocation: true` in the skill's frontmatter. Whether a namespaced skill with
  that setting runs when given as the `-p` prompt is **UNVERIFIED** (S3). If it doesn't, the
  CLI passes the vendored `SKILL.md` body as the prompt, with `$ARGUMENTS` substituted, still
  from the hash-verified file.
- The skill's `allowed-tools` pre-approves `Bash, Write, Edit, Agent, Task`. Workspace trust
  never gates a skill's `allowed-tools`, so **the sandbox, not the tool list, is the build
  boundary** (`05-supply-chain` observations). That is acceptable only with SR-02 in force.
- How plugin agents are addressed (`zod` vs `soren-loop:zod`) when the skill dispatches its
  reviewer is **UNVERIFIED** (S3). The vendored skill must not need edits to work, because an
  edit breaks the "vendored unmodified" property. If it does need one, carry it as a
  hash-recorded patch file.

## 4. Outcome Handling (SR-18)

- Extract the **last** fenced `json` block from the final `result` message (matching the kit's
  `parse_outcome`).
- Validate it against the vendored `outcome.schema.json` (ajv, strict mode). Then apply the
  **cross-field rules that the JSON Schema does not encode**. They live only in the kit's
  pydantic `model_validator` (verified in the local clone): `done` requires at least one batch,
  every batch `completed`, and no `failing_checks`; `blocked` requires `blocked_reason`;
  `needs_info` requires `spec_gaps`. A TS port in `@sorenai/loop-schema` is tested against
  fixtures generated from the kit's own test cases.
- An unknown `schema_version` counts as a **missing** outcome, not an error (Postel m3). The
  cross-field rules are proposed upstream as `if`/`then` and `contains` clauses in
  `outcome.schema.json`, so one artifact carries them (`13` §5). Until that lands, the TS port
  stays, with the shared fixtures.
- A missing or invalid outcome is not an error state of its own. Classification falls through
  to the deterministic checks, and the run lands in `stalled` unless they pass.
- The outcome's `status` drives **nothing** in the state machine. It is stored as
  `runs.advisory`. The dashboard shows it in the `stalled` view, under "Agent's own report
  (unverified)", so the owner can choose `retry`, `ask_requester`, `park_for_owner_context`, or
  `reject`. `needs_info` with `spec_gaps` is the common case where the owner then asks the
  requester. The owner writes the question; it is never copied from `spec_gaps` (LLM05).
- The kit's schema has no `rate_limited` status. The kit says rate limits and crashes "cannot
  be reported by the model; the caller detects them from the process". That matches row 8 of
  the transition table.
