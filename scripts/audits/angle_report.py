"""Best and worst creative angles per client and service, last 30 days. Read-only.

An "angle" is the ad's headline plus its opening line. Leads and spend come from Meta
per ad; bookings come from GHL and only resolve to the ad set (utm_medium = ad set name),
so `booked` is the ad set's total, shared by every ad in it. Ad sets that share a name
(US Pro has many called "Broad") share one booking count, counted once per angle.
"""
import collections

from app.services import pg

rows = pg.query("""
with ad as (
  select m.client_id, m.campaign_id, m.adset_id, m.ad_id, sum(m.spend) spend, sum(m.leads) leads,
         sum(m.impressions) imps, sum(m.unique_link_clicks) ulc
  from ad_level_metrics_daily m where m.platform = 'meta' and m.date >= current_date - 30
  group by 1, 2, 3, 4 having sum(m.spend) >= 40),
asn as (select distinct on (adset_id) adset_id, adset_name from adset_metrics_daily
        where date >= current_date - 45 order by adset_id, date desc),
asb as (select client_id, lower(trim(adset_name)) an, sum(appointments) appts from ghl_adset_daily
        where date >= current_date - 30 group by 1, 2)
select c.name client, coalesce(sm.service, '?') service, lower(trim(asn.adset_name)) adset_name, ad.spend, ad.leads, ad.imps, ad.ulc,
       cr.title, cr.body, asb.appts adset_appts
from ad join clients c on c.id = ad.client_id
left join campaign_service_map sm on sm.campaign_id = ad.campaign_id and sm.platform = 'meta'
left join asn on asn.adset_id = ad.adset_id
left join asb on asb.client_id = ad.client_id and asb.an = lower(trim(asn.adset_name))
left join meta_ad_creatives cr on cr.ad_id = ad.ad_id""")

angles: dict[tuple, dict] = collections.defaultdict(lambda: {"spend": 0.0, "leads": 0.0, "ulc": 0.0, "imps": 0.0, "booked": {}})
for r in rows:
    key = (r["service"], r["client"], (r["title"] or "")[:50], " ".join((r["body"] or "").split())[:40])
    a = angles[key]
    a["spend"] += float(r["spend"] or 0)
    a["leads"] += float(r["leads"] or 0)
    a["ulc"] += float(r["ulc"] or 0)
    a["imps"] += float(r["imps"] or 0)
    a["booked"][r["adset_name"]] = r["adset_appts"] or 0

service = None
for (svc, client, title, opener), a in sorted(angles.items(), key=lambda kv: (kv[0][0], kv[0][1], -kv[1]["spend"])):
    if svc != service:
        service = svc
        print(f"\n## {svc}")
    cpl = f"${a['spend'] / a['leads']:.0f}" if a["leads"] else "—"
    ctr = f"{a['ulc'] / a['imps'] * 100:.1f}%" if a["imps"] else "—"
    print(f"  {client[:20]:20} ${a['spend']:>6.0f} {a['leads']:>3.0f} leads  CPL {cpl:>5}  CTR {ctr:>5}  ad-set booked {sum(a['booked'].values()):>3} | {title} || {opener}")
