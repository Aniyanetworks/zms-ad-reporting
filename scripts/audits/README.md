# Read-only audits

Ad-hoc analyses run during the 2026-10 tracking and creative reviews. All three only
read (Supabase + Meta/Google reporting APIs); none writes to Meta, Google or GHL.
Run them inside the API container so they pick up its settings and credentials:

    docker compose -p zms-ad-reporting exec -T api python - < scripts/audits/tracking_audit.py
    docker compose -p zms-ad-reporting exec -T api python - < scripts/audits/angle_report.py
    docker compose -p zms-ad-reporting exec -T api python - < scripts/audits/google_call_audit.py

| Script | Answers |
|---|---|
| `tracking_audit.py` | Which spending Meta campaigns carry `utm_medium={{adset.name}}`; pixel/CAPI and GHL attribution status from `integration_health`; Google auto-tagging, final URL suffix and which conversion actions actually record |
| `angle_report.py` | Spend, leads, CPL and CTR per creative angle (headline + opening line) per client and service over the last 30 days, with ad-set bookings from GHL |
| `google_call_audit.py` | Call reporting, call conversion actions and their duration thresholds, call assets on enabled campaigns, and calls per campaign |
