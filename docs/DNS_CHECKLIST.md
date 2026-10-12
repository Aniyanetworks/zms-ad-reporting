# DNS and Cloudflare checklist

Zone: `contractorscalingblueprint.com` (Cloudflare, Free plan). Tunnel:
`zms-seo-dashboard`, id `b9929fe5-4b97-4708-acdb-734c224430e5`, shared with the SEO dashboard.
Every step below is idempotent and leaves existing records and ingress rules untouched.
Nothing in this file is applied yet: all items are TODO (Carl) unless marked otherwise.

## Records

| Hostname | Type | Target | Proxied | Purpose | Status |
|---|---|---|---|---|---|
| `ads.` | CNAME | `b9929fe5-4b97-4708-acdb-734c224430e5.cfargotunnel.com` | yes | existing production alias | exists |
| `setter.` | CNAME | same tunnel | yes | public setter leaderboard (`/leaderboard` only) | exists |
| `adbuildout.` | CNAME | same tunnel | yes | **production** | TODO (Carl) |
| `staging-adbuildout.` | CNAME | same tunnel | yes | staging, behind Cloudflare Access | TODO (Carl) |
| `mcp.` | none | | | reserved, deferred (`REMOTE_MCP.md`) | do not create |

## Tunnel ingress (remote-managed)

| Hostname | Service | Status |
|---|---|---|
| `ads.`, `setter.` | `http://localhost:3010` | exists |
| SEO dashboard hostnames | `http://localhost:3000` / `:8000` | exists, do not touch |
| `adbuildout.` | `http://localhost:3010` | TODO (Carl) |
| `staging-adbuildout.` | `http://localhost:3011` | TODO (Carl) |
| catch-all | `http_status:404` | exists, must stay last |

## Commands

Prerequisite: `~/.config/zms/cloudflare.env` with `CF_API_TOKEN` and `CF_ACCOUNT_ID` (mode 600).
The scripts use only the Python standard library, so the broken Homebrew Pythons still work for
them; if `python3` fails anyway, run inside a container:
`docker run --rm -v "$PWD/scripts:/s" -v "$HOME/.config/zms:/root/.config/zms:ro" python:3.12-slim python3 /s/cloud/<script>.py`.

```bash
cd ~/zms-ad-reporting

# 1. DNS CNAMEs + tunnel ingress (dry run, then apply)
python3 scripts/cloud/cloudflare-hostnames.py
python3 scripts/cloud/cloudflare-hostnames.py --apply

# 2. Cloudflare Access on staging (email one-time PIN, @zealmediasolutions.com; add outside emails with --email)
python3 scripts/cloud/cloudflare-access-staging.py
python3 scripts/cloud/cloudflare-access-staging.py --apply            # [--email someone@example.com]

# 3. Rate-limiting rule: 60 requests / 10 s per IP on /api/* for both hosts (Free plan: one rule)
python3 scripts/cloud/cloudflare-ratelimit.py
python3 scripts/cloud/cloudflare-ratelimit.py --apply

# 4. Supabase Auth: site_url, redirect allow-list for the new hosts, password policy, invite-only
python3 scripts/cloud/supabase-auth-hardening.py
python3 scripts/cloud/supabase-auth-hardening.py --apply
```

Dashboard alternative for step 1: Zero Trust -> Networks -> Tunnels -> `zms-seo-dashboard` ->
Public Hostname -> Add (this creates the CNAME too). Never edit `~/.cloudflared/config.yml` for
ingress; it is ignored (see `CLOUDFLARE_TUNNEL.md`).

After step 1 the production hostname answers immediately (same container as `ads.`). Staging
returns 502 until the staging compose project runs on 3011.

## App configuration that must match

| Setting | Value | Where |
|---|---|---|
| `DASHBOARD_URL` | `https://adbuildout.contractorscalingblueprint.com` | `backend/.env` |
| `ALLOWED_ORIGINS` | `["https://ads.contractorscalingblueprint.com"]` (legacy alias) | `backend/.env` |
| `allowedDevOrigins` | ads., setter., adbuildout., staging-adbuildout. | `frontend/next.config.ts` (done in code) |
| Supabase Auth `site_url` + `uri_allow_list` | adbuildout, staging-adbuildout, ads (both zones), localhost | hardening script |
| Plugin `dashboard_base_url` / `plugin_api_base` | `https://adbuildout.contractorscalingblueprint.com[/api/plugin]` | `~/zeal-paid-ads/plugins/meta-ads/config.json`, TODO (Carl) after cutover; `ads.` keeps working meanwhile |
| Missing WAF managed rule on the zone (noted 2026-09-10) | re-add | Cloudflare -> Security -> WAF, TODO (Carl) |

