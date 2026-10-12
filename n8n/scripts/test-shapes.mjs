// Fixture runs of the heavier Shape nodes. node n8n/scripts/test-shapes.mjs
import assert from "node:assert/strict";
import { runShape } from "./shape.mjs";

const admin = { id: "u1", email: "a@x.com", role: "admin", full_name: null };
let ok = 0;
const t = async (name, fn) => { try { await fn(); ok++; console.log("ok  ", name); } catch (e) { console.log("FAIL", name, "\n", e); process.exitCode = 1; } };

const TODAY_DATA = {
  clients: [
    { id: "c1", name: "Acme Roofing", slug: "acme", booking_system: "ghl", target_cpba: 200, ghl_location_id: "loc1",
      spend_1: 120, leads_1: 2, spend_3: 400, leads_3: 0, spend_7: 900, leads_7: 9, spend_30: 4000, leads_30: 50,
      spend_prev7: 700, leads_prev7: 10, last_lead: "2026-10-05", booked_1: 0, booked_7: 3, booked_30: 15, booked_prev7: 4 },
    { id: "c2", name: "Bolt Paint", slug: "bolt", booking_system: "none", target_cpba: null, ghl_location_id: null,
      spend_1: 50, leads_1: 1, spend_3: 150, leads_3: 3, spend_7: 300, leads_7: 6, spend_30: 1200, leads_30: 30,
      spend_prev7: 300, leads_prev7: 6, last_lead: "2026-10-11", booked_1: null, booked_7: null, booked_30: null, booked_prev7: null },
  ],
  dry: [{ client_id: "c2", platform: "meta", name: "Bolt - Cabinets", spend_3: 90 }],
  ad_campaigns: { "ad9": "Acme - Roof Replacement" },
  briefs: [{ slug: "acme", brief_date: "2026-10-11", score: "red", platforms: { totals: { expected_cpba_green: 180 } }, findings: [
    { kind: "sop_verdict", verdict: "kill", gate: "Gate B: 0 scheduled after 3.2×Tₛ", entity_name: "Acme - Roof Replacement", decision: { next_step: "Pause it. Then rebuild." } },
    { kind: "sop_verdict", verdict: "diagnose", gate: "Gate A: CPAₛ near target: $210", layer: "creative — hook rate 12% (<20%): new hook", entity_name: "Acme - Siding" },
    { kind: "creative_signal", play: "new_hook", severity: "yellow", entity_type: "ad", entity_id: "ad9", entity_name: "Video 1", text: "hook 12% (<20%)", message: "Video 1: new hook — hook 12%", next_step: "Test 2–3 new openings." },
    { kind: "missing_utm", severity: "red", message: "3 ads in Acme - Roof Replacement lack utm", entity_type: "campaign", entity_name: "Acme - Roof Replacement" },
  ] }],
  health: [{ slug: "acme", check_key: "pixel_capi" }],
};

await t("today: buildCards", async () => {
  const out = await runShape("today", { data: TODAY_DATA, user: admin, input: { y: "2026-10-11" } });
  const d = out.body;
  assert.equal(d.date, "2026-10-11");
  assert.equal(d.clients.length, 2);
  assert.equal(d.clients[0].slug, "acme");
  assert.equal(d.clients[0].status, "red");
  assert.equal(d.counts.red, 1);
  const kill = d.clients[0].issues.find((i) => i.play === "kill");
  assert.ok(kill && kill.text.includes("0 booked after spending 3.2× the target"), kill?.text);
  assert.ok(d.clients[0].issues.some((i) => i.play === "integration" && i.text.startsWith("Pixel / CAPI")));
  assert.ok(d.clients[0].issues.some((i) => i.play === "no_leads" && i.text.includes("last lead Oct 5")));
  assert.equal(d.clients[1].booked, null);
  assert.equal(d.totals.spend.d7, 1200);
  console.log("      top action:", d.top_actions[0].icon, d.top_actions[0].label, "—", d.top_actions[0].text);
});

await t("plays: card by slug", async () => {
  const out = await runShape("client-plays", { data: TODAY_DATA, req: { headers: {}, query: {}, params: { slug: "bolt" } }, user: admin, input: { y: "2026-10-11" } });
  assert.equal(out.body.card.slug, "bolt");
});

const CREATIVE_DATA = {
  ads: [
    { ad_id: "a1", adset_id: "s1", campaign_id: "k1", cur: true, ad_name: "Vid A", spend: 300, imps: 20000, clicks: 150, leads: 4, reach: 9000, ulc: 120, uoc: 0, v3: 2400, thru: 300, lpv: 0 },
    { ad_id: "a1", adset_id: "s1", campaign_id: "k1", cur: false, ad_name: "Vid A", spend: 250, imps: 15000, clicks: 140, leads: 8, reach: 9000, ulc: 110, uoc: 0, v3: 2000, thru: 300, lpv: 0 },
    { ad_id: "a2", adset_id: "s1", campaign_id: "k1", cur: true, ad_name: "Img B", spend: 120, imps: 9000, clicks: 60, leads: 1, reach: 6000, ulc: 50, uoc: 0, v3: 0, thru: 0, lpv: 0 },
    { ad_id: "a3", adset_id: "s1", campaign_id: "k1", cur: true, ad_name: "Img C", spend: 80, imps: 7000, clicks: 40, leads: 0, reach: 5000, ulc: 35, uoc: 0, v3: 0, thru: 0, lpv: 0 },
  ],
  names: [{ kind: "campaign", id: "k1", name: "Roofing Leads" }, { kind: "adset", id: "s1", name: "Broad 30-65" }],
  creatives: [{ ad_id: "a1", title: "New Roof", body: "Save big", link_url: null }, { ad_id: "a2", title: "New Roof", body: "Save big", link_url: null }, { ad_id: "a3", title: "New Roof!", body: "Save big.", link_url: null }],
  bookings: [{ adset_name: "Broad 30-65", cur: 0, prev: 2 }],
  budgets: [{ entity_type: "adset", entity_id: "s1", campaign_id: "k1", status: "ACTIVE", daily_budget: 70 }],
  campaign_daily: Array.from({ length: 20 }, (_, i) => ({ campaign_id: "k1", date: `2026-09-${String(22 + i > 30 ? 0 : 22 + i).padStart(2, "0")}`, leads: i < 7 ? 3 : 0, spend: 50 })).filter((r) => !r.date.endsWith("-00")),
};

await t("creative-health: analyze", async () => {
  const out = await runShape("client-creative-health", { data: CREATIVE_DATA, req: { headers: {}, query: {}, params: { slug: "acme" } }, user: admin, input: { slug: "acme", end: "2026-10-11" } });
  const b = out.body;
  assert.equal(b.ads.length, 3);
  const plays = b.signals.map((s) => s.play);
  assert.ok(plays.includes("new_hook"), plays.join(","));
  assert.ok(plays.includes("add_diversity"), plays.join(","));
  assert.ok(plays.includes("consolidate"), plays.join(","));
  console.log("      signals:", plays.join(", "));
});

await t("creative-health: unknown client → 404", async () => {
  const out = await runShape("client-creative-health", { data: null, user: admin, input: { slug: "x", end: "2026-10-11" } });
  assert.equal(out.status, 404);
});

console.log(`${ok} passed`);
