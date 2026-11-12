# Host VestLens on Render

This guide puts VestLens on [Render](https://render.com) so it has an https address and runs without your computer.

**Checked on 2026-11-11.** Prices below are "as of 2026-11-11", gathered from Render's published figures and third-party
summaries; confirm them on [render.com/pricing](https://render.com/pricing) before you sign up.

## Why Render

I compared Railway, Render and Fly.io on 2026-11-11:

- **Render**: builds straight from a Dockerfile in a Git repo, has managed PostgreSQL, bills fixed monthly prices per
  service (easy to predict), and an always-on paid web service keeps the in-process nightly refresh running.
- **Railway**: also works, but is usage-billed (a $5 monthly minimum plus metered CPU, memory and storage), so the
  bill is harder to predict. Sources I found disagreed on its free tier.
- **Fly.io**: its managed Postgres starts around US$38 a month, far more than a single-owner app needs. Its older
  unmanaged Postgres means doing backups and failover yourself.

Render's free tier is not suitable: free web services sleep after 15 minutes without traffic (the refresh would not
run), and free Postgres expires after 30 days.

## Cost estimate (as of 2026-11-11)

| Item | Approx. per month (USD) |
| --- | --- |
| Web service, Starter (512 MB RAM) | $7 |
| PostgreSQL, Basic-256mb | $6 |
| Storage above the plan's included amount | about $0.30 per GB |
| Workspace, Hobby | $0 |
| **Total** | **about $13** |

Render's own cost article (July 2026) gives about US$13 a month for this pairing before bandwidth and storage growth.
Currency is USD; taxes and bandwidth are extra. A larger plan may be needed if memory runs short.

## Steps

**Steps marked HUMAN need you personally** (accounts, payment, dashboard login). An agent can run the rest, but must not
print `.env` values.

Before you start you need a working local setup (`.env` from `npm run setup`, see the README), plus:

- **HUMAN:** a Render account with a payment method, and a GitHub account.
- A **private** GitHub copy of this repository. A fork of a public repository cannot be private, so create a new empty
  private repository (HUMAN, on github.com) and push your clone to it:

  ```sh
  git push https://github.com/<you>/<your-private-repo>.git HEAD:main
  ```

  Never make that copy public: it must not contain your `.env` (git ignores it, so a plain push does not include it).

1. **Create the database (HUMAN).** In Render, create a **PostgreSQL** instance (Basic-256mb) in the region closest to
   you. Keep its **Internal Database URL** and **External Database URL** handy.
2. **Create the web service (HUMAN).** New, **Web Service**, connect your private repository, set **Language** to
   **Docker** (the root `Dockerfile`). Render builds the last stage, `production`, which is the app. Choose an
   always-on paid instance type (Starter).
3. **Set the health check path** to `/health`.
4. **Set environment variables** on the web service (HUMAN, in Render's dashboard; do not paste them anywhere else):

   | Variable | Value |
   | --- | --- |
   | `APP_BASE_URL` | Your https address: the `https://<name>.onrender.com` URL Render gives the service, or your own domain once you add one. No trailing path. |
   | `TRUST_PROXY` | `1` (Render's router is one proxy hop in front of the app) |
   | `DATABASE_URL` | The **Internal Database URL**, as is (`connection_limit` defaults to 5; leave it out, or set 3 to 10) |
   | `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` | From your SnapTrade account |
   | `OWNER_PASSWORD_HASH`, `SESSION_SECRET`, `MCP_GATEWAY_SIGNING_KEY` | The values `npm run setup` wrote to your `.env`, **without the quotes** (see below) |

   Render sets `PORT` itself; the app listens on it.

   **The quoting trap.** In `.env` the hash and the signing key are wrapped in single quotes (`OWNER_PASSWORD_HASH='scrypt$...'`)
   so Docker Compose reads them literally. Render's dashboard takes the value as typed, so those quote characters would
   become part of the value and sign-in would fail. Paste only what is between the quotes. To copy a value to your
   clipboard already unquoted, without printing it, run this on macOS (it strips the name and one pair of surrounding
   single quotes), then paste into Render; repeat with each name:

   ```sh
   grep '^OWNER_PASSWORD_HASH=' .env | cut -d= -f2- | sed "s/^'//; s/'\$//" | tr -d '\n' | pbcopy
   grep '^SESSION_SECRET=' .env | cut -d= -f2- | sed "s/^'//; s/'\$//" | tr -d '\n' | pbcopy
   grep '^MCP_GATEWAY_SIGNING_KEY=' .env | cut -d= -f2- | sed "s/^'//; s/'\$//" | tr -d '\n' | pbcopy
   ```

   On Linux, replace `pbcopy` with your clipboard tool (for example `xclip -selection clipboard`). Clear the clipboard
   afterwards.
5. **Run the migrations once** (and again after updates that change the database). Render's service does not include the
   Prisma command line, so run the migrator image from your own computer against the **External Database URL** (add
   `?sslmode=require`, and allow your computer's address in the database's access settings if Render asks). Put the URL
   in a shell variable first so it is not echoed:

   ```sh
   docker build --target migrator -t vestlens-migrate .
   read -rs EXTERNAL_DB_URL   # paste the External Database URL, then press Enter
   docker run --rm -e DATABASE_URL="${EXTERNAL_DB_URL}?sslmode=require" vestlens-migrate
   ```

   When it finishes, remove the image the build created: `docker image rm vestlens-migrate`. (Rebuild it before the next
   migration.)

   The migrator needs no `connection_limit`. Then restart the web service in Render (HUMAN) if it started before the
   migrations finished.
6. **Open your address**, sign in with the owner password from setup (HUMAN), and connect a brokerage through SnapTrade's
   portal (HUMAN; login and MFA only there). The MCP address for Claude and ChatGPT is `<APP_BASE_URL>/mcp`. Verify it
   with the README's [Check it works](../../README.md#check-it-works) commands against that address, and add the
   connector as in [Connect your AI app](../../README.md#connect-your-ai-app).

## Updates and backups

- **Updates:** on every update, run step 5 (the migration) first, then push the new code; Render rebuilds and deploys
  when you push. The migration does nothing when nothing is pending, so it is always safe to run.
- **Backups:** Render's paid Postgres includes its own backups (check your plan's retention). You can also take a dump
  with `pg_dump` against the External Database URL.
- Run one instance only: do not raise the instance count above 1.