## OAuth callback URLs (register only when the flow exists)

From `DEPLOYMENT_PLAN.md` section 4. Today there are no live OAuth flows (Meta uses a system-user
token, Google a refresh token from `.env`).

| Provider | Production | Staging | Local |
|---|---|---|---|
| Supabase Auth (invite / magic link redirect) | `https://adbuildout.contractorscalingblueprint.com/auth/callback` | `https://staging-adbuildout.contractorscalingblueprint.com/auth/callback` | `http://localhost:3000/auth/callback` |
| Meta OAuth (future) | `https://adbuildout.…/api/integrations/meta/callback` | `https://staging-adbuildout.…/api/integrations/meta/callback` | `http://localhost:3000/api/integrations/meta/callback` |
| Google OAuth (future) | `…/api/integrations/google/callback` | same on staging host | localhost |
| GoHighLevel (future) | `…/api/integrations/ghl/callback` | same on staging host | localhost |
| Remote MCP (deferred) | `https://mcp.contractorscalingblueprint.com/oauth/callback` | none | none |

Register production and staging as separate redirect URIs in each provider console; never a
wildcard.

## Verification from outside the LAN

Run from a phone hotspot or any machine not on the home network.

```bash
H=adbuildout.contractorscalingblueprint.com

# DNS resolves to Cloudflare (not the home IP)
dig +short $H CNAME; dig +short $H A

# HTTPS, edge headers, web liveness
curl -sI https://$H/healthz | grep -iE '^HTTP|cf-ray|server|strict-transport'
curl -s  https://$H/healthz            # {"status":"ok","service":"web",...}
curl -s  https://$H/api/health | jq .  # status ok, 200

# TLS certificate is Cloudflare's, valid
openssl s_client -connect $H:443 -servername $H </dev/null 2>/dev/null | openssl x509 -noout -issuer -dates

# Plain HTTP redirects to HTTPS
curl -sI http://$H/ | head -1

# Auth gate: unauthenticated dashboard request redirects to /login
curl -sI https://$H/ | grep -iE '^HTTP|location'

# API refuses without a token
curl -s -o /dev/null -w '%{http_code}\n' https://$H/api/me          # 401

# Staging is behind Access (302 to cloudflareaccess.com login)
curl -sI https://staging-$H/healthz | grep -iE '^HTTP|location'

# Rate rule: burst 80 requests, expect some 429s from Cloudflare
for i in $(seq 80); do curl -s -o /dev/null -w '%{http_code} ' https://$H/api/health/live; done; echo

# Nothing listens on the home IP directly
nmap -Pn -p 22,3000,3010,3011,8000,8010,8011 <home public IP>
```

## Do not claim "live" until

All of these have been tested **from outside the LAN**, by a person, and the result written in
the deploy notes:

1. Domain resolves through Cloudflare and `cf-ray` is present.
2. HTTPS certificate valid; HTTP redirects to HTTPS; HSTS header present.
3. Sign-in works for the owner and one media buyer; a viewer cannot approve.
4. `GET /api/health` is 200 `ok` and `/healthz` is 200.
5. Staging shows the Cloudflare Access prompt; production does not.
6. Rate rule returns 429 under a burst; `/api/docs` is 404 in production.
7. Home IP exposes no ports (nmap above), Remote Login is off or Tailscale-only.
8. The SEO dashboard hostnames still answer (shared tunnel).

## report.contractorscalingblueprint.com (2026-09-28)

Primary dashboard address from 2026-09-28. Ad blockers (Brave Shields, uBlock Origin,
AdBlock) block scripts and styles from any host starting with `ads.`, which left the page
unstyled and empty in browsers with a blocker. `report.` → same tunnel target
(`localhost:3010`), proxied CNAME to the tunnel; `ads.` still serves the same app.
Changed: tunnel ingress (config version 8), DNS CNAME, `DASHBOARD_URL` + `CORS_ORIGINS` in
`backend/.env`, Supabase auth `site_url` and `uri_allow_list`.
