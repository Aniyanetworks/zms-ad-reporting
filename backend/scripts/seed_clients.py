"""Seed the clients registry from a CSV.

CSV columns: name,slug,meta_ad_account_id,google_ads_customer_id,ghl_location_id
(header row required; empty cells become NULL)

Usage:
    python scripts/seed_clients.py clients.csv
"""
import csv
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import pg  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 1

    with open(sys.argv[1], newline="") as f:
        rows = list(csv.DictReader(f))

    for row in rows:
        google_id = (row.get("google_ads_customer_id") or "").strip()
        pg.execute(
            """
            insert into clients (name, slug, meta_ad_account_id, google_ads_customer_id, ghl_location_id)
            values (%s, %s, %s, %s, %s)
            on conflict (slug) do update set
                name = excluded.name,
                meta_ad_account_id = excluded.meta_ad_account_id,
                google_ads_customer_id = excluded.google_ads_customer_id,
                ghl_location_id = excluded.ghl_location_id
            """,
            (
                row["name"].strip(),
                row["slug"].strip().lower(),
                (row.get("meta_ad_account_id") or "").strip() or None,
                re.sub(r"\D", "", google_id) or None,
                (row.get("ghl_location_id") or "").strip() or None,
            ),
        )
        print(f"upserted {row['slug']}")
    print(f"\n{len(rows)} clients seeded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
