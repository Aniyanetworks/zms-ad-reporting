# Cloudflare Tunnel

The Mac mini is published through one Cloudflare Tunnel, `zms-seo-dashboard`
(id `b9929fe5-4b97-4708-acdb-734c224430e5`). It serves **two** systems: this dashboard
(ports 3010 / 3011) and the separate SEO dashboard (ports 3000 / 8000). Any change here
affects both. Facts verified 2026-09-16.

## How it works

- `cloudflared` on the Mac mini opens outbound connections to Cloudflare's edge and keeps them
  up. Visitors hit Cloudflare; Cloudflare forwards over those connections to `localhost:<port>`.
- No router port forwarding, no inbound firewall rule, and the home IP never appears in DNS.
  TLS terminates at Cloudflare; traffic to the container is plain HTTP on 127.0.0.1.
- Every compose port is bound to `127.0.0.1` (`compose.production.yml`, `compose.staging.yml`).
  **Never bind a service to `0.0.0.0`**: that would expose it on the LAN and, with a misconfigured
  router, the internet. `docker ps` must only show `127.0.0.1:` bindings.
- The api itself is not a tunnel target. The web container proxies `/api/*` to `api:8000` inside
  the compose network; `8010` / `8011` exist only for local debugging.
- Cloudflare adds `CF-Connecting-IP`; the api uses it for rate limiting and `audit_log.ip`.

## Remote vs local configuration

| | Where | Used? |
|---|---|---|
| Ingress rules (hostname -> service) | **remote**, in Cloudflare (Zero Trust -> Networks -> Tunnels -> Public Hostname), or via the API (`scripts/cloud/cloudflare-hostnames.py`) | yes |
| `/Users/zms/.cloudflared/config.yml` | local; contains `tunnel:`, `credentials-file:` and an `ingress:` block | only `tunnel` and `credentials-file` matter. **The local `ingress:` is stale and ignored** because the tunnel is remote-managed |
| `infra/cloudflared-config.example.yml` (repo) | example for a locally-managed setup | reference only; do not copy over the live file |
| `/Users/zms/.cloudflared/b9929fe5-….json` | tunnel credentials | required; back up encrypted (`BACKUP_RESTORE.md`) |

If you ever need local management again, delete the remote configuration first; a tunnel with a
remote config ignores the local ingress entirely.

## Adding or changing a hostname

Preferred (idempotent, dry run first):

```bash
cd ~/zms-ad-reporting
python3 scripts/cloud/cloudflare-hostnames.py          # plan
python3 scripts/cloud/cloudflare-hostnames.py --apply  # creates CNAME + ingress for adbuildout./staging-adbuildout.
```

The script keeps every existing rule and inserts new ones before the `http_status:404`
catch-all. For any other hostname, edit `WANT` in the script or use the dashboard:
Zero Trust -> Networks -> Tunnels -> `zms-seo-dashboard` -> Public Hostname -> Add public
hostname (subdomain, domain, `HTTP`, `localhost:<port>`). The dashboard creates the DNS CNAME.

Rules:

1. Production hostnames (`adbuildout.`, `ads.`, `setter.`) -> `localhost:3010`.
2. Staging (`staging-adbuildout.`) -> `localhost:3011`.
3. Never point anything at `3000`, `8000` or `6379`: those are the SEO dashboard.
4. Never remove or reorder the SEO dashboard's rules.
5. Remote config changes take effect within seconds; no restart of `cloudflared` needed.

## LaunchDaemon management

`/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`: RunAtLoad + KeepAlive, runs as root,
`cloudflared --config /Users/zms/.cloudflared/config.yml tunnel run` (arguments as installed by
`cloudflared service install`).

```bash
# status
sudo launchctl print system/com.cloudflare.cloudflared | grep -E 'state|pid|last exit'

# restart (kickstart -k kills and relaunches)
sudo launchctl kickstart -k system/com.cloudflare.cloudflared

# logs (paths depend on the plist; check StandardOutPath/StandardErrorPath)
sudo plutil -p /Library/LaunchDaemons/com.cloudflare.cloudflared.plist | grep -i path
sudo tail -f /Library/Logs/com.cloudflare.cloudflared.err.log 2>/dev/null || \
  log show --last 15m --predicate 'process == "cloudflared"' --info

# tunnel health from the CLI (as root, uses the credentials file)
sudo cloudflared tunnel info b9929fe5-4b97-4708-acdb-734c224430e5
```

A restart drops all tunnel connections for a few seconds; both dashboards blip. Do it outside
business hours when possible.

## Upgrading cloudflared

Installed via Homebrew (2026.5.2 as of 2026-09-16; 2026.9.1 available). Plan item 3.10,
TODO (Carl).

```bash
brew upgrade cloudflared
cloudflared --version
sudo launchctl kickstart -k system/com.cloudflare.cloudflared
sleep 10
curl -sI https://adbuildout.contractorscalingblueprint.com/healthz | head -1   # HTTP/2 200
# and the SEO dashboard hostname
```

If the daemon fails after an upgrade, check the plist points at the current binary path
(`/opt/homebrew/bin/cloudflared`) and the credentials file is still readable by root.

## Troubleshooting

| Symptom (visitor) | Meaning | Check |
|---|---|---|
| Cloudflare **502 Bad Gateway** | tunnel is up, the local port is not answering | `docker compose ... ps`; `curl -sI http://127.0.0.1:3010/healthz` on the Mac; is the right port in the ingress rule? |
| Cloudflare **530** with error **1033** | tunnel has no connection to Cloudflare | Mac off, no internet, or `cloudflared` not running: `sudo launchctl print system/com.cloudflare.cloudflared`; kickstart; check the home internet |
| 404 from Cloudflare (tunnel page) | hostname hits the `http_status:404` catch-all | ingress rule missing for that hostname; run `cloudflare-hostnames.py` |
| Works on `ads.` but not `adbuildout.` | DNS or ingress missing for the new name | `dig +short adbuildout.… CNAME` should print `b9929fe5….cfargotunnel.com` |
| Works on LAN (`127.0.0.1:3010`) but not via tunnel | tunnel/DNS problem, not the app | see 502 / 530 rows |
| Cloudflare Access prompt on production | Access app attached to the wrong hostname | Zero Trust -> Access -> Applications; only `staging-adbuildout.` should have one |
| `CF-Connecting-IP` missing in api logs | request bypassed Cloudflare (local curl) | expected for 127.0.0.1 calls |
| Both dashboards down | tunnel or Mac problem | fix here first, then check each stack |

## Security rules

- Outbound only. Do not open router ports for "backup access"; use Tailscale (plan item 3.9).
- Keep the credentials JSON out of the repo and out of chat. If leaked: Zero Trust -> Tunnels ->
  `zms-seo-dashboard` -> refresh credentials, replace the file, kickstart.
- One rate-limiting rule (Free plan) covers `/api/*` on both hosts
  (`scripts/cloud/cloudflare-ratelimit.py`). Staging additionally requires Cloudflare Access.
- Do not put the SEO dashboard behind changes made for this project without its owner's yes.
