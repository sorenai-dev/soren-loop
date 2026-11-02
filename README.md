# soren-loop

Feature requests from your users, built with Claude Code under your approval, rolled out behind a
feature flag. Part of the [sorenai.dev](https://sorenai.dev) suite.

> **Status:** pre-release. Nothing is published yet; see the [roadmap](ROADMAP.md).

## What it does

A user of your web app asks for a feature through an embeddable widget. You review the request in
the dashboard and approve it. The [soren-loop CLI](https://github.com/sorenai-dev/soren-loop-cli)
then has Claude Code plan and build it on your own machine, inside a sandbox, and opens a pull
request. Once you merge and deploy it, the feature ships behind a flag that you widen, kill or
restore from the dashboard, and the requester follows each stage in the widget.

Nothing moves without you: every plan and build waits for your approval, and a security pre-check
can hold a request but never approve one.

## Who it's for

Solo developers and small teams who want to act on user requests without handing an AI agent
unsupervised access to their repo or their production flags.

## Built with

TypeScript on Node 24, in a pnpm workspace:

- `apps/server`: Fastify, Postgres 16 (Kysely, graphile-worker), WebAuthn step-up, a hash-chained
  audit log.
- `apps/dashboard`: the owner's single-page app, built with Vite.
- `packages/widget` and `packages/react`: the embeddable request widget.
- `packages/node`: server-side helpers for the host app.
- `packages/flag-adapters`: OpenFeature and flagd integration.
- `packages/schema`: types and canonical hashing shared with the CLI.

## Development

Requires Node 24 (`.nvmrc`) and pnpm (pinned in `package.json`).

```bash
pnpm install
pnpm run ci        # lint + typecheck + every test (PGlite stands in for Postgres)
```

Use `pnpm run ci`, not `pnpm ci`: the bare form is pnpm's own clean-install command.

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
