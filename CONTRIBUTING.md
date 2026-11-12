# Contributing

Thanks for helping. VestLens is a small, self-hosted, **read-only** project, so the most useful contributions are bug
fixes, clearer docs, and support for reading more kinds of accounts correctly. Read [AGENTS.md](AGENTS.md) first: it
lists what the project will never do (trading, money movement, advice language, telemetry).

## Setup

You need Node 22 and Docker. `node scripts/compose-smoke.mjs` needs **Node 22.18 or newer** (it loads TypeScript
fixtures directly) and **Docker Compose 2.24.4 or newer**; it exits with a message if either is older.

```sh
npm ci
npm --prefix packages/api ci
npm --prefix packages/web ci
npm --prefix packages/widgets ci --legacy-peer-deps
npm --prefix packages/api run prisma:generate
```

The last line matters: Prisma generates its client on install only when `npm ci` runs inside `packages/api`. From the
repository root with `--prefix` it does not, and the API typecheck and tests then fail on a missing client.

## Checks

Run these before opening a pull request. They use synthetic data only.

```sh
npm --prefix packages/api test
npm --prefix packages/api run typecheck
DATABASE_URL=postgresql://synthetic:synthetic@localhost:5432/synthetic npm --prefix packages/api run prisma:validate
npm --prefix packages/web test
npm --prefix packages/web run build
npm --prefix packages/widgets test
npm test
node --test scripts/*.test.mjs
node scripts/compose-smoke.mjs   # builds and starts the Docker stack against a fake SnapTrade, then removes it, its volume and the images it built
```

## Pull requests

- Keep one change per pull request, with tests written against synthetic fixtures.
- Never include real account data, secrets or logs, in code, tests, screenshots or comments.
- Do not add a dependency that phones home. There is no telemetry here, by design.
- Describe what changed and how you checked it.

Report security problems privately as described in [SECURITY.md](SECURITY.md).
