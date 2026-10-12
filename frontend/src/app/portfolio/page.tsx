"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Nav } from "@/components/nav";
import { SpendFilter, useHideNoSpend } from "@/components/spend-filter";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch, type Scorecard } from "@/lib/api";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

const DIVERGENCE_THRESHOLD = 0.2;

/** Color vs the trade benchmark (ad-set percentiles, so a whole-client average
 * naturally sits above the ad-set median): green ≤ median, yellow ≤ p75, red above p75. */
function benchClass(value: number | null, median: number | null, p75: number | null): string {
  if (value === null) return "text-muted-foreground";
  if (median !== null && value <= median) return "bg-emerald-500/15 text-emerald-400";
  if (p75 !== null && value <= p75) return "bg-amber-500/15 text-amber-400";
  if (p75 !== null) return "bg-red-500/15 text-red-400";
  return "text-foreground";
}

function BenchCell({
  value,
  p25,
  median,
  p75,
  source,
}: {
  value: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  source: string | null;
}) {
  const tip =
    median !== null
      ? `Trade benchmark (${source}): p25 ${fmtMoney(p25)} · median ${fmtMoney(median)} · p75 ${fmtMoney(p75)}`
      : "No trade benchmark yet — run /baseline";
  return (
    <span
      title={tip}
      className={cn("inline-block rounded px-1.5 py-0.5 text-sm tabular-nums", benchClass(value, median, p75))}
    >
      {fmtMoney(value)}
    </span>
  );
}

const SCORE_DOT: Record<string, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-500",
  red: "bg-red-500",
};

export default function PortfolioPage() {
  const router = useRouter();
  const [hideNoSpend, setHideNoSpend] = useHideNoSpend();
  const { data, isLoading, error } = useQuery({
    queryKey: ["portfolio"],
    queryFn: () => apiFetch<Scorecard[]>("/api/portfolio"),
  });

  const stale = (run_at: string | null) =>
    !run_at || Date.now() - new Date(run_at).getTime() > 8 * 86400_000;
  const hiddenCount = data ? data.filter((c) => !(c.spend ?? 0)).length : 0;
  const visible = (data ?? []).filter((c) => !hideNoSpend || (c.spend ?? 0) > 0);

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-screen-2xl space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
            <p className="text-sm text-muted-foreground">
              Every client ranked worst-first by cost per booked appointment vs its trade median, then CPL.
              Numbers are the trailing 30 days until a <code>/weekly-triage &lt;slug&gt;</code> run exists for
              the client; then the triage window is shown.
            </p>
          </div>
          <SpendFilter hide={hideNoSpend} onChange={setHideNoSpend} hiddenCount={hiddenCount} />
        </div>

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Failed to load portfolio: {(error as Error).message}
          </p>
        )}

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead></TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Trade</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">CPL</TableHead>
                <TableHead className="text-right">Appts</TableHead>
                <TableHead className="text-right">CPBA</TableHead>
                <TableHead className="text-right">Lead→Appt</TableHead>
                <TableHead>Signal</TableHead>
                <TableHead>Window</TableHead>
                <TableHead className="text-right">Open recs</TableHead>
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
              {visible.map((c) => {
                const nonGhl = !["ghl", "sheet"].includes(c.booking_system);
                const divergent = (c.divergence_ratio ?? 0) > DIVERGENCE_THRESHOLD;
                return (
                  <TableRow
                    key={c.client_id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/clients/${c.slug}`)}
                  >
                    <TableCell>
                      <span
                        className={cn("inline-block h-2.5 w-2.5 rounded-full", SCORE_DOT[c.score ?? ""] ?? "bg-muted")}
                        title={c.score ?? "no triage yet"}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-muted-foreground">{c.trade ?? "— set trade"}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(c.spend)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(c.leads)}</TableCell>
                    <TableCell className="text-right">
                      <BenchCell value={c.cpl} p25={c.cpl_p25} median={c.cpl_median} p75={c.cpl_p75} source={c.cpl_bench_source} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {nonGhl ? <span className="text-xs text-muted-foreground">not tracked</span> : fmtNum(c.appointments_ghl)}
                    </TableCell>
                    <TableCell className="text-right">
                      {nonGhl ? (
                        <span className="text-xs text-muted-foreground">non-GHL booking</span>
                      ) : (
                        <span title={c.cpba_max ? `Max profitable CPBA: ${fmtMoney(c.cpba_max)}` : undefined}>
                          {c.cpba_max && c.cpba_color ? (
                            <span className={cn("inline-block rounded px-1.5 py-0.5 text-sm tabular-nums",
                              c.cpba_color === "green" ? "bg-emerald-500/15 text-emerald-400" : c.cpba_color === "yellow" ? "bg-amber-500/15 text-amber-400" : "bg-red-500/15 text-red-400")}>
                              {fmtMoney(c.cpba)}
                            </span>
                          ) : (
                            <BenchCell value={c.cpba} p25={c.cpba_p25} median={c.cpba_median} p75={c.cpba_p75} source={c.cpba_bench_source} />
                          )}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {nonGhl ? "—" : fmtPct(c.lead_to_appt_rate)}
                    </TableCell>
                    <TableCell>
                      {divergent ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-400">
                          <AlertTriangle className="h-3 w-3" />
                          {Math.round((c.divergence_ratio ?? 0) * 100)}% off
                        </span>
                      ) : c.divergence_ratio !== null ? (
                        <span className="text-xs text-muted-foreground">OK</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {c.metrics_source === "triage" ? (
                        <span title={`Triage run ${c.run_at ? new Date(c.run_at).toLocaleDateString() : ""}`}>
                          {c.window_start} → {c.window_end}
                        </span>
                      ) : (
                        <span className="text-muted-foreground" title={c.run_at ? `Last triage ${new Date(c.run_at).toLocaleDateString()} is stale` : "No triage run yet"}>
                          last 30d{stale(c.run_at) && c.run_at ? " (triage stale)" : ""}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{c.open_recs ?? 0}</TableCell>
                  </TableRow>
                );
              })}
              {!isLoading && visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={12} className="py-8 text-center text-muted-foreground">
                    {hiddenCount > 0 ? `No clients with spend in the last 30 days (${hiddenCount} hidden).` : "No active clients."}
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
