"""UTM + conversion-tracking audit across all active clients. Read-only."""
from app.services import pg
from app.services.google import get_google_ads_client

print("## Meta: UTM coverage per campaign that spent in the last 7 days")
for r in pg.query("""
    with sp as (select client_id, campaign_id, campaign_name, sum(spend) s from ad_metrics_daily
                where platform = 'meta' and date >= current_date - 7 group by 1, 2, 3 having sum(spend) > 0)
    select c.name, sp.campaign_name, round(sp.s) spend7,
           count(cr.*) filter (where cr.effective_status = 'ACTIVE') ads,
           count(cr.*) filter (where cr.effective_status = 'ACTIVE' and cr.url_tags ilike %s) medium_ok,
           count(cr.*) filter (where cr.effective_status = 'ACTIVE' and (cr.url_tags is null or cr.url_tags not ilike %s)) untagged,
           string_agg(distinct substring(cr.url_tags from 'utm_medium=[^&]*'), ',') filter (where cr.effective_status = 'ACTIVE') medium
    from sp join clients c on c.id = sp.client_id
    left join meta_ad_creatives cr on cr.campaign_id = sp.campaign_id
    group by 1, 2, 3 order by 1, 3 desc""", ("%utm_medium={{adset.name}}%", "%utm_%")):
    print(f"{r['name'][:22]:22} {(r['campaign_name'] or '')[:42]:42} ${r['spend7']:>6} ads={r['ads']} ok={r['medium_ok']} untagged={r['untagged']} {r['medium']}")

print("\n## Integration health (non-grey)")
for r in pg.query("""
    select c.name, h.check_key, h.status, h.detail from integration_health h join clients c on c.id = h.client_id
    where c.is_active and h.status <> 'grey'
      and h.check_key in ('utm_tags', 'pixel_capi', 'ghl_paid_attribution', 'ghl_appointments', 'ghl_won', 'landing_pages')
    order by c.name, h.check_key"""):
    print(f"{r['name'][:22]:22} {r['check_key']:22} {r['status']:6} {r['detail'][:140]}")

print("\n## Google: auto-tagging, URL suffix, conversion actions that matter")
svc = get_google_ads_client().get_service("GoogleAdsService")
for c in pg.query("select name, google_ads_customer_id cid from clients where is_active and google_ads_customer_id is not null order by name"):
    cid = c["cid"]
    try:
        cust = list(svc.search(customer_id=cid, query="select customer.auto_tagging_enabled, customer.final_url_suffix from customer"))[0].customer
        spend = list(svc.search(customer_id=cid, query="select metrics.cost_micros, metrics.conversions from customer where segments.date during LAST_30_DAYS"))
    except Exception as exc:  # noqa: BLE001
        print(f"{c['name']}: {str(exc)[:120]}")
        continue
    cost = sum(r.metrics.cost_micros for r in spend) / 1e6
    conv = sum(r.metrics.conversions for r in spend)
    print(f"\n{c['name']}: spend30=${cost:,.0f} conv30={conv:.0f} autotag={cust.auto_tagging_enabled} suffix={cust.final_url_suffix or '-'}")
    if cost < 1:
        continue
    counts: dict[str, list[float]] = {}
    for r in svc.search(customer_id=cid, query="select segments.conversion_action_name, metrics.conversions, metrics.all_conversions from customer where segments.date during LAST_30_DAYS"):
        n = counts.setdefault(r.segments.conversion_action_name, [0.0, 0.0])
        n[0] += r.metrics.conversions
        n[1] += r.metrics.all_conversions
    for r in svc.search(customer_id=cid, query="select conversion_action.name, conversion_action.category, conversion_action.type, conversion_action.primary_for_goal from conversion_action where conversion_action.status = 'ENABLED'"):
        a = r.conversion_action
        n = counts.get(a.name, [0.0, 0.0])
        if a.primary_for_goal or n[1]:
            print(f"  {'PRIMARY' if a.primary_for_goal else 'second '} {a.category.name:20} {a.type_.name:30} conv={n[0]:.0f} all={n[1]:.0f}  {a.name[:55]}")
