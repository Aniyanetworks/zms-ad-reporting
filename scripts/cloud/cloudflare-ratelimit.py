#!/usr/bin/env python3
"""Zone rate-limiting rule for the API paths on the production + staging hosts.
Free plan allows one rate-limiting rule with a 10-second period; the rule below
blocks an IP for 10 s after 60 requests/10 s to /api/* (≈ 360/min). Idempotent.

  python3 scripts/cloud/cloudflare-ratelimit.py [--apply]
"""
from _cf import CF, PROD_HOST, STAGING_HOST, apply_flag

cf = CF()
apply = apply_flag()
zone = cf.zone_id()
expr = (f'(http.host in {{"{PROD_HOST}" "{STAGING_HOST}"}} and starts_with(http.request.uri.path, "/api/"))')
rule = {
    "description": "ZMS ads API rate limit",
    "expression": expr,
    "action": "block",
    "ratelimit": {"characteristics": ["ip.src", "cf.colo.id"], "period": 10, "requests_per_period": 60,
                  "mitigation_timeout": 10},
}
rulesets = cf.call(f"/zones/{zone}/rulesets?phase=http_ratelimit") or []
rs = next((r for r in rulesets if r["phase"] == "http_ratelimit"), None)
existing = None
if rs:
    full = cf.call(f"/zones/{zone}/rulesets/{rs['id']}")
    existing = next((r for r in full.get("rules", []) if r.get("description") == rule["description"]), None)
if existing:
    print("RL   rule exists:", existing["expression"])
else:
    print("RL   CREATE:", expr, "| 60 req / 10 s per IP -> block 10 s")
    if apply:
        if rs:
            cf.call(f"/zones/{zone}/rulesets/{rs['id']}/rules", "POST", rule)
        else:
            cf.call(f"/zones/{zone}/rulesets", "POST", {"name": "ZMS rate limits", "kind": "zone",
                                                        "phase": "http_ratelimit", "rules": [rule]})
        print("RL   created")
