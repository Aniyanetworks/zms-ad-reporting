"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Nav } from "@/components/nav";
import { Sparkline } from "@/components/sparkline";
import { CplCell } from "@/components/cpl-cell";
import { DateRangePicker, defaultRange, type DateRange } from "@/components/date-range-picker";
import { KpiCard } from "@/components/kpi-card";
import { SpendFilter, useHideNoSpend } from "@/components/spend-filter";
import { PlatformSwitch, usePlatform, type Platform } from "@/components/platform-switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch, type OverviewClient, type OverviewResponse } from "@/lib/api";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

/** One client's numbers as seen through the selected platform. GHL appointments
 * are only known for paid traffic as a whole, so they appear in the "All" view. */
interface Row {
  c: OverviewClient;
  spend: number;
  leads: number;
  cpl: number | null;
  spark: number[];
  /** Expected CPL for this client's service mix on this platform (service targets), else the client's own. */
  green: number;
  red: number;
}

/** Service-mix thresholds when the API has them, else the client's flat targets. */
function thresholds(c: OverviewClient, key: "meta" | "google" | "lsa" | "blended"): [number, number] {
  const g = c[`${key}_target_green`];
  const r = c[`${key}_target_red`];
  return g !== null && g !== undefined && r !== null && r !== undefined ? [g, r] : [c.cpl_target_green, c.cpl_target_red];
}

function view(c: OverviewClient, platform: Platform): Row {
  if (platform === "meta") {
    const [green, red] = thresholds(c, "meta");
    return { c, spend: c.meta_spend, leads: c.meta_leads, cpl: c.meta_cpl, spark: c.spark_meta ?? [], green, red };
  }
  if (platform === "google") {
    const [green, red] = thresholds(c, "google");
    return { c, spend: c.google_spend, leads: c.google_leads, cpl: c.google_cpl, spark: c.spark_google ?? [], green, red };
  }
  if (platform === "lsa") {
    const [green, red] = thresholds(c, "lsa");
    return { c, spend: c.lsa_spend ?? 0, leads: c.lsa_leads ?? 0, cpl: c.lsa_cpl ?? null, spark: c.spark_lsa ?? [], green, red };
  }
  const [green, red] = thresholds(c, "blended");
  return { c, spend: c.total_spend, leads: c.total_leads, cpl: c.blended_cpl, spark: c.spark, green, red };
}

function statusOf(r: Row): { label: string; cls: string; rank: number; tip: string } {
  const tip = `Expected for this client's service mix: ≤${fmtMoney(r.green)} on target · ≤${fmtMoney(r.red)} watch`;
  if (r.spend === 0) return { label: "No spend", cls: "bg-muted text-muted-foreground", rank: 3, tip };
  if (r.leads === 0) return { label: "No leads", cls: "bg-red-500/15 text-red-500", rank: 0, tip };
  const cpl = r.cpl ?? Infinity;
  if (cpl <= r.green) return { label: "On target", cls: "bg-emerald-500/15 text-emerald-500", rank: 2, tip };
  if (cpl <= r.red) return { label: "Watch", cls: "bg-amber-500/15 text-amber-500", rank: 1, tip };
  return { label: "Over target", cls: "bg-red-500/15 text-red-500", rank: 0, tip };
}

const SCORE_CLASS: Record<string, string> = {
  green: "bg-emerald-500/15 text-emerald-400",
  yellow: "bg-amber-500/15 text-amber-400",
  red: "bg-red-500/15 text-red-400",
};

type Col = { key: string; label: string; numeric?: boolean; value: (r: Row) => string | number | null };

