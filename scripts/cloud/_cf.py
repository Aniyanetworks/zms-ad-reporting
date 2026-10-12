"""Shared Cloudflare helper (stdlib only — the Homebrew Pythons on the Mac mini
have a broken pyexpat, but json/urllib work). Token from ~/.config/zms/cloudflare.env:
CF_API_TOKEN, CF_ACCOUNT_ID. Never prints the token."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE = "https://api.cloudflare.com/client/v4"
ZONE_NAME = "contractorscalingblueprint.com"
TUNNEL_ID = "b9929fe5-4b97-4708-acdb-734c224430e5"  # zms-seo-dashboard tunnel (shared with the SEO stack)
PROD_HOST = "adbuildout.contractorscalingblueprint.com"
STAGING_HOST = "staging-adbuildout.contractorscalingblueprint.com"


def load_env() -> tuple[str, str]:
    path = os.path.expanduser("~/.config/zms/cloudflare.env")
    env = dict(os.environ)
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"'))
    tok, acct = env.get("CF_API_TOKEN"), env.get("CF_ACCOUNT_ID")
    if not tok or not acct:
        sys.exit("CF_API_TOKEN / CF_ACCOUNT_ID missing (expected in ~/.config/zms/cloudflare.env)")
    return tok, acct


class CF:
    def __init__(self) -> None:
        self.tok, self.acct = load_env()

    def call(self, path: str, method: str = "GET", data=None):
        req = urllib.request.Request(
            BASE + path, method=method,
            headers={"Authorization": f"Bearer {self.tok}", "Content-Type": "application/json"},
            data=json.dumps(data).encode() if data is not None else None,
        )
        try:
            body = json.load(urllib.request.urlopen(req, timeout=30))
        except urllib.error.HTTPError as e:
            raise SystemExit(f"Cloudflare API {method} {path} -> HTTP {e.code}: {e.read()[:500].decode()}") from None
        if not body.get("success", True):
            raise SystemExit(f"Cloudflare API {method} {path} failed: {body.get('errors')}")
        return body["result"]

    def zone_id(self, name: str = ZONE_NAME) -> str:
        zones = self.call(f"/zones?name={name}")
        if not zones:
            sys.exit(f"zone {name} not found")
        return zones[0]["id"]


def apply_flag() -> bool:
    if "--apply" in sys.argv:
        return True
    print("DRY RUN — showing planned changes only. Re-run with --apply to execute.\n")
    return False
