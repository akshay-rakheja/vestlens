# Reach VestLens over https with a Cloudflare Tunnel

Claude and ChatGPT need an https address. A Cloudflare Tunnel lets VestLens keep running on your own computer (or a
home server) while Cloudflare serves it over https. No router changes or open ports. Cloudflare's free plan covers
tunnels; check [Cloudflare's pricing](https://www.cloudflare.com/plans/) for current terms.

Commands below come from Cloudflare's own pages, linked at each step. Cloudflare changes its CLI and docs, so if
something does not match, follow their current
[Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).

**Steps marked HUMAN need you personally; an agent cannot do them and must not do them with your credentials.**
Everything else an agent can run once you have done those.

## Before you start (HUMAN)

- A Cloudflare account, and a **domain whose DNS is on Cloudflare**. Owning the domain is yours to arrange.
- Pick a hostname, for example `vestlens.example.com`. The https address is your `APP_BASE_URL`.
- VestLens is already running locally (`docker compose up -d`, see the README).

## 1. Install cloudflared

Cloudflare's [downloads page](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/):

```sh
# macOS (Homebrew)
brew install cloudflared
```

On Linux, install from the [Cloudflare Package Repository](https://pkg.cloudflare.com/) or the `.deb` they link from
that downloads page; use the commands those pages give.

## 2. Log in (HUMAN)

Cloudflare's [create a tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/):

```sh
cloudflared tunnel login
```

This opens a browser page where **you** sign in to Cloudflare and pick the domain to authorize. It then saves a
certificate on this computer. Never paste Cloudflare credentials into a chat.

## 3. Create the tunnel and route the hostname

From the same guide:

```sh
cloudflared tunnel create vestlens
cloudflared tunnel route dns vestlens vestlens.example.com
```

`create` prints the tunnel's UUID and the path of its credentials file. Keep that path; the credentials file is a secret.
`route dns` creates the DNS record for your hostname.

## 4. Write the config file

Create the file `~/.cloudflared/config.yml` (make the folder if it is missing; `cloudflared tunnel login` normally
created it). Cloudflare's pages do not fix one location, so this guide always names the file explicitly with `--config`
in the run step below. Use the UUID and credentials path from step 3, and the address VestLens listens on:

```yml
tunnel: <Tunnel-UUID>
credentials-file: <path printed by `tunnel create`>
ingress:
  - hostname: vestlens.example.com
    service: http://localhost:8080
  - service: http_status:404
```

The `tunnel` and `credentials-file` fields are in Cloudflare's guide above. The `ingress` rules (with the required
catch-all `http_status:404` last) are shown in Cloudflare's
[configuration file page](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/);
check it if the file does not start.

## 5. Run the tunnel

```sh
cloudflared tunnel --config ~/.cloudflared/config.yml run vestlens
```

Leave it running. Cloudflare's [run as a service guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/)
covers keeping it up after a reboot (a system service on Linux, a launch agent on macOS).

## 6. Point VestLens at the https address

In `.env`, set:

```sh
APP_BASE_URL=https://vestlens.example.com
TRUST_PROXY=1
```

`TRUST_PROXY=1` is right here because `cloudflared` is exactly one proxy hop in front of VestLens and it adds
`X-Forwarded-For`. Without it, every visitor looks like the same address and the sign-in rate limit is shared. Do not
set it when you reach VestLens directly.

Apply it. `docker compose restart` does **not** re-read `.env`, so use:

```sh
docker compose up -d
```

## 7. Check it

Run the [Check it works](../../README.md#check-it-works) commands against `https://vestlens.example.com`. Your MCP
address for Claude and ChatGPT is `https://vestlens.example.com/mcp`; the connector steps are in the README
([Connect your AI app](../../README.md#connect-your-ai-app)).

## Notes

- The compose file still publishes the app on `127.0.0.1:8080` only. `cloudflared` runs on the same machine, so it
  reaches it there. Leave that as is.
- VestLens is reachable by anyone who can reach the hostname, protected by your owner password. Use a long password
  (setup generates one) and do not share it. You can also put Cloudflare Access in front for a second check, but AI
  apps must still be able to reach `/mcp`, `/authorize`, `/token`, `/register` and the `/.well-known/` paths, so test
  the connector after changing anything.
- Your computer has to be on, and Docker and `cloudflared` running, whenever an AI app asks a question. The nightly
  refresh also only runs while it is up.
- Changing `APP_BASE_URL` later changes the issuer your AI apps signed in to. Reconnect them after a change.
