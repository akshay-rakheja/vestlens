# Database migrations

`migrations/0001_baseline/migration.sql` is the whole schema: the DDL `prisma migrate diff --from-empty` generates
from `schema.prisma`, plus the hand-written objects Prisma cannot declare (CHECK constraints, a partial unique index
and an expression unique index), appended at the end.

- A self-hosted install starts fresh: `prisma migrate deploy` applies the baseline to an empty database.
- Databases created by the hosted-era migrations (22 of them, 20260820104500 to 20261104120000) cannot be upgraded to
  this baseline. Their history lives in git, before the commit that replaced them.
- `scripts/baseline-migration.test.ts` applies the baseline to an empty PostgreSQL database, checks it against
  `schema.prisma` with `prisma migrate diff --exit-code`, and asserts the hand-written objects by name. It runs only when
  `BASELINE_TEST_DATABASE_URL` is set (CI's `baseline-migration` job sets it); `npm test` skips it.
- Later schema changes go in new migration folders after `0001_baseline`.
