"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { DateRange } from "@/components/date-range-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, type FunnelAdMetrics, type FunnelReport } from "@/lib/api";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Lead-gen funnel in Carl's metrics-guide order: money metrics → ad metrics →
 * delivery → video → offline stages. Client row carries the full funnel; campaign /
 * ad set rows carry spend → leads → booked.
 */

function colorCtr(v: number | null, b: FunnelReport["benchmarks"]) {
  if (v === null) return "";
  return v < b.ctr_red ? "text-red-400" : v < b.ctr_yellow ? "text-amber-400" : "text-emerald-400";
}
function colorCpc(v: number | null, b: FunnelReport["benchmarks"]) {
  if (v === null) return "";
  return v > b.cpc_yellow ? "text-amber-400" : v < 1 ? "text-emerald-400" : "";
}
function colorRate(v: number | null, good: number, great: number) {
  if (v === null) return "";
  return v >= great ? "text-emerald-400" : v >= good ? "" : "text-amber-400";
}
function colorFreq(v: number | null, watch: number) {
  if (v === null) return "";
  return v > watch ? "text-amber-400" : "";
}

function MetricCells({ m, b, green, red }: { m: FunnelAdMetrics; b: FunnelReport["benchmarks"]; green: number; red: number }) {
  const cplColor = m.cpl === null ? "" : m.cpl <= green ? "text-emerald-400" : m.cpl <= red ? "text-amber-400" : "text-red-400";
  return (
    <>
      <TableCell className="text-right tabular-nums">{fmtMoney(m.spend)}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtNum(m.leads)}</TableCell>
      <TableCell className={cn("text-right tabular-nums", cplColor)}>{fmtMoney(m.cpl)}</TableCell>
      <TableCell className="text-right tabular-nums" title={m.unique_click_kind === "outbound" ? "Unique outbound clicks (website funnel)" : "Unique link clicks (on-platform funnel)"}>
        {fmtNum(m.unique_clicks)}
        {m.unique_click_kind && <span className="ml-1 text-[10px] text-muted-foreground">{m.unique_click_kind === "outbound" ? "out" : "link"}</span>}
      </TableCell>
      <TableCell className={cn("text-right tabular-nums", colorCpc(m.cost_per_unique_click, b))}>{fmtMoney(m.cost_per_unique_click)}</TableCell>
      <TableCell className={cn("text-right tabular-nums", colorCtr(m.unique_ctr ?? m.ctr, b))}>{fmtPct(m.unique_ctr ?? m.ctr, 2)}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtNum(m.impressions)}</TableCell>
      <TableCell className="text-right tabular-nums">{m.reach ? fmtNum(m.reach) : "—"}</TableCell>
      <TableCell className={cn("text-right tabular-nums", colorFreq(m.frequency, b.frequency_watch))}>{m.frequency !== null ? m.frequency.toFixed(2) : "—"}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtMoney(m.cpm)}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtMoney(m.cpmr)}</TableCell>
      <TableCell className={cn("text-right tabular-nums", colorRate(m.hook_rate, b.hook_good, b.hook_great))}>{m.video_3s_plays > 0 ? fmtPct(m.hook_rate, 0) : "—"}</TableCell>
      <TableCell className={cn("text-right tabular-nums", colorRate(m.hold_rate, b.hold_good, b.hold_great))}>{m.video_3s_plays > 0 ? fmtPct(m.hold_rate, 0) : "—"}</TableCell>
    </>
  );
}

const DELIVERY_DOT: Record<string, string> = { ACTIVE: "bg-emerald-500", ENABLED: "bg-emerald-500", PAUSED: "bg-muted-foreground/50", CAMPAIGN_PAUSED: "bg-muted-foreground/50", ADSET_PAUSED: "bg-muted-foreground/50" };

function DeliveryCell({ delivery }: { delivery: string | null }) {
  const key = (delivery ?? "").toUpperCase();
  return (
    <TableCell title={delivery ?? "unknown"}>
      <span className={cn("inline-block h-2.5 w-2.5 rounded-full", DELIVERY_DOT[key] ?? (key ? "bg-amber-500" : "bg-muted"))} />
    </TableCell>
  );
}

