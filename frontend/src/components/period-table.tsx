"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CplCell } from "@/components/cpl-cell";
import type { DateRange } from "@/components/date-range-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch, type PeriodRow, type PeriodsResponse } from "@/lib/api";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/format";

type Granularity = "daily" | "weekly" | "monthly";

const GRANULARITIES: { key: Granularity; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
];

function periodLabel(iso: string, granularity: Granularity): string {
  const d = new Date(`${iso}T00:00:00`);
  if (granularity === "monthly") {
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }
  if (granularity === "weekly") {
    const end = new Date(d);
    end.setDate(end.getDate() + 6);
    const s = d.toLocaleDateString("en-US", { day: "2-digit", month: "short" });
    const e = end.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
    return `Week ${s} – ${e}`;
  }
  return d.toLocaleDateString("en-US", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}

/** Small ▲/▼ vs the previous period. `goodWhenUp` flips the coloring for
 * metrics where up is bad (CPL). */
function Delta({
  current,
  previous,
  goodWhenUp,
}: {
  current: number | null;
  previous: number | null | undefined;
  goodWhenUp: boolean;
}) {
  if (current === null || previous === null || previous === undefined || previous === 0) return null;
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.05) return null;
  const up = change > 0;
  const good = up === goodWhenUp;
  return (
    <span
      className={`ml-1 text-[10px] font-medium ${good ? "text-emerald-500" : "text-red-500"}`}
      title={`${up ? "+" : ""}${Math.round(change * 100)}% vs previous period`}
    >
      {up ? "▲" : "▼"}
      {Math.abs(Math.round(change * 100))}%
    </span>
  );
}

function sumRows(rows: PeriodRow[]) {
  const t = rows.reduce(
    (acc, r) => ({
      spend: acc.spend + r.spend,
      impressions: acc.impressions + r.impressions,
      clicks: acc.clicks + r.clicks,
      leads: acc.leads + r.leads,
      ghl_paid: acc.ghl_paid + r.ghl_paid,
      appointments: acc.appointments + r.appointments,
      jobs_won: acc.jobs_won + r.jobs_won,
      revenue_won: acc.revenue_won + r.revenue_won,
    }),
    { spend: 0, impressions: 0, clicks: 0, leads: 0, ghl_paid: 0, appointments: 0, jobs_won: 0, revenue_won: 0 },
  );
  return {
    ...t,
    ctr: t.impressions ? t.clicks / t.impressions : null,
    cpl: t.leads ? t.spend / t.leads : null,
    cost_per_appt: t.appointments ? t.spend / t.appointments : null,
    roas: t.spend ? t.revenue_won / t.spend : null,
  };
}

export function PeriodTable({
  slug,
  range,
  green,
  red,
}: {
  slug: string;
  range: DateRange;
  green: number;
  red: number;
}) {
  const [granularity, setGranularity] = useState<Granularity>("weekly");

  const { data, isLoading } = useQuery({
    queryKey: ["periods", slug, granularity, range],
    queryFn: () =>
      apiFetch<PeriodsResponse>(
        `/api/clients/${slug}/periods?start=${range.start}&end=${range.end}&granularity=${granularity}`,
      ),
  });

  const totals = data ? sumRows(data.periods) : null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Performance by Period</CardTitle>
        <div className="flex gap-1 rounded-md border p-0.5">
          {GRANULARITIES.map((g) => (
            <button
              key={g.key}
              onClick={() => setGranularity(g.key)}
              className={`rounded px-3 py-1 text-sm transition-colors ${
                granularity === g.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {isLoading || !data ? (
          <Skeleton className="mx-6 mb-6 h-64" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Impr.</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">CTR</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">CPL</TableHead>
                  <TableHead className="text-right">Paid Contacts</TableHead>
                  <TableHead className="text-right">Appts</TableHead>
                  <TableHead className="text-right">Cost/Appt</TableHead>
                  <TableHead className="text-right">Won</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">ROAS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.periods.map((p, i) => (
                  <TableRow key={p.period}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {periodLabel(p.period, granularity)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(p.spend)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(p.impressions)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(p.clicks)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPct(p.ctr, 2)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {fmtNum(p.leads)}
                      <Delta current={p.leads} previous={data.periods[i + 1]?.leads} goodWhenUp />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <CplCell cpl={p.cpl} green={green} red={red} />
                      <Delta current={p.cpl} previous={data.periods[i + 1]?.cpl} goodWhenUp={false} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(p.ghl_paid)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(p.appointments)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(p.cost_per_appt)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(p.jobs_won)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(p.revenue_won)}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.roas !== null ? `${p.roas.toFixed(1)}x` : "—"}</TableCell>
                  </TableRow>
                ))}
                {data.periods.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={13} className="py-6 text-center text-muted-foreground">
                      No activity in this range.
                    </TableCell>
                  </TableRow>
                )}
                {totals && data.periods.length > 0 && (
                  <TableRow className="border-t-2 font-semibold hover:bg-transparent">
                    <TableCell>Total</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(totals.spend)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(totals.impressions)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(totals.clicks)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPct(totals.ctr, 2)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(totals.leads)}</TableCell>
                    <TableCell className="text-right">
                      <CplCell cpl={totals.cpl} green={green} red={red} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(totals.ghl_paid)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(totals.appointments)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(totals.cost_per_appt)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(totals.jobs_won)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(totals.revenue_won)}</TableCell>
                    <TableCell className="text-right tabular-nums">{totals.roas !== null ? `${totals.roas.toFixed(1)}x` : "—"}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
