"""Manual backfill CLI.

Usage (inside the api/worker container or venv):
    python -m app.cli backfill --client acme-plumbing --source meta --days 365
    python -m app.cli backfill --all --source google --days 365
"""
import argparse
import sys

from app.services import pg
from app.tasks.sync import _sync_ghl_client, _sync_google_client, _sync_meta_client

SOURCE_COLUMN = {
    "meta": "meta_ad_account_id",
    "google": "google_ads_customer_id",
    "ghl": "ghl_location_id",
}
SOURCE_FN = {
    "meta": _sync_meta_client,
    "google": _sync_google_client,
    "ghl": _sync_ghl_client,
}


def main() -> int:
    parser = argparse.ArgumentParser(prog="zms-ads")
    sub = parser.add_subparsers(dest="command", required=True)

    bf = sub.add_parser("backfill", help="Backfill one client+source (runs inline, not via Celery)")
    bf.add_argument("--client", help="client slug")
    bf.add_argument("--all", action="store_true", help="backfill every active client for the source")
    bf.add_argument("--source", required=True, choices=["meta", "google", "ghl"])
    bf.add_argument("--days", type=int, default=365, help="capped at 365 (Meta 13-month API limit)")

    args = parser.parse_args()
    if not args.client and not getattr(args, "all", False):
        parser.error("provide --client SLUG or --all")

    column = SOURCE_COLUMN[args.source]
    if args.all:
        clients = pg.get_active_clients(column)
    else:
        rows = pg.query(
            f"""
            select c.*, s.ghl_token from clients c
            left join client_secrets s on s.client_id = c.id
            where c.slug = %s and (c.{column} is not null or (%s = 'google_ads_customer_id' and c.google_lsa_customer_id is not null))
            """,
            (args.client, column),
        )
        if not rows:
            print(f"No client with slug '{args.client}' and a {column} configured", file=sys.stderr)
            return 1
        clients = rows

    fn = SOURCE_FN[args.source]
    for client in clients:
        print(f"Backfilling {args.source} for {client['slug']} ({args.days} days)...")
        fn(client, args.days)
        if args.source == "google" and client.get("google_lsa_customer_id"):
            print(f"  + dedicated Local Services account for {client['slug']}...")
            fn(client, args.days, True)
    print("Done. Check sync_runs / settings page for per-client results.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