const ALL_COLUMNS: Col[] = [
  { key: "name", label: "Client", value: (r) => r.c.name },
  { key: "meta_spend", label: "Meta Spend", numeric: true, value: (r) => r.c.meta_spend },
  { key: "meta_leads", label: "Meta Leads", numeric: true, value: (r) => r.c.meta_leads },
  { key: "meta_cpl", label: "Meta CPL", numeric: true, value: (r) => r.c.meta_cpl },
  { key: "google_spend", label: "Google Spend", numeric: true, value: (r) => r.c.google_spend },
  { key: "google_leads", label: "Google Leads", numeric: true, value: (r) => r.c.google_leads },
  { key: "google_cpl", label: "Google CPL", numeric: true, value: (r) => r.c.google_cpl },
  { key: "lsa_spend", label: "LSA Spend", numeric: true, value: (r) => r.c.lsa_spend ?? 0 },
  { key: "lsa_leads", label: "LSA Leads", numeric: true, value: (r) => r.c.lsa_leads ?? 0 },
  { key: "lsa_cpl", label: "LSA CPL", numeric: true, value: (r) => r.c.lsa_cpl ?? null },
  { key: "blended_cpl", label: "Blended CPL", numeric: true, value: (r) => r.c.blended_cpl },
  { key: "ghl_appointments", label: "GHL Appts", numeric: true, value: (r) => r.c.ghl_appointments },
  { key: "cost_per_appointment", label: "Cost/Appt", numeric: true, value: (r) => r.c.cost_per_appointment },
  { key: "lead_to_appt_rate", label: "Lead→Appt %", numeric: true, value: (r) => r.c.lead_to_appt_rate },
];

const PLATFORM_COLUMNS: Col[] = [
  { key: "name", label: "Client", value: (r) => r.c.name },
  { key: "spend", label: "Spend", numeric: true, value: (r) => r.spend },
  { key: "leads", label: "Leads", numeric: true, value: (r) => r.leads },
  { key: "cpl", label: "CPL", numeric: true, value: (r) => r.cpl },
];

