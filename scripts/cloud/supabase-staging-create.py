#!/usr/bin/env python3
"""Create the free-tier STAGING Supabase project `zms-ads-staging` in org zms-ads,
store its generated DB password in ~/.config/zms/supabase-staging.env (0600),
wait until healthy, then print the .env.staging values to fill in. Idempotent.

  python3 scripts/cloud/supabase-staging-create.py [--apply]
Afterwards: scripts/cloud/supabase-migrate.sh staging   (applies supabase/migrations)
"""
import json
import os
import secrets
import string
import sys
import time
import urllib.error
import urllib.request

ORG = "slaqxvctocwhyylhkpmp"  # zms-ads
NAME = "zms-ads-staging"
REGION = "us-east-2"


def token() -> str:
    t = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not t:
        p = os.path.expanduser("~/zeal-paid-ads/plugins/meta-ads/.env")
        if os.path.exists(p):
            for line in open(p):
                if line.startswith("SUPABASE_ACCESS_TOKEN="):
                    t = line.split("=", 1)[1].strip()
    if not t:
        sys.exit("SUPABASE_ACCESS_TOKEN not found")
    return t


def call(path, method="GET", data=None):
    req = urllib.request.Request(
        "https://api.supabase.com/v1" + path, method=method,
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
        data=json.dumps(data).encode() if data is not None else None,
    )
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        sys.exit(f"Supabase API {method} {path} -> {e.code}: {e.read()[:400].decode()}")


apply = "--apply" in sys.argv
existing = [p for p in call("/projects") if p["name"] == NAME]
if existing:
    ref = existing[0]["id"]
    print(f"project exists: {ref} ({existing[0]['status']})")
else:
    print(f"{'CREATE' if apply else 'would create'} project {NAME} in org {ORG}, region {REGION}, free tier")
    if not apply:
        sys.exit(0)
    pw = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32))
    res = call("/projects", "POST", {"name": NAME, "organization_id": ORG, "region": REGION, "db_pass": pw})
    ref = res["id"]
    d = os.path.expanduser("~/.config/zms")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "supabase-staging.env")
    with open(path, "w") as f:
        f.write(f"SUPABASE_STAGING_REF={ref}\nSUPABASE_STAGING_DB_PASSWORD={pw}\n")
    os.chmod(path, 0o600)
    print(f"created {ref}; DB password saved to {path}")

for _ in range(40):
    st = call(f"/projects/{ref}")
    if st.get("status") == "ACTIVE_HEALTHY":
        break
    print("  status:", st.get("status"), "… waiting")
    time.sleep(15)
keys = call(f"/projects/{ref}/api-keys?reveal=true")
anon = next((k["api_key"] for k in keys if k.get("name") in ("anon", "publishable") or k.get("type") == "publishable"), None)
service = next((k["api_key"] for k in keys if k.get("name") in ("service_role", "secret") or k.get("type") == "secret"), None)
print("\nFill backend/.env.staging (never commit):")
print(f"  ENVIRONMENT=staging\n  SUPABASE_URL=https://{ref}.supabase.co\n  SUPABASE_ANON_KEY={'<anon key printed above>' if not anon else '(see ~/.config/zms/supabase-staging.env — appended)'}")
d = os.path.expanduser("~/.config/zms/supabase-staging.env")
with open(d, "a") as f:
    if anon:
        f.write(f"SUPABASE_STAGING_ANON_KEY={anon}\n")
    if service:
        f.write(f"SUPABASE_STAGING_SERVICE_ROLE_KEY={service}\n")
    f.write(f"SUPABASE_STAGING_DB_URL=postgresql://postgres.{ref}:<password>@aws-0-{REGION}.pooler.supabase.com:5432/postgres\n")
print(f"  keys + pooler URL template appended to {d}")
