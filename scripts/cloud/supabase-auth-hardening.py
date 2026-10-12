#!/usr/bin/env python3
"""Supabase Auth settings for the PRODUCTION project (ayxvikfnktlxtpgzcrok):
invite-only, 12-char passwords with letters+digits, leaked-password check,
12 h session timebox, redirect allow-list incl. the new hostnames, site_url.
Token: SUPABASE_ACCESS_TOKEN in env or plugins/meta-ads/.env of ~/zeal-paid-ads.

  python3 scripts/cloud/supabase-auth-hardening.py [--apply] [--site-url https://adbuildout.contractorscalingblueprint.com]
"""
import json
import os
import sys
import urllib.error
import urllib.request

REF = os.environ.get("SUPABASE_PROJECT_REF", "ayxvikfnktlxtpgzcrok")
PROD = "https://adbuildout.contractorscalingblueprint.com"
STAGING = "https://staging-adbuildout.contractorscalingblueprint.com"
LEGACY = ["https://ads.contractorscalingblueprint.com", "https://ads.zealmediasolutions.com"]


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
        return json.load(urllib.request.urlopen(req, timeout=30))
    except urllib.error.HTTPError as e:
        sys.exit(f"Supabase API {method} {path} -> {e.code}: {e.read()[:400].decode()}")


apply = "--apply" in sys.argv
site_url = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--site-url"), PROD)
cur = call(f"/projects/{REF}/config/auth")
allow = [u for u in (cur.get("uri_allow_list") or "").split(",") if u]
for u in [f"{PROD}/**", f"{STAGING}/**", *[f"{x}/**" for x in LEGACY], "http://localhost:3000/**"]:
    if u not in allow:
        allow.append(u)
want = {
    "site_url": site_url,
    "uri_allow_list": ",".join(allow),
    "disable_signup": True,                      # invite-only (Supabase → Auth → Users → Invite)
    "password_min_length": 12,
    "password_required_characters": "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
    "password_hibp_enabled": True,               # leaked-password protection (HaveIBeenPwned)
    "sessions_timebox": 43200,                   # 12 h hard session limit
    "refresh_token_rotation_enabled": True,
    "security_refresh_token_reuse_interval": 10,
    "mfa_totp_enroll_enabled": True,
    "mfa_totp_verify_enabled": True,
}
changes = {k: (cur.get(k), v) for k, v in want.items() if cur.get(k) != v}
if not changes:
    print("Auth config already matches.")
    sys.exit(0)
print("DRY RUN" if not apply else "APPLYING", "— auth config changes for", REF)
for k, (old, new) in changes.items():
    print(f"  {k}: {old!r} -> {new!r}")
if apply:
    call(f"/projects/{REF}/config/auth", "PATCH", {k: v for k, (_, v) in changes.items()})
    print("done. Existing passwords keep working until changed; new/reset passwords need 12+ chars.")
