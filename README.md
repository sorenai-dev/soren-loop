# soren-loop

Feature requests from your users, built with Claude Code under your approval, rolled out behind a
feature flag. Part of the [sorenai.dev](https://sorenai.dev) suite.

> **Status:** pre-release. Nothing is published yet.

## Development

Requires Node 24 (`.nvmrc`) and pnpm (pinned in `package.json`).

```bash
pnpm install
pnpm ci            # lint + typecheck + every test (PGlite stands in for Postgres)
```

Server tests that need real Postgres concurrency are titled `@pg`. They are skipped, with the
reason shown, unless `DATABASE_URL` points at Postgres 16:

```bash
docker compose -f docker-compose.dev.yml up -d
export DATABASE_URL=postgres://soren:soren@localhost:54316/soren_loop_dev
pnpm test:db
```

Design documents live in [`docs/`](docs/): the RFC in `docs/rfc/`, the threat model in
`docs/security/`, and architecture decisions in `docs/adr/`.

## License

[Apache-2.0](LICENSE)
