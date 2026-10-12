#!/usr/bin/env python3
"""Add the production + staging hostnames: DNS CNAMEs → the existing tunnel, and
tunnel ingress rules (remote-managed config). Idempotent. Leaves every existing
record and ingress rule (ads.*, setter.*, SEO dashboard) untouched.

  python3 scripts/cloud/cloudflare-hostnames.py          # plan
  python3 scripts/cloud/cloudflare-hostnames.py --apply  # do it
"""
from _cf import CF, PROD_HOST, STAGING_HOST, TUNNEL_ID, apply_flag

WANT = {PROD_HOST: "http://localhost:3010", STAGING_HOST: "http://localhost:3011"}

cf = CF()
apply = apply_flag()
zone = cf.zone_id()
records = {r["name"]: r for r in cf.call(f"/zones/{zone}/dns_records?per_page=200")}
target = f"{TUNNEL_ID}.cfargotunnel.com"

for host in WANT:
    if host in records:
        print(f"DNS  {host}: exists -> {records[host]['content']} (proxied={records[host].get('proxied')})")
        continue
    print(f"DNS  {host}: CREATE CNAME -> {target} (proxied)")
    if apply:
        cf.call(f"/zones/{zone}/dns_records", "POST", {
            "type": "CNAME", "name": host, "content": target, "proxied": True, "ttl": 1,
            "comment": "ZMS ads dashboard via tunnel (hardening 2026-09)",
        })

cfg = cf.call(f"/accounts/{cf.acct}/cfd_tunnel/{TUNNEL_ID}/configurations")["config"]
ingress = cfg["ingress"]
have = {i.get("hostname"): i["service"] for i in ingress if i.get("hostname")}
missing = [{"hostname": h, "service": s} for h, s in WANT.items() if h not in have]
for h, s in WANT.items():
    print(f"TUN  {h}: " + (f"exists -> {have[h]}" if h in have else f"ADD -> {s}"))
if missing and apply:
    cfg["ingress"] = ingress[:-1] + missing + [ingress[-1]]  # keep the http_status:404 catch-all last
    res = cf.call(f"/accounts/{cf.acct}/cfd_tunnel/{TUNNEL_ID}/configurations", "PUT", {"config": cfg})
    print(f"TUN  config version now {res.get('version')}")
if apply:
    print("\nVerify from outside the LAN:\n  curl -sI https://%s/healthz\n  curl -sI https://%s/healthz   (503/404 until staging stack runs)" % (PROD_HOST, STAGING_HOST))