export default function OverviewPage() {
  const router = useRouter();
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [sortKey, setSortKey] = useState<string>("name");
  const [sortDesc, setSortDesc] = useState(false);
  const [hideNoSpend, setHideNoSpend] = useHideNoSpend();
  const [platform, setPlatform] = usePlatform();

  const { data, isLoading, error } = useQuery({
    queryKey: ["overview", range],
    queryFn: () =>
      apiFetch<OverviewResponse>(`/api/overview?start=${range.start}&end=${range.end}`),
  });

  const columns = platform === "all" ? ALL_COLUMNS : PLATFORM_COLUMNS;
  const rows = useMemo(() => (data ? data.clients.map((c) => view(c, platform)) : []), [data, platform]);
  const hiddenCount = rows.filter((r) => r.spend === 0).length;

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey) ?? columns[0];
    const visible = rows.filter((r) => !hideNoSpend || r.spend > 0);
    visible.sort((a, b) => {
      const av = col.value(a);
      const bv = col.value(b);
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDesc ? -cmp : cmp;
    });
    return visible;
  }, [rows, columns, sortKey, sortDesc, hideNoSpend]);

  // Totals follow the platform switch (the API's totals are blended).
  const totals = useMemo(() => {
    const spend = sorted.reduce((s, r) => s + r.spend, 0);
    const leads = sorted.reduce((s, r) => s + r.leads, 0);
    const appts = sorted.reduce((s, r) => s + r.c.ghl_appointments, 0);
    return {
      spend,
      leads,
      cpl: leads ? spend / leads : null,
      appts,
      cost_per_appt: appts ? spend / appts : null,
      spending: sorted.filter((r) => r.spend > 0).length,
    };
  }, [sorted]);

  function toggleSort(key: string) {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(key !== "name");
    }
  }
  function changePlatform(p: Platform) {
    setPlatform(p);
    setSortKey("name");
    setSortDesc(false);
  }

  const platformLabel = platform === "meta" ? "Meta" : platform === "google" ? "Google" : platform === "lsa" ? "LSA" : "";

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-screen-2xl space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            Agency Overview{platformLabel && <span className="ml-2 text-muted-foreground">· {platformLabel} Ads</span>}
          </h1>
          <div className="flex flex-wrap items-center gap-3">
            <PlatformSwitch value={platform} onChange={changePlatform} />
            <SpendFilter hide={hideNoSpend} onChange={setHideNoSpend} hiddenCount={hiddenCount} />
            <DateRangePicker value={range} onChange={setRange} />
          </div>
        </div>

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Failed to load overview: {(error as Error).message}
          </p>
        )}

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {isLoading || !data ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)
          ) : (
            <>
              <KpiCard label={`${platformLabel || "Total"} Spend`} value={fmtMoney(totals.spend)} hint={`${totals.spending} clients spending`} />
              <KpiCard label={`${platformLabel || "Total"} Leads`} value={fmtNum(totals.leads)} />
              <KpiCard label={platform === "all" ? "Blended CPL" : `${platformLabel} CPL`} value={fmtMoney(totals.cpl)} />
              {platform === "all" ? (
                <KpiCard
                  label="Paid Appointments"
                  value={fmtNum(totals.appts)}
                  hint={totals.cost_per_appt !== null ? `${fmtMoney(totals.cost_per_appt)} per appt` : undefined}
                />
              ) : (
                <KpiCard
                  label="Appointments"
                  value="—"
                  hint="GHL bookings are tracked for paid traffic as a whole; switch to All to see them"
                />
              )}
            </>
          )}
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">Status</TableHead>
                <TableHead className="whitespace-nowrap">Trend</TableHead>
                {columns.map((col) => (
                  <TableHead
                    key={col.key}
                    className={cn("whitespace-nowrap", col.numeric && "text-right")}
                  >
                    <button
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort(col.key)}
                    >
                      {col.label}
                      {sortKey === col.key ? (
                        sortDesc ? (
                          <ArrowDown className="h-3 w-3" />
                        ) : (
                          <ArrowUp className="h-3 w-3" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" />
                      )}
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={columns.length + 2}>
                      <Skeleton className="h-6" />
                    </TableCell>
                  </TableRow>
                ))}
              {sorted.map((r) => {
                const c = r.c;
                const s = statusOf(r);
                return (
                  <TableRow key={c.id} className="cursor-pointer" onClick={() => router.push(`/clients/${c.slug}`)}>
                    <TableCell>
                      <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium", s.cls)} title={s.tip}>
                        {s.label}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Sparkline points={r.spark} />
                    </TableCell>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    {platform === "all" ? (
                      <>
                        <TableCell className="text-right tabular-nums">{fmtMoney(c.meta_spend)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(c.meta_leads)}</TableCell>
                        <TableCell className="text-right">
                          <CplCell cpl={c.meta_cpl} green={thresholds(c, "meta")[0]} red={thresholds(c, "meta")[1]} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMoney(c.google_spend)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(c.google_leads)}</TableCell>
                        <TableCell className="text-right">
                          <CplCell cpl={c.google_cpl} green={thresholds(c, "google")[0]} red={thresholds(c, "google")[1]} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMoney(c.lsa_spend ?? 0)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(c.lsa_leads ?? 0)}</TableCell>
                        <TableCell className="text-right">
                          <CplCell cpl={c.lsa_cpl ?? null} green={thresholds(c, "lsa")[0]} red={thresholds(c, "lsa")[1]} />
                        </TableCell>
                        <TableCell className="text-right">
                          <CplCell cpl={c.blended_cpl} green={r.green} red={r.red} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(c.ghl_appointments)}</TableCell>
                        <TableCell className="text-right">
                          <span
                            className={cn("inline-block rounded px-1.5 py-0.5 text-sm tabular-nums", c.cpba_color ? SCORE_CLASS[c.cpba_color] : "")}
                            title={c.cpba_max ? `Max profitable CPBA for this client: ${fmtMoney(c.cpba_max)} (job value × close rate × margin × ad share — set in Settings)` : "Set avg job value in Settings to get a profitability ceiling"}
                          >
                            {fmtMoney(c.cost_per_appointment)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtPct(c.lead_to_appt_rate)}</TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell className="text-right tabular-nums">{fmtMoney(r.spend)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(r.leads)}</TableCell>
                        <TableCell className="text-right">
                          <CplCell cpl={r.cpl} green={r.green} red={r.red} />
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                );
              })}
              {!isLoading && sorted.length === 0 && (
                <TableRow>
                  <TableCell colSpan={columns.length + 2} className="py-8 text-center text-muted-foreground">
                    {hideNoSpend && hiddenCount > 0
                      ? `No clients with ${platformLabel || ""} spend in this range (${hiddenCount} hidden).`
                      : "No active clients yet — add them in Settings."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </main>
    </div>
  );
}