function BudgetCell({ daily, lifetime, source, level }: { daily: number | null; lifetime: number | null; source: string | null; level: "campaign" | "adset" | "client" }) {
  if (daily) return <TableCell className="text-right tabular-nums" title={source === "campaign" && level === "adset" ? "Campaign budget (CBO)" : undefined}>{fmtMoney(daily)}<span className="text-[10px] text-muted-foreground">/d</span></TableCell>;
  if (lifetime) return <TableCell className="text-right tabular-nums" title="lifetime budget">{fmtMoney(lifetime)}<span className="text-[10px] text-muted-foreground"> life</span></TableCell>;
  if (level === "adset" && source === "campaign") return <TableCell className="text-right text-[11px] text-muted-foreground">CBO</TableCell>;
  if (level === "campaign" && source === "adset") return <TableCell className="text-right text-[11px] text-muted-foreground">ABO</TableCell>;
  return <TableCell className="text-right text-muted-foreground">—</TableCell>;
}

const HEADERS = [
  ["Spend", "Amount spent"],
  ["Leads", "Results (platform-reported leads)"],
  ["CPL", "Cost per lead — the decision metric, with lead quality"],
  ["Unique clicks", "Unique outbound clicks for website funnels, unique link clicks for Instant Form / on-platform funnels"],
  ["Cost/click", "Cost per unique click — $1–3 acceptable, <$1 elite, >$3 expensive"],
  ["CTR", "Unique CTR — aim ≥1.5%, under 1% is a problem"],
  ["Impr.", "Impressions"],
  ["Reach", "Unique people reached (sum of daily reach)"],
  ["Freq.", "Impressions ÷ reach"],
  ["CPM", "Cost per 1,000 impressions"],
  ["CPMr", "Cost per 1,000 reached — climbing CPMr + rising frequency = creative fatigue"],
  ["Hook", "3-second plays ÷ video impressions (image ads excluded) — 20–35% good, >35% very good"],
  ["Hold", "ThruPlays ÷ 3-second plays — 20–40% good, >40% extremely good"],
] as const;

