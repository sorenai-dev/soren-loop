# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

soren-loop turns end-user feature requests into owner-approved, Claude Code-built pull requests
that ship behind a feature flag. This repo is the self-hosted control plane (a pnpm monorepo).
The CLI and Claude Code plugin live in the sibling repo
[`sorenai-dev/soren-loop-cli`](https://github.com/sorenai-dev/soren-loop-cli), checked out next to
this one at `../soren-loop-cli`.

Status: pre-release. The public plan is `ROADMAP.md`.

## Commands

Node 24 (`.nvmrc`), pnpm pinned in `package.json`.

```bash
pnpm install
pnpm run ci          # lint + typecheck + every test; the gate CI runs
pnpm test:unit       # tests that need no services
pnpm lint            # ESLint + the SHA-pin check for GitHub Actions
pnpm typecheck       # tsc -b
pnpm exec vitest run -t "T012-"   # one task's tests, by title prefix
```

Use `pnpm run ci`, never `pnpm ci` (that is pnpm's own clean-install command).

Postgres-backed tests (`@pg` in the title) skip unless `DATABASE_URL` points at Postgres 16:

```bash
docker compose -f docker-compose.dev.yml up -d
export DATABASE_URL=postgres://soren:soren@localhost:54316/soren_loop_dev
pnpm test:db
pnpm --filter @sorenai/loop-server db:migrate        # also db:rollback, db:check-reversible
```

## Layout

- `apps/server`: Fastify API, Postgres 16 via Kysely + `pg`, graphile-worker outbox (ADR 0002).
- `apps/dashboard`: the owner's single-page app (Vite).
- `packages/schema`: types and canonical hashing shared with the CLI (`@sorenai/loop-schema`).
- `packages/widget`, `packages/react`: the embeddable request widget.
- `packages/node`: server-side helpers for the host app.
- `packages/flag-adapters`: OpenFeature and flagd integration.
- `spikes/<id>/`: throwaway investigation scripts; results are written up in
  `docs/discovery/spikes/`.
- `scripts/`: repo tooling (action pin check).

## Design documents

Read these before changing behaviour; they are the contract.

- `docs/discovery/00-project-brief.md`: ratified decisions (numbered). Never contradict one.
- `docs/rfc/00-index.md` onward: the RFC. `04` data model and hashing, `05` API, `07` CLI,
  `08` GitHub and deploy, `12` plan and spikes, `15` sandbox and packaging, `16` flags.
- `docs/security/06-requirements-tests-spikes.md`: security requirements (SR-*) and tests (ST-*).
- `docs/adr/`: stack (0001) and queue (0002) decisions.

Don't edit `docs/rfc/`, `docs/discovery/` (except spike write-ups in `docs/discovery/spikes/`)
or `docs/security/` as a side effect of implementation work. Raise spec gaps with the owner.

## Conventions

- TypeScript 6.0, ESM. Relative imports use the `.ts` extension; Node runs server scripts
  directly. No enums, namespaces or parameter properties (`erasableSyntaxOnly`).
- Migrations are registered explicitly in `apps/server/src/db/migrations/index.ts` and applied in
  name order. Import `Migration`/`Migrator` from `kysely/migration`. Every migration has a `down`;
  CI checks up → down → up.
- Test DB helpers live in `apps/server/test/helpers/db.ts`: `withDb(fn)` (fresh migrated database
  per call), `openTestDb()` (empty) and `testPg(title, fn)` for `@pg` tests. Don't hand-roll skips.
- Test titles start with `[T<task id>-<n>]` plus any ST or vector IDs they cover, for example
  `[T012-8] N-10 post-15.1 code point passes nHash`.
- Tests first; assertions come from the RFC/SR/ST text, never from the implementation. Expected
  hashes are computed independently of the code under test.
- Reuse `@sorenai/loop-schema` for hashing, policy and schemas rather than re-implementing them.
- Files stay under 500 lines.
- GitHub Actions are pinned by full commit SHA (`pnpm lint` enforces it). The required check is
  the aggregate job `ci`.

## Git and publishing

- Conventional Commits. Branch from `main`; PRs land as **merge commits** (squash and rebase are
  disabled). Keep real history: don't squash or rewrite pushed commits.
- When a PR completes a roadmap item, tick its line in `ROADMAP.md` in the same PR.
- Nothing is published before the release gate (roadmap item 094-1): no npm packages
  (including prereleases), no release tags, no public images. The CLI consumes
  `packages/schema` through a `link:` to this checkout until then.
- Never commit secrets, `.env` files or private keys. GitHub App keys and other test credentials
  live outside the repo.
- Integration and end-to-end tests use only the `sorenai-dev-sandbox` GitHub orgs, never
  `sorenai-dev`.
