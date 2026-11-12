# Contributor rules

VestLens is a self-hosted, read-only portfolio viewer. These rules apply to every contributor, human or AI.

- **Read-only, always.** Never add trading, order placement or cancellation, transfers, account opening, recurring
  investments or any other money movement, and never call SnapTrade endpoints that do. The SnapTrade client exposes read
  methods only; keep it that way.
- **No advice language.** VestLens describes what an account holds and how it has moved. It never tells anyone what to
  buy, sell or hold, and its copy must not read like a recommendation.
- **No telemetry.** No analytics, tracking, crash reporting or calls to vestlens.com. The only outbound calls are to
  SnapTrade, the market-data sources (Yahoo Finance, Stooq, Bank of Canada) and, with `NEWS_ENABLED`, the news sources
  (Marketaux, TypeSafe, SEC EDGAR, article thumbnails). Keep the README's "What it contacts" table accurate, and do not
  add a new outbound host without updating it. Send ticker symbols only, never account numbers or amounts.
- **Never commit secrets or real portfolio data.** That means `.env` files, keys, tokens, passwords, database dumps,
  logs, screenshots or documents with real account details. Do not print them in issues, pull requests or test output.
- **Tests use synthetic fixtures.** Use invented data (see `packages/api/src/testing/synthetic-fixtures.ts`). Tests never
  reach a real brokerage or SnapTrade account.
- **Keep the brand and the numbers honest.** The name is spelled "VestLens". Use brokerage-reported totals, keep native
  currencies visible, and show converted amounts as estimates with their rate date.
- **One owner, one instance.** There is no multi-user mode. Do not add one without a design discussion.
- **Run the checks before a pull request** (Node 22):
  - API: `npm --prefix packages/api test`, `npm --prefix packages/api run typecheck`, and `npm --prefix packages/api run prisma:validate` with a placeholder `DATABASE_URL`.
  - Web: `npm --prefix packages/web test` and `npm --prefix packages/web run build`.
  - Widgets: `npm --prefix packages/widgets test`.
  - Browser login (Chromium, synthetic server): `npm --prefix packages/web run test:e2e` after `npx playwright install chromium`.
  - Root: `npm test` (this runs `node --test scripts/*.test.mjs`).
  - Docker stack (needs Docker): `node scripts/compose-smoke.mjs`.