export function FunnelCard({ slug, range }: { slug: string; range: DateRange }) {
  const [level, setLevel] = useState<"campaign" | "adset">("campaign");
  const { data, isLoading } = useQuery({
    queryKey: ["funnel", slug, range.start, range.end],
    queryFn: () => apiFetch<FunnelReport>(`/api/clients/${slug}/funnel?start=${range.start}&end=${range.end}`),
  });
  if (isLoading) return <Skeleton className="h-64" />;
  if (!data || data.totals.spend === 0) return null;
  const f = data.totals.funnel;
  const b = data.benchmarks;
  const { cpl_target_green: green, cpl_target_red: red } = data.client;
  const signals = data.totals.signals;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Funnel</CardTitle>
        <p className="text-xs text-muted-foreground">
          Left to right: money → ad → delivery → video → offline stages. Booked / confirmed / showed / closed come from GHL for paid-attributed contacts.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Offline stage strip */}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {f.stages.map((s, i) => {
            const maxCount = Math.max(f.stages[0].count, 1);
            const width = Math.max((s.count / maxCount) * 100, s.count > 0 ? 6 : 0);
            return (
              <div key={s.key} className={cn("rounded-md border p-2", !s.tracked && "opacity-60")} title={s.estimate ? "Paid contacts minus junk-stage leads (junk scaled to the paid share of contacts) — an estimate" : undefined}>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{s.label}{s.estimate ? " ≈" : ""}</div>
                <div className="text-lg font-semibold tabular-nums">{s.tracked ? fmtNum(s.count) : "—"}</div>
                <div className="mt-1 h-1.5 rounded bg-muted"><div className="h-1.5 rounded bg-primary" style={{ width: `${s.tracked ? width : 0}%` }} /></div>
                <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                  {!s.tracked ? "not tracked in GHL" : (
                    <>
                      {i > 0 && s.pct_of_prev !== null ? `${fmtPct(s.pct_of_prev, 0)} of prev · ` : ""}
                      {s.cost_per !== null ? `${fmtMoney(s.cost_per)} each` : "—"}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span>Paid contacts <span className="text-foreground">{fmtNum(f.contacts_paid)}</span> · junk <span className="text-foreground">{fmtNum(f.junk)}</span></span>
          {f.tracked.showed && <span>No-show rate <span className={cn("text-foreground", f.noshow_rate !== null && f.noshow_rate > 0.35 && "text-amber-400")}>{fmtPct(f.noshow_rate, 0)}</span></span>}
          {!f.tracked.showed && f.stages[2].count > 0 && <span className="text-amber-400/80">Showed / no-show not marked in GHL — have setters set appointment status so show rate and cost per show fill in</span>}
          <span>CAC <span className="text-foreground">{fmtMoney(f.cac)}</span></span>
          <span>Revenue <span className="text-foreground">{fmtMoney(f.revenue)}</span>{f.expected_revenue ? <span title="closed jobs × average job value; no revenue entered in GHL"> (≈{fmtMoney(f.expected_revenue)} at avg job value)</span> : null}</span>
          <span>ROAS <span className="text-foreground">{f.roas !== null ? `${f.roas.toFixed(2)}×` : "—"}</span></span>
        </div>
        {f.bottleneck && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span><span className="font-medium">Bottleneck: </span>{f.bottleneck}</span>
          </div>
        )}
        {signals.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {signals.map((s, i) => (
              <span key={i} className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs", s.level === "green" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : s.level === "red" ? "border-red-500/30 bg-red-500/10 text-red-400" : "border-amber-500/30 bg-amber-500/10 text-amber-400")}>
                {s.level === "green" ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                {s.text}
              </span>
            ))}
          </div>
        )}

        {/* Column table */}
        <div className="flex items-center gap-2">
          {(["campaign", "adset"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLevel(l)}
              className={cn("rounded-md px-2.5 py-1 text-xs", level === l ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {l === "campaign" ? "By campaign" : "By Meta ad set"}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{level === "campaign" ? "Campaign" : "Ad set"}</TableHead>
                <TableHead title="Delivery — is it on or off">On</TableHead>
                <TableHead className="text-right" title="Daily budget (CBO on the campaign, ABO on the ad set)">Budget</TableHead>
                {HEADERS.map(([h, tip]) => <TableHead key={h} className="text-right" title={tip}>{h}</TableHead>)}
                <TableHead className="text-right" title={level === "campaign" ? "GHL paid bookings, tagged + lead-share allocation" : "GHL bookings whose contact carries this ad set name"}>Booked</TableHead>
                <TableHead className="text-right">Booked %</TableHead>
                <TableHead className="text-right">Cost/Booked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="bg-muted/30 font-medium">
                <TableCell>All ({data.client.name})</TableCell>
                <TableCell></TableCell>
                <BudgetCell daily={data.totals.daily_budget} lifetime={null} source={null} level="client" />
                <MetricCells m={data.totals} b={b} green={green} red={red} />
                <TableCell className="text-right tabular-nums">{fmtNum(f.stages[2].count)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtPct(data.totals.leads ? f.stages[2].count / data.totals.leads : null, 0)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtMoney(f.stages[2].cost_per)}</TableCell>
              </TableRow>
              {(level === "campaign" ? data.campaigns : data.adsets).map((r) => (
                <TableRow key={level === "campaign" ? `${r.platform}-${r.campaign_id}` : r.adset_id}>
                  <TableCell className="max-w-[18rem]">
                    <div className="truncate">{level === "campaign" ? r.campaign_name : r.adset_name}</div>
                    <div className="text-[11px] text-muted-foreground">{level === "campaign" ? `${r.platform} · ${r.service ?? ""}` : data.campaigns.find((c) => c.campaign_id === r.campaign_id)?.campaign_name ?? ""}</div>
                  </TableCell>
                  <DeliveryCell delivery={r.delivery} />
                  <BudgetCell daily={r.daily_budget} lifetime={r.lifetime_budget} source={r.budget_source} level={level} />
                  <MetricCells m={r} b={b} green={green} red={red} />
                  <TableCell className="text-right tabular-nums">{fmtNum(r.booked)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtPct(r.booked_rate, 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoney(r.cost_per_booked)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
