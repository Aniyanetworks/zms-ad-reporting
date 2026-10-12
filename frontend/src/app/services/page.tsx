"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Nav } from "@/components/nav";
import { DateRangePicker, defaultRange, type DateRange } from "@/components/date-range-picker";
import { KpiCard } from "@/components/kpi-card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch, type ServicesResponse } from "@/lib/api";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

const PLATFORM_STYLE: Record<string, string> = {
  meta: "bg-sky-500/15 text-sky-400",
  google: "bg-amber-500/15 text-amber-400",
  lsa: "bg-violet-500/15 text-violet-400",
};

function PlatformBadge({ platform }: { platform: string }) {
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium uppercase", PLATFORM_STYLE[platform] ?? "bg-muted text-muted-foreground")}>
      {platform}
    </span>
  );
}

/** Color a client's number against its service average: within ±15% neutral, better green, worse red. */
function vsAvg(value: number | null, avg: number | null): string {
  if (value === null || avg === null || avg === 0) return "";
  const r = value / avg;
  if (r <= 0.85) return "text-emerald-400";
  if (r >= 1.15) return "text-red-400";
  return "";
}

export default function ServicesPage() {
  const router = useRouter();
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const { data, isLoading, error } = useQuery({
    queryKey: ["services", range],
    queryFn: () => apiFetch<ServicesResponse>(`/api/services?start=${range.start}&end=${range.end}`),
  });

  const totals = data?.totals;

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-screen-2xl space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Services</h1>
            <p className="text-sm text-muted-foreground">
              What each service costs us across every client, split by platform — Meta and Google are never
              blended into one CPL. Services come from campaign names (e.g. &ldquo;Cabinet
              Painting&rdquo;, &ldquo;Deck&rdquo;, &ldquo;Bathroom Remodeling&rdquo;). Averages are
              spend-weighted: total spend ÷ total leads. Appointments are GHL bookings; a booking whose
              ad-set tag can&rsquo;t be matched is split across that client&rsquo;s campaigns by lead share
              (exact for single-service clients, an estimate for multi-service ones).
            </p>
          </div>
          <DateRangePicker value={range} onChange={setRange} />
        </div>

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Failed to load services: {(error as Error).message}
          </p>
        )}

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {isLoading || !totals ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)
          ) : (
            <>
              <KpiCard
                label="Spend"
                value={fmtMoney(totals.spend)}
                hint={totals.platforms.map((p) => `${p.platform} ${fmtMoney(p.spend)}`).join(" · ") || `${totals.services} services`}
              />
              <KpiCard
                label="Leads"
                value={fmtNum(totals.leads)}
                hint={
                  totals.platforms.length > 1
                    ? totals.platforms.map((p) => `${p.platform} CPL ${fmtMoney(p.cpl)}`).join(" · ")
                    : `avg CPL ${fmtMoney(totals.cpl)}`
                }
              />
              <KpiCard
                label="Booked Appointments"
                value={fmtNum(Math.round(totals.appointments))}
                hint={`avg CPBA ${fmtMoney(totals.cpba)} · ${fmtNum(Math.round(totals.appointments_unattributed))} untagged, split by lead share`}
              />
              <KpiCard label="Lead→Appt" value={fmtPct(totals.lead_to_appt_rate)} />
            </>
          )}
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead className="text-right">Clients</TableHead>
                <TableHead className="text-right">Campaigns</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">CTR</TableHead>
                <TableHead className="text-right">CPC</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Avg CPL</TableHead>
                <TableHead className="text-right">Appts</TableHead>
                <TableHead className="text-right">Avg CPBA</TableHead>
                <TableHead className="text-right">Lead→Appt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={12}>
                      <Skeleton className="h-6" />
                    </TableCell>
                  </TableRow>
                ))}
              {data?.services.map((s) => {
                const key = `${s.service}|${s.platform}`;
                const isOpen = !!open[key];
                return (
                  <Fragment key={key}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}
                    >
                      <TableCell className={cn("font-medium", s.service === "Unclassified" && "text-amber-400")}>
                        <span className="mr-1.5 inline-flex align-middle text-muted-foreground">
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </span>
                        {s.service}
                      </TableCell>
                      <TableCell><PlatformBadge platform={s.platform} /></TableCell>
                      <TableCell className="text-right tabular-nums">{s.clients}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{s.campaigns}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(s.spend)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtPct(s.ctr, 2)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(s.cpc)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(s.leads)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{fmtMoney(s.cpl)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(s.appointments)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{fmtMoney(s.cpba)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtPct(s.lead_to_appt_rate)}</TableCell>
                    </TableRow>
                    {isOpen &&
                      s.rows.map((c) => (
                        <TableRow
                          key={c.slug}
                          className="cursor-pointer bg-muted/30 text-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(`/clients/${c.slug}`);
                          }}
                        >
                          <TableCell className="pl-10 text-muted-foreground">{c.name}</TableCell>
                          <TableCell />
                          <TableCell />
                          <TableCell className="text-right tabular-nums text-muted-foreground">{c.campaigns}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtMoney(c.spend)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtPct(c.ctr, 2)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtMoney(c.cpc)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtNum(c.leads)}</TableCell>
                          <TableCell className={cn("text-right tabular-nums", vsAvg(c.cpl, s.cpl))}>{fmtMoney(c.cpl)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtNum(c.appointments)}</TableCell>
                          <TableCell className={cn("text-right tabular-nums", vsAvg(c.cpba, s.cpba))}>{fmtMoney(c.cpba)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtPct(c.lead_to_appt_rate)}</TableCell>
                        </TableRow>
                      ))}
                  </Fragment>
                );
              })}
              {!isLoading && data?.services.length === 0 && (
                <TableRow>
                  <TableCell colSpan={12} className="py-8 text-center text-muted-foreground">
                    No spend in this range.
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
