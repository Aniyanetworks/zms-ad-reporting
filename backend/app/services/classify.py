"""Tag every campaign with the service it sells, from its name.

Rules are matched in order against the lowercased campaign name; the first hit
wins. Names with no service word fall back to the client's `default_service`
(most clients sell one thing and name campaigns by date/structure only), and
finally to "Unclassified" so the gap is visible on the Services page.
Manual rows in campaign_service_map are never overwritten.
"""
from app.services import pg

# (substring, service) — order matters: specific before generic.
RULES: list[tuple[str, str]] = [
    ("cabinet", "Cabinet Painting"),
    ("exterior paint", "Exterior Painting"),
    ("interior paint", "Interior Painting"),
    ("kitchen refresh", "Kitchen Refresh"),
    ("kitchen", "Kitchen Remodeling"),
    ("tub to shower", "Bathroom Remodeling"),
    ("bathroom", "Bathroom Remodeling"),
    ("addition", "Additions / ADU"),
    ("adu", "Additions / ADU"),
    ("room shed", "Room Enclosures"),
    ("enclosure", "Room Enclosures"),
    ("sunroom", "Room Enclosures"),
    ("deck", "Decks"),
    ("fence", "Fences"),
    ("siding", "Siding"),
    ("roof clean", "Roof Cleaning"),
    ("roofing", "Roofing"),
    ("roof", "Roofing"),
    ("pressure", "Pressure Washing"),
    ("epoxy", "Epoxy Flooring"),
    ("e-poxy", "Epoxy Flooring"),
    ("carpet", "Carpet Installation"),
    ("lvp", "LVP Flooring"),
    ("hardwood", "Hardwood Flooring"),
    ("tile", "Tile"),
    ("grout", "Grout & Tile Cleaning"),
    ("floor", "Flooring"),
    ("window film", "Window Film"),
    ("tint", "Window Film"),
    ("window", "Windows"),
    ("landscap", "Landscaping"),
    ("lawn", "Lawn Care"),
    ("weed", "Weed Control"),
    ("tree", "Tree Service"),
    ("plumb", "Plumbing"),
    ("hvac", "HVAC"),
    ("property", "Real Estate"),
    ("realtor", "Real Estate"),
    ("home buyer", "Real Estate"),
    ("paint", "Painting"),
    ("remodel", "Remodeling"),
]

UNCLASSIFIED = "Unclassified"


def classify(campaign_name: str | None, default_service: str | None) -> str:
    name = (campaign_name or "").lower()
    for needle, service in RULES:
        if needle in name:
            return service
    return default_service or UNCLASSIFIED


def refresh_campaign_services() -> dict:
    """Re-tag every campaign seen in ad_metrics_daily (auto rows only)."""
    rows = pg.query(
        """
        select distinct m.client_id, m.platform, m.campaign_id,
               max(m.campaign_name) as campaign_name, c.default_service
        from ad_metrics_daily m join clients c on c.id = m.client_id
        group by m.client_id, m.platform, m.campaign_id, c.default_service
        """
    )
    manual = {
        (r["client_id"], r["platform"], r["campaign_id"])
        for r in pg.query("select client_id, platform, campaign_id from campaign_service_map where source = 'manual'")
    }
    counts: dict[str, int] = {}
    for r in rows:
        key = (r["client_id"], r["platform"], r["campaign_id"])
        if key in manual:
            continue
        service = classify(r["campaign_name"], r["default_service"])
        counts[service] = counts.get(service, 0) + 1
        pg.execute(
            """
            insert into campaign_service_map (client_id, platform, campaign_id, campaign_name, service, source, updated_at)
            values (%s, %s, %s, %s, %s, 'auto', now())
            on conflict (client_id, platform, campaign_id) do update
              set campaign_name = excluded.campaign_name, service = excluded.service, updated_at = now()
              where campaign_service_map.source = 'auto'
            """,
            (r["client_id"], r["platform"], r["campaign_id"], r["campaign_name"], service),
        )
    return {"campaigns": len(rows), "manual_kept": len(manual), "by_service": counts}
