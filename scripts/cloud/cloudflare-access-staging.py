#!/usr/bin/env python3
"""Put Cloudflare Access (Zero Trust, free ≤50 users) in front of staging:
one-time-PIN login, allow only @zealmediasolutions.com plus listed emails.
Idempotent. Creates the Zero Trust organization if the account has none.

  python3 scripts/cloud/cloudflare-access-staging.py [--apply] [--email a@b.com ...] [--team-name zms]
"""
import sys

from _cf import CF, STAGING_HOST, apply_flag

cf = CF()
apply = apply_flag()
emails = [a for i, a in enumerate(sys.argv) if i and sys.argv[i - 1] == "--email"]
team = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--team-name"), "zealmedia")

org = cf.call(f"/accounts/{cf.acct}/access/organizations")
if not org or not org.get("auth_domain"):
    print(f"ORG  none -> CREATE Zero Trust org '{team}.cloudflareaccess.com'")
    if apply:
        org = cf.call(f"/accounts/{cf.acct}/access/organizations", "POST",
                      {"name": "Zeal Media", "auth_domain": f"{team}.cloudflareaccess.com", "is_ui_read_only": False})
else:
    print(f"ORG  {org['auth_domain']}")

idps = cf.call(f"/accounts/{cf.acct}/access/identity_providers") or []
otp = [i for i in idps if i["type"] == "onetimepin"]
if not otp:
    print("IDP  CREATE one-time PIN (email code) login")
    if apply:
        otp = [cf.call(f"/accounts/{cf.acct}/access/identity_providers", "POST",
                       {"name": "Email one-time PIN", "type": "onetimepin", "config": {}})]
else:
    print("IDP  one-time PIN exists")

apps = cf.call(f"/accounts/{cf.acct}/access/apps?per_page=50") or []
app = next((a for a in apps if a.get("domain") == STAGING_HOST), None)
include = [{"email_domain": {"domain": "zealmediasolutions.com"}}] + [{"email": {"email": e}} for e in emails]
if app:
    print(f"APP  {STAGING_HOST}: exists (id {app['id']})")
else:
    print(f"APP  {STAGING_HOST}: CREATE self-hosted app, 24h session, allow zealmediasolutions.com{' + ' + ', '.join(emails) if emails else ''}")
    if apply:
        app = cf.call(f"/accounts/{cf.acct}/access/apps", "POST", {
            "name": "ZMS Ads — staging", "domain": STAGING_HOST, "type": "self_hosted",
            "session_duration": "24h", "auto_redirect_to_identity": True,
            "allowed_idps": [otp[0]["id"]] if otp else [],
            "policies": [{"name": "Zeal team", "decision": "allow", "include": include}],
        })
        print(f"APP  created id {app['id']}")
if apply:
    print("\nStaging now requires an email PIN before any request reaches the Mac mini.")
