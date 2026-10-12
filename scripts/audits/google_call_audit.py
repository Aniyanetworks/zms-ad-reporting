"""Google Ads phone-call tracking audit. Read-only.

Per account: whether call reporting is on, which conversion action calls default to,
every call-type conversion action with its minimum duration, call assets on enabled
campaigns, and calls per enabled campaign over the last 30 days.
"""
from app.services import pg
from app.services.google import get_google_ads_client

svc = get_google_ads_client().get_service("GoogleAdsService")


def q(cid: str, gaql: str):
    try:
        return list(svc.search(customer_id=cid, query=gaql))
    except Exception as exc:  # noqa: BLE001
        print(f"  query failed: {str(exc)[:160]}")
        return []


for c in pg.query("select name, google_ads_customer_id cid from clients where is_active and google_ads_customer_id is not null order by name"):
    cid = c["cid"]
    print(f"\n== {c['name']} ({cid})")
    cust = q(cid, "select customer.call_reporting_setting.call_reporting_enabled, customer.call_reporting_setting.call_conversion_reporting_enabled, customer.call_reporting_setting.call_conversion_action from customer")
    if cust:
        s = cust[0].customer.call_reporting_setting
        print(f"  call reporting={s.call_reporting_enabled} call conversions={s.call_conversion_reporting_enabled} default action={s.call_conversion_action.split('/')[-1]}")
    for r in q(cid, "select conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.category, conversion_action.primary_for_goal, conversion_action.phone_call_duration_seconds from conversion_action where conversion_action.status = 'ENABLED'"):
        a = r.conversion_action
        if "CALL" in a.type_.name or a.category.name == "PHONE_CALL_LEAD":
            print(f"  {a.id:>11} {'PRIMARY' if a.primary_for_goal else 'second '} {a.type_.name:34} >= {a.phone_call_duration_seconds}s  {a.name}")
    has_website_call = any(r.conversion_action.type_.name == "WEBSITE_CALL" for r in q(cid, "select conversion_action.type from conversion_action where conversion_action.status = 'ENABLED'"))
    print(f"  calls-from-website action: {'yes' if has_website_call else 'MISSING'}")
    with_asset = {r.campaign.name for r in q(cid, "select campaign.name, campaign.status, campaign_asset.status, asset.id from campaign_asset where campaign_asset.field_type = CALL")
                  if r.campaign_asset.status.name == "ENABLED"}
    for r in q(cid, "select campaign.name, campaign.advertising_channel_type, metrics.phone_calls, metrics.cost_micros from campaign where segments.date during LAST_30_DAYS and campaign.status = 'ENABLED'"):
        ch = r.campaign.advertising_channel_type.name
        asset = "n/a" if ch == "LOCAL_SERVICES" else ("yes" if r.campaign.name in with_asset else "NO CALL ASSET")
        print(f"  {r.campaign.name[:36]:36} {ch:16} ${r.metrics.cost_micros / 1e6:>7,.0f} calls={r.metrics.phone_calls:>3} call asset={asset}")
