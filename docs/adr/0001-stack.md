# ADR 0001: Implementation Stack

- **Status:** Accepted
- **Date:** 2026-11-02
- **Decision source:** project brief decision 35; RFC `02` §6, `10` §6

## Context

The control-plane monorepo (`sorenai-dev/soren-loop`) and the CLI repo (`sorenai-dev/soren-loop-cli`)
need one toolchain, so that both repos run the same single `ci` check and every task brief can
name the same commands.

## Decision

| Concern | Choice | Version line |
|---------|--------|--------------|
| Runtime | Node.js LTS, pinned in `.nvmrc` | 24 (Krypton) |
| Package manager | pnpm workspaces, pinned through `packageManager` | 11.x |
| Language | TypeScript, strict, `nodenext` modules, erasable syntax only | 6.0.x |
| HTTP server | Fastify | 5.x |
| SQL | Kysely with `pg`; migrations through Kysely's `Migrator` | 0.29.x |
| Tests | Vitest, one project per package, titles tagged `[T<id>-<n>]` | 5.x |
| Front-end build | Vite (dashboard, widget) | 8.x |
| Lint | ESLint flat config with typescript-eslint | 10.x / 8.x |
| Test database | Postgres 16 when `DATABASE_URL` is set; in-process PGlite otherwise | 16 / 0.5.x |

Source files import each other with the `.ts` extension (`rewriteRelativeImportExtensions`), so
Node runs scripts such as `db:migrate` directly through type stripping, with no build step.
`erasableSyntaxOnly` keeps every file strippable (no enums, namespaces or parameter properties).

## Consequences

- **TypeScript stays on 6.0** until typescript-eslint supports 7.x (its peer range today is
  `<6.1.0`). Moving to 7.x is a separate ADR once lint support lands.
- **Node 24, not 26.** Node 26 became the active LTS in October 2026. Node 24 is still a supported
  LTS line through April 2028, and it is what the owner's machine and the Taiga sandbox already run.
  Revisit at the go-public gate (Task 094-1).
- `tsc -b` emits declarations only, so `typecheck` never writes JavaScript next to the tests.
  Publishable packages add their own build when their packaging tasks land.
- PGlite gives most server tests a service-free path. Tests that need real Postgres concurrency
  are titled `@pg` and are skipped with a visible reason under PGlite. CI always runs them, with
  `SL_REQUIRE_PG=1`, against a Postgres 16 service.
- The queue library is decided separately (ADR 0002).
