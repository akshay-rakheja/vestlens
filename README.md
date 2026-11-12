# VestLens

VestLens is a private, self-hosted dashboard for your own investment accounts. It reads your accounts through
[SnapTrade](https://snaptrade.com), shows holdings, balances, activity and history in a web dashboard, and lets AI
apps such as Claude and ChatGPT read the same data so you can ask questions about it. You run it yourself, for yourself.

> **Claude and ChatGPT need a public https address.** AI apps reach your instance from their own cloud, not from your
> computer, so `localhost` cannot work for them (Claude refuses it as a local connector). Running VestLens on `localhost`
> alone gives you the dashboard only. To use it from an AI app you need a public https address: a free Cloudflare Quick
> Tunnel to try it today, a domain (named Cloudflare Tunnel), or a paid host (Render, about US$13 a month); see
> [How you'll reach it](#how-youll-reach-it).

> **Read this first: [Known limitations](docs/known-limitations.md).** Wealthsimple history through SnapTrade only goes
> back to about April 2023, so all-time deposits and returns for older accounts are incomplete.

## What it is, and what it is not

- **Read-only.** VestLens reads. It never trades, never moves money, and never changes anything at your brokerage.
- **One owner, one instance.** One password, one set of accounts. There is no sign-up, no sharing and no multi-user mode.
- **No telemetry, and nothing goes to vestlens.com.** VestLens sends no analytics or usage data anywhere. It does
  contact a few outside services to do its job (see [What it contacts](#what-it-contacts)).
- **Not investment advice.** VestLens shows what you hold and how it has moved. It does not tell you what to buy,
  sell or hold.
- **Not affiliated** with Wealthsimple or SnapTrade. Follow your brokerage's terms and SnapTrade's terms of use.

Things to know before you start:

- **Run one instance.** Do not run two copies against the same database.
- **The instance holds read access to your brokerage.** Anyone with your owner password can see your portfolio, so keep
  the password in a password manager and keep `.env` private.
- **Wealthsimple history before April 2023 is unavailable** (see [Known limitations](docs/known-limitations.md)).
- Per [SnapTrade's Wealthsimple support page](https://support.snaptrade.com/Wealthsimple-af4feaa69a1c82ef93b601e96d8ef839),
  some Wealthsimple account types (such as the managed Invest/Robo accounts) may not be readable. Check what SnapTrade
  supports for your accounts.

## What it contacts

Besides your own database, an instance makes outbound requests to these services, and only these. No setting turns
off the market-data lookups.

| Service | Why | What is sent |
| --- | --- | --- |
| SnapTrade | Reading your accounts, balances, positions and activity (read-only) | Your SnapTrade credentials and the account identifiers needed to read them |
| Yahoo Finance (`query1.finance.yahoo.com`, `fc.yahoo.com`) | Market prices and benchmark history | Ticker symbols and date ranges |
| Stooq (`stooq.com`) | Fallback price history | Ticker symbols and date ranges |
| Bank of Canada (`bankofcanada.ca`) | USD/CAD exchange rates | A rate request (no portfolio data) |

Only if you set `NEWS_ENABLED=true` (off by default), VestLens also contacts Marketaux (headlines), TypeSafe (rating
headlines), SEC EDGAR (filings and the calendar), and fetches article thumbnails from publishers through its own image
proxy. These need the extra keys listed in [`.env.example`](.env.example).

Nothing is sent to vestlens.com or to any analytics or error-reporting service. Your account numbers, balances and
holdings amounts are not sent to the market-data services, only the ticker symbols you hold or look up.

## Prerequisites

- **Docker Desktop, or Docker Engine, with Docker Compose 2.24.4 or newer.** This runs VestLens and its PostgreSQL
  database. Check with `docker compose version`.
- **Node 22 or newer** (20.19 works), **only for `npm run setup`**. It generates your owner password hash and secrets.
  It needs no `npm ci`.
- **Git**, to clone the repository.

## Before you start: what you'll need from the human

Use this as a checklist. If an AI agent is setting VestLens up for you, it can do everything except the items below,
and it should ask you for exactly these.

1. **A SnapTrade Personal key** (you create it). Sign up at [snaptrade.com/personal](https://snaptrade.com/personal)
   (it links the sign-up at `dashboard.snaptrade.com/signup`). **Cost, as of 2026-11-11:** that page says "Free for
   personal use" and "No credit card required". [SnapTrade's pricing page](https://snaptrade.com/pricing) says "Use
   SnapTrade Personal — free!", but also "For a limited time, SnapTrade Personal users are $0 per connected user." and
   "The $100/month Launch platform fee still applies." **Confirm the current price on SnapTrade's pricing page before you
   sign up.** You get two values; **you** paste them into `.env` yourself (an agent should not receive them in chat),
   under these names:
   - `SNAPTRADE_CLIENT_ID`
   - `SNAPTRADE_CONSUMER_KEY`
2. **One brokerage login, done only in SnapTrade's portal** (two-step verification included). VestLens sends you there
   from the dashboard. **An agent must never ask for your brokerage password or MFA codes**, and you should never give
   them to one. Check first that SnapTrade can read your account types (see
   [Known limitations](docs/known-limitations.md)).
3. **The owner password.** **You** run setup in a real terminal (the Terminal app), so the password never passes through
   an agent or a chat. Best: choose it yourself with the hidden prompt and save it in your password manager first
   ([see Install](#install)); alternatively setup generates one and shows it once. It is the only way into the dashboard
   and the sign-in page your AI app opens.
4. **Only if you want to use it from your phone or from Claude and ChatGPT: a choice of https route** from
   [How you'll reach it](#how-youll-reach-it). A Cloudflare Quick Tunnel needs no account or domain (testing only). A
   named Cloudflare Tunnel needs your Cloudflare account and a domain on Cloudflare DNS. Render needs a payment method and
   a private GitHub copy.
5. **Adding the connector in your AI app and clicking Allow**, from your own account. See
   [Connect your AI app](#connect-your-ai-app).

## Install

**Run every command in this section in a real terminal (the Terminal app), from the folder you cloned into.** Not in a
chat box and not in an AI tool's command box (such as Claude Code's `!` prompt): those have no keyboard input for the
hidden password prompt, and they may run from another folder, so the command can fail without telling you.

```sh
git clone https://github.com/akshay-rakheja/vestlens.git
cd vestlens
cp .env.example .env
```

**Do not skip `cp .env.example .env`.** It creates `.env` with the two settings Docker needs, `APP_BASE_URL` and
`DATABASE_URL`. (If you do skip it, `npm run setup` creates `.env` from the example for you. But if you made your own
`.env` without those two lines, setup stops and tells you which lines to add, instead of leaving you with a confusing
`DATABASE_URL` error later.)

Open `.env` yourself in your editor. The first two values below are already correct in `.env.example` for a local
install; you only have to replace the two SnapTrade placeholders (see [`.env.example`](.env.example) for every option):

```sh
APP_BASE_URL=http://localhost:8080
DATABASE_URL=postgresql://vestlens:vestlens@db:5432/vestlens?connection_limit=5
SNAPTRADE_CLIENT_ID=your-snaptrade-client-id
SNAPTRADE_CONSUMER_KEY=your-snaptrade-consumer-key
```

Then create the owner secrets. **Run this yourself, in your own terminal, not through an AI agent or chat.** It needs
only Node (22, or 20.19 or newer), not `npm ci`. **Choose your own owner password** with the hidden prompt (nothing you
type is shown, and it is not kept in your shell afterwards). Pick one of at least 12 characters, **save it in your
password manager first**, then type it here (works in bash and zsh):

```sh
cd vestlens   # the folder you cloned into, if you are not already in it
read -rs OWNER_PASSWORD && printf '%s\n' "$OWNER_PASSWORD" | npm run setup -- --password-stdin; unset OWNER_PASSWORD
```

Setup **does not print the password** (you already know it); `.env` keeps only a hash of it. `--password-stdin` refuses
to read from a terminal directly, fails with a clear message if it receives nothing, and fails (without applying the
password) if `.env` is already set up.

**Alternative: let setup generate one.** Run `npm run setup`. It adds the secrets to `.env` (mode 0600) and **prints a
generated owner password once**. That is the only time it is shown: `.env` keeps only `OWNER_PASSWORD_HASH`, a hash,
which will **not** work as a password, so do not try to type it at the sign-in page. Save the printed password in your
password manager before you close the terminal.

Running setup again never overwrites an existing setup; if you lose the password, see
[Forgot your password / sign out everywhere](#forgot-your-password--sign-out-everywhere). Setup also warns (naming the
keys, never printing values) if `SNAPTRADE_CLIENT_ID` or `SNAPTRADE_CONSUMER_KEY` is missing or still a placeholder.

Then start it, from the same folder:

```sh
docker compose up -d
```

This starts PostgreSQL, applies the database migrations, and starts the app. Next, see [First run](#first-run).

### First run

1. Open <http://localhost:8080> (your `APP_BASE_URL`) in your browser.
2. Sign in with the owner password you saved. (Not the `OWNER_PASSWORD_HASH` in `.env`: that is only a hash.)
3. In the dashboard, choose to connect a brokerage. SnapTrade's own portal opens; do the brokerage login and two-step
   verification there only. The first sync takes a few minutes; refresh the dashboard after that.
4. When it finishes the dashboard shows your accounts, balances and holdings, plus activity and history (Wealthsimple
   history starts around April 2023; see [Known limitations](docs/known-limitations.md)).
5. Then [connect your AI app](#connect-your-ai-app). That needs a public https address, which `localhost` is not; the
   quickest way to try it is the [Quick Tunnel](#try-it-with-claude-now-cloudflare-quick-tunnel).

To confirm the install is healthy, run the checks in [Check it works](#check-it-works).

### Check it works

These need no password and print no secrets. Replace `http://localhost:8080` with your `APP_BASE_URL` if it differs.

```sh
curl -s http://localhost:8080/health
# {"status":"ok"}

curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/login
# 200   (the owner sign-in page)

curl -s -i -X POST http://localhost:8080/mcp | head -n 5
# HTTP/1.1 401 Unauthorized ... a WWW-Authenticate header pointing at the resource metadata

curl -s http://localhost:8080/.well-known/oauth-authorization-server
# JSON that includes "issuer" (equal to your APP_BASE_URL), "authorization_endpoint", "token_endpoint"
# and "registration_endpoint"
```

`/.well-known/oauth-protected-resource/mcp` also returns JSON. If the dashboard says SnapTrade rejected your API key, the
two SnapTrade values in `.env` are wrong; see [Troubleshooting](#troubleshooting). That is expected with placeholder keys.

The database volume is named `<project>_vestlens-db`: Compose prefixes it with the project name, which is `vestlens` by
default (the folder name, or the name from `docker compose -p <name>` or `COMPOSE_PROJECT_NAME`), so by default it is
exactly `vestlens_vestlens-db`. Check it with an exact name:

```sh
docker volume ls --filter name='^vestlens_vestlens-db$'
```

(Replace `vestlens` with your project name if it differs. A bare `grep vestlens-db` can match more than one volume, for
example another copy's.)

### Connect a brokerage

In the dashboard, choose to connect a brokerage. VestLens sends you to **SnapTrade's own portal**. Your brokerage
login and any two-step verification happen there only; VestLens never sees them. Never type them anywhere else.

(This is step 3 of [First run](#first-run).) After connecting, the first sync can take a few minutes. VestLens then refreshes nightly (17:30 Toronto time on
weekdays) and you can refresh by hand from the dashboard.

## Settings that matter

| Setting | What it does |
| --- | --- |
| `APP_BASE_URL` | The address you reach VestLens at. `https`, or plain `http` only on `localhost`, `127.0.0.1` or `[::1]`. It is also the issuer your AI apps sign in to, so it must match what you type in the browser. Changing it moves where you sign in: sign-in works only on this address. |
| `DATABASE_URL` | `connection_limit` defaults to 5 when the URL leaves it out. A value below 3 stops the app at start, because each running background job holds one pooled connection. Allowed range 3 to 10. |
| `HOST` | The address the server binds. Defaults to `127.0.0.1`, so running the API directly (outside Docker) is not exposed on your network. The Docker image sets `0.0.0.0` inside the container; Compose still publishes the port on `127.0.0.1` only. |
| `TRUST_PROXY` | Leave it unset on localhost. Set it to `1` behind one proxy (a tunnel or a PaaS), so the visitor's address, and the sign-in rate limit, are right. Unset, `X-Forwarded-For` is ignored and cannot be forged. |

### Reaching it from other devices

The compose file publishes the app as `127.0.0.1:8080:8080`, so only this computer can reach it. That is deliberate: a
plain-http instance with your portfolio behind one password should not sit open on your network.

Make local changes in a `docker-compose.override.yml` next to `docker-compose.yml`. Compose loads it automatically, git
ignores it, and `git pull` never conflicts with it. For example, to reach the app from your LAN (not recommended; sign-in
cookies then travel over plain http, so prefer https below), set `APP_BASE_URL` to the address you will type and use:

```yaml
services:
  app:
    ports: !override
      - "8080:8080"
```

`!override` needs Docker Compose 2.24.4 or newer.

### If port 8080 is already taken

If something else on your computer already uses port 8080 (for example another VestLens), publish a different loopback
port in `docker-compose.override.yml`, and keep every address in step with it:

```yaml
services:
  app:
    ports: !override
      - "127.0.0.1:8081:8080"
```

- Set `APP_BASE_URL=http://localhost:8081` in `.env`, then run `docker compose up -d`.
- For a Quick Tunnel, point it at the same port: `cloudflared tunnel --url http://localhost:8081`.
- To run a second copy beside another, clone it into a folder with a different name (Compose names the project after the
  folder) or add `-p <name>` to **every** `docker compose` command, so the two never share containers or the database volume.

To use a different database password, set `POSTGRES_PASSWORD` for `db` in the same override file and put the same
password in `DATABASE_URL` in `.env`. Do this before the first start: the password is fixed when the database volume is
first created.

## How you'll reach it

Pick one. **The human chooses; an agent should not expose the app to the internet on its own.**

| Option | Cost | Needs | Dashboard in a browser | Claude and ChatGPT |
| --- | --- | --- | --- | --- |
| **[Cloudflare Quick Tunnel](#try-it-with-claude-now-cloudflare-quick-tunnel)**, to try it today | Free | `cloudflared` installed; no Cloudflare account or domain; your computer must stay on; the address changes every time | Over the tunnel address | Yes, for testing |
| **Localhost only** (the default) | Free | Nothing extra | This computer only | Not supported. Their connectors need a public https address. |
| **[Cloudflare Tunnel](docs/hosting/cloudflare-tunnel.md)**, VestLens stays on your computer or home server | Cloudflare's free plan covers tunnels (check [their pricing](https://www.cloudflare.com/plans/)); a domain costs extra if you do not own one | A Cloudflare account and a domain whose DNS is on Cloudflare; your computer must stay on | Any device, over https | Yes |
| **[Render](docs/hosting/render.md)**, hosted, always on | About US$13 a month, as the guide states (as of 2026-11-11) | A Render account with a payment method, a GitHub account, and a private GitHub copy of this repository | Any device, over https | Yes |

Claude and ChatGPT connect from their own servers, so the address must be reachable over https from the internet.
Plain `http://localhost` cannot work for them (Claude answers that local connectors cannot be added), and this README does not claim any phone app reaches your computer's
localhost. Claude on iOS uses connectors you add on Claude on the web or desktop (see below), so the https address is
what matters, not the device.

**Changing `APP_BASE_URL` moves where you sign in.** Sign-in only works on the address in `APP_BASE_URL`, so once you set a
tunnel or Render address, use the dashboard at that address; `http://localhost:8080` will refuse the sign-in.

With a tunnel or Render, set `APP_BASE_URL` to that https address and `TRUST_PROXY=1`, then apply it with
`docker compose up -d` (a plain `docker compose restart` does not re-read `.env`). The MCP address you give your AI app
is:

```
<APP_BASE_URL>/mcp
```

### Try it with Claude now: Cloudflare Quick Tunnel

The fastest way to see VestLens inside Claude. From Cloudflare's
[Quick Tunnels page](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/):
"You do not need a Cloudflare account or domain." But "Quick Tunnels are for testing and development." and "Anyone with the
URL can access your local service." (here, that means anyone who has the URL can reach your sign-in page, so do not share
it). "The hostname changes each time you create a Quick Tunnel." and "Quick Tunnels do not support Server-Sent Events
(SSE)." VestLens's `/mcp` answers with plain JSON, not SSE, so it works. "Each Quick Tunnel supports up to 200 in-flight
requests." That is plenty for one person.

**Do not add `--allowed-mail` to the tunnel for the AI connector.** Cloudflare says "Email authentication requires an
interactive browser session. It does not support non-interactive clients.", so it would block Claude's and ChatGPT's servers.

Install `cloudflared` first (see Cloudflare's page above), then:

1. In its **own terminal window, left running**, from anywhere:

   ```sh
   cloudflared tunnel --url http://localhost:8080
   ```

   It prints an address like `https://something-random.trycloudflare.com`. Copy it.
2. In `.env` (in your editor), set `APP_BASE_URL` to that address with **no trailing slash**, and add `TRUST_PROXY=1`:

   ```sh
   APP_BASE_URL=https://something-random.trycloudflare.com
   TRUST_PROXY=1
   ```

3. In the folder you cloned into: `docker compose up -d` (a plain `docker compose restart` does not re-read `.env`).
4. Check it: `curl -s https://something-random.trycloudflare.com/health` should print `{"status":"ok"}`.
5. In Claude, add `https://something-random.trycloudflare.com/mcp` as a custom connector (see
   [Connect your AI app](#connect-your-ai-app)). Sign in with your owner password, then click **Allow**.

What this means from now on:

- **Use the dashboard at the tunnel address.** Sign-in only works on `APP_BASE_URL`; `http://localhost:8080` will refuse it.
- **When `cloudflared` stops** (your Mac sleeps, or you close its terminal), the address is gone. A new tunnel means a new
  address: update `APP_BASE_URL`, run `docker compose up -d`, and reconnect the AI app.
- **For daily use**, move to a [named Cloudflare Tunnel](docs/hosting/cloudflare-tunnel.md) or [Render](docs/hosting/render.md).

#### Keep the Quick Tunnel running

The steps above tie the tunnel to one terminal window. To keep it running after you close that window, and to stop your
Mac from idling to sleep while it runs, start it in the background with a log file instead (macOS; on Linux, leave out
`caffeinate -i`):

```sh
nohup caffeinate -i cloudflared tunnel --url http://localhost:8080 > ~/vestlens-tunnel.log 2>&1 &
```

`caffeinate -i` keeps the Mac from sleeping when idle for as long as `cloudflared` runs. Closing a laptop's lid still
puts it to sleep, and that ends the tunnel.

| To | Run |
| --- | --- |
| See the tunnel's address (it takes a few seconds to appear) | `grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' ~/vestlens-tunnel.log \| head -n 1` |
| Check it is still running | `pgrep -fl "cloudflared tunnel --url"` (no output means it stopped) |
| Check VestLens answers through it | `curl -s <the address>/health` should print `{"status":"ok"}` |
| Stop it | `pkill -f "cloudflared tunnel --url"` |

**After a restart, sleep or reboot, the old address is gone.** Start the tunnel again, then:

1. Read the new address with the `grep` command above.
2. Put it in `.env` as `APP_BASE_URL`, with no trailing slash, and run `docker compose up -d` in the folder you cloned into.
3. In your AI app, remove the old VestLens connector and add `<new address>/mcp`, then sign in and click Allow again. The
   old address no longer reaches anything.

If you keep doing this, it's time for a [named Cloudflare Tunnel](docs/hosting/cloudflare-tunnel.md): its address never changes,
and `cloudflared` can run as a background service that starts at login.

### Connect your AI app

Menus change, so follow the vendor's current help page and use the MCP address above as the server URL:

- **Claude (desktop and web):** add a custom connector with that URL. Steps:
  [Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
  Claude reaches the address from Anthropic's cloud, so it must be publicly reachable over https (the tunnel or Render
  options above).
- **Claude on iOS:** the app uses connectors you add on Claude on the web or desktop; add the connector there first.
  See [Use connectors to extend Claude's capabilities](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities).
- **ChatGPT:** add a custom MCP server (ChatGPT calls this developer mode or custom apps, depending on plan; availability
  varies by plan). Steps:
  [Connecting custom MCP servers in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).

In each, look for the custom connector settings, and paste `<APP_BASE_URL>/mcp` as the server URL. This README does not
quote vendor menu names because they change; use the vendor's page above. What the human sees afterwards:

1. The AI app opens the **VestLens sign-in page**. Type the owner password there (never in the chat).
2. A **consent page** follows. It names the app, says it is read-only, and has an **Allow** button. Click Allow.
3. The AI app returns to its own screen with the connector added.

**To confirm it worked** (the agent can ask the human to do this, or ask the AI app itself): ask the AI app to "list my
portfolio accounts" with the VestLens connector. A list of account names and types means it is connected. If it cannot
reach the server, re-run [Check it works](#check-it-works) against your https address.

For example `https://vestlens.example.com/mcp`. Your AI app opens a VestLens sign-in page; sign in with the owner
password, then approve the app on the one-click consent page that follows. The tools are read-only: they read your
portfolio (snapshot, accounts, holdings, positions, history, performance, allocation, activity, income). The calendar
and alerts tools exist only when `NEWS_ENABLED=true`. A few tools also save your own notes, goals and limits inside
VestLens's database, never at the brokerage.

### Limits of plain-http localhost use

- Safari will not store the gateway's `Secure` `__Host-gw_pa` cookie over plain http, so connecting an AI app from
  Safari needs https (use a tunnel). Other browsers on `localhost` work.
- Sign-in codes for AI apps are kept in memory. Restarting the app restarts any AI sign-in that is in progress.
- Run exactly one instance.

## Updates

```sh
git pull
docker compose build
docker compose up -d
```

Database migrations run automatically on start.

## Backups

Your data lives in the `vestlens-db` Docker volume (Compose names it `<project>_vestlens-db`, by default exactly `vestlens_vestlens-db`; check it with
`docker volume ls --filter name='^vestlens_vestlens-db$'`). To back it up:

```sh
docker compose exec -T db pg_dump --clean --if-exists -U vestlens vestlens > vestlens-backup.sql
```

The dump holds your portfolio data: store it somewhere private. It does not include your `.env` secrets, so back
that up separately.

To restore, **which replaces the current data** in the database with the backup:

```sh
docker compose stop app
docker compose up -d db
docker compose exec -T db psql -1 -v ON_ERROR_STOP=1 -U vestlens vestlens < vestlens-backup.sql
docker compose up -d
```

Stopping `app` first stops it writing during the restore. `-1` runs the whole restore as one transaction and
`ON_ERROR_STOP` aborts at the first error, so a failed restore changes nothing: your current data stays as it was.
Starting the stack again re-runs `migrate`, which applies any migrations the backup predates.

## Forgot your password / sign out everywhere

If you lose the owner password, or think it leaked, set a new one. **In a real terminal (the Terminal app), from the folder
you cloned into** (not a chat or AI-tool command box, which has no keyboard input for the prompt):

```sh
cd vestlens   # the folder you cloned into
npm run setup -- --reset-password
docker compose up -d
```

It asks for a new password (at least 12 characters; press Enter to have one generated and shown once) and rewrites only
`OWNER_PASSWORD_HASH` and `SESSION_SECRET` in `.env`. Every other line stays as it was. `docker compose up -d` recreates
the app with the new values.

To choose the new password with a hidden prompt (at least 12 characters, never echoed, nothing generated):

```sh
cd vestlens   # the folder you cloned into
read -rs NEW_PASSWORD && printf '%s\n' "$NEW_PASSWORD" | npm run setup -- --reset-password --password-stdin; unset NEW_PASSWORD
docker compose up -d
```

Run it yourself in your own terminal; VestLens stores only the hash (so the hash in `.env` is not a password). If a generated
password is printed, that is the only time it is shown. **Confirm the new password works:** open the
sign-in page (`/login`, on your `APP_BASE_URL`) and sign in with it. An old browser session is signed out and lands on
the sign-in page; the old password is refused. Do not put the password on a command line (`curl -d ...`), where other
users of the computer could see it.

What this ends: changing `SESSION_SECRET` signs out every browser (all sessions stop being valid, the 30-day ones
included). What it keeps: `MCP_GATEWAY_SIGNING_KEY` is untouched, so AI apps that were already connected keep working.
If you suspect a leak, also open the **Account** page and revoke each connected AI app, then rotate your SnapTrade key if
`.env` itself may have been exposed.

## Troubleshooting

- **Stuck in a sign-in loop.** Duplicate `vl_session` cookies cause this (for example from another app on `localhost`).
  Clear the site's cookies for that address and sign in again.
- **`docker compose up` says `.env` is missing.** Run `npm run setup` first.
- **`docker compose up -d` fails at `migrate` with "Environment variable not found: DATABASE_URL".** `.env` lacks
  `DATABASE_URL` (and probably `APP_BASE_URL`). Add the two lines from [`.env.example`](.env.example), or `cp .env.example .env`
  before running setup.
- **The password is refused.** Use the password you saved, not the `OWNER_PASSWORD_HASH` value in `.env` (only a hash).
  Lost it? [Reset it](#forgot-your-password--sign-out-everywhere).
- **The hidden-prompt command did nothing.** It was probably run in a chat or AI-tool command box (no keyboard input) or from
  the wrong folder. Run it in the Terminal app after `cd` into the folder you cloned. With nothing on stdin, setup now says so.
- **Sign-in says cross-site, or is refused on `localhost`, after you set a tunnel URL.** Sign-in only works on `APP_BASE_URL`:
  use the tunnel (or hosted) address instead of `localhost`.
- **Claude says local connectors cannot be added.** Claude reaches your instance from its cloud, so it needs a public https
  address. See [Try it with Claude now](#try-it-with-claude-now-cloudflare-quick-tunnel).
- **The Quick Tunnel stopped working.** The address was lost when `cloudflared` stopped. Start a new tunnel, update `APP_BASE_URL`,
  run `docker compose up -d`, and reconnect the AI app.
- **The app exits on start.** Run `docker compose logs app`. A configuration error names the setting (never its value).
- **The dashboard says SnapTrade rejected your API key.** `SNAPTRADE_CLIENT_ID` or `SNAPTRADE_CONSUMER_KEY` in `.env` is wrong or was revoked. Fix it, then restart the app so it reads the new values. **Docker:** run `docker compose up -d` (`docker compose restart` does not re-read `.env`). **Render:** change the variables in Render's dashboard, then redeploy the service. The logs show a `snaptrade_key_rejected` line (never the key).
- **Nothing shows after connecting.** Wait for the first sync, then refresh. Some account types are not readable
  through SnapTrade.

## For AI agents

If a person handed you this repository and asked you to set it up, follow this order. **Secrets stay between the human and
their own terminal: the owner password and the SnapTrade keys must never pass through you or the chat.**

1. Check the [Prerequisites](#prerequisites). Do not change the system's runtimes.
2. Run `git clone https://github.com/akshay-rakheja/vestlens.git`, `cd vestlens` and `cp .env.example .env`.
3. **Hand these to the human to run themselves, in a real terminal (the Terminal app) from the folder you cloned into, with an
   explicit `cd`. Do not run them yourself, and do not tell them to use an AI tool's `!` or command box** (it has no keyboard
   input for the hidden prompt and may run from another folder, so it fails silently). Then wait:
   - edit `.env` in their editor to paste the two SnapTrade values (`SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY`; see
     [Before you start](#before-you-start-what-youll-need-from-the-human), including the cost note);
   - run the hidden-prompt setup command in [Install](#install) (they choose the password and save it in their password
     manager first), or plain `npm run setup`.
   The same applies to a password reset and to editing SnapTrade values later.
4. When they say they are done, you may check that the keys are present **by name only**
   (for example `grep -c '^SNAPTRADE_CLIENT_ID=.' .env`; never print the lines), then run `docker compose up -d`.
5. Verify with [Check it works](#check-it-works). Report results, not secrets.
6. Tell the human about [First run](#first-run). The brokerage login (SnapTrade's portal), the https route choice and the AI
   app connector are theirs. Claude and ChatGPT need a public https address, not `localhost`.
7. **Only if the human agrees to expose the instance**, you may run the
   [Quick Tunnel](#try-it-with-claude-now-cloudflare-quick-tunnel) steps (`cloudflared` in its own terminal, set
   `APP_BASE_URL` and `TRUST_PROXY=1` without printing `.env`, `docker compose up -d`, `curl -s <url>/health`). Remind them
   anyone with the URL can reach the sign-in page, that sign-in then works only on the tunnel address, and that the address
   changes whenever the tunnel restarts. Give them `<APP_BASE_URL>/mcp` and the steps under
   [Connect your AI app](#connect-your-ai-app).

**Never:**

- ask for, receive or print the owner password or the SnapTrade keys in chat;
- ask for, accept or type the human's brokerage password or MFA codes;
- print, log or paste `.env` values, the database contents, or anything from `.env`;
- expose the app beyond localhost (a tunnel, Render, a LAN port) without the human's explicit choice;
- add anything that trades, moves money or opens accounts. VestLens is read-only.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Report security problems privately, as described in
[SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE), copyright (c) 2026 Akshay Rakheja.
