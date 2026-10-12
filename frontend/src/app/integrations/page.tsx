"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radar, RefreshCw } from "lucide-react";
import { Nav } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { TrackingRollout } from "@/components/tracking-rollout";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, type HealthStatus, type IntegrationsResponse } from "@/lib/api";
import { useMe } from "@/lib/me";
import { canManage } from "@/lib/permissions";
import { cn } from "@/lib/utils";

const DOT: Record<HealthStatus, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-500",
  red: "bg-red-500",
  grey: "bg-muted-foreground/30",
};
const WORD: Record<HealthStatus, string> = { green: "working", yellow: "attention", red: "broken", grey: "n/a" };

function Dot({ status, detail, size = "h-3 w-3" }: { status: HealthStatus; detail?: string | null; size?: string }) {
  return (
    <span
      className={cn("inline-block rounded-full", size, DOT[status])}
      title={`${WORD[status]}${detail ? ` — ${detail}` : ""}`}
      aria-label={`${WORD[status]}${detail ? `: ${detail}` : ""}`}
    />
  );
}

export default function IntegrationsPage() {
  const qc = useQueryClient();
  const me = useMe();
  const isAdmin = canManage(me.data?.role);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const q = useQuery({ queryKey: ["integrations"], queryFn: () => apiFetch<IntegrationsResponse>("/api/integrations") });
  const propose = useMutation({
    mutationFn: () =>
      apiFetch<{ clients: number; utm_recs: number; tracking_recs: number; signal_recs: number; errors: string[] }>("/api/integrations/propose-tracking", {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (r) =>
      setMsg(
        `Tracking review across ${r.clients} clients: ${r.tracking_recs} Website/Offline toggle item(s), ${r.utm_recs} UTM fix(es), ${r.signal_recs} pixel/CAPI item(s) added to the Actions queue` +
          (r.errors.length ? ` · ${r.errors.length} account(s) could not be read` : ""),
      ),
    onError: (e) => setMsg(`Tracking review failed: ${(e as Error).message}`),
  });
  const run = useMutation({
    mutationFn: () => apiFetch<{ clients: number; red: number; yellow: number }>("/api/integrations/run", { method: "POST", body: "{}" }),
    onSuccess: (r) => {
      setMsg(`Re-checked ${r.clients} clients — ${r.red} red, ${r.yellow} yellow`);
      qc.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (e) => setMsg(`Check failed: ${(e as Error).message}`),
  });

  const d = q.data;
  const counts = { green: 0, yellow: 0, red: 0, grey: 0 } as Record<HealthStatus, number>;
  d?.clients.forEach((c) => (counts[c.overall] += 1));
  const adsChecks = d?.checks.filter((c) => c.group === "ads") ?? [];
  const ghlChecks = d?.checks.filter((c) => c.group === "ghl") ?? [];

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-screen-2xl space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
            <p className="text-sm text-muted-foreground">
              Is every data source linked, syncing, and producing the events the numbers depend on? Green =
              working · yellow = needs attention · red = broken or misconfigured · grey = not applicable.
              Hover a dot for the reason. Re-checked nightly at 2:05 AM before the Daily Brief.
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">
              {d?.checked_at ? `Checked ${new Date(d.checked_at).toLocaleString()}` : "Never checked"}
            </span>
            {isAdmin && (
              <>
              <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
                <RefreshCw className={cn("h-3.5 w-3.5", run.isPending && "animate-spin")} /> Re-check now
              </Button>
              <Button
                size="sm"
                disabled={propose.isPending}
                onClick={() => propose.mutate()}
                title="Writes approval-gated recommendations: standard UTMs on website ads, missing pixels, GHL → Conversions API setup"
              >
                <Radar className={cn("h-3.5 w-3.5", propose.isPending && "animate-spin")} /> Propose tracking fixes
              </Button>
              </>
            )}
          </div>
        </div>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}

        <TrackingRollout />

        <div className="flex flex-wrap gap-4 text-sm">
          {(["red", "yellow", "green"] as HealthStatus[]).map((s) => (
            <span key={s} className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5">
              <Dot status={s} /> {counts[s]} {counts[s] === 1 ? "client" : "clients"} {WORD[s]}
            </span>
          ))}
        </div>

        {q.error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Failed to load: {(q.error as Error).message}
          </p>
        )}

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead>Client</TableHead>
                {adsChecks.map((c) => (
                  <TableHead key={c.key} className="whitespace-nowrap text-center text-xs">{c.label}</TableHead>
                ))}
                <TableHead className="w-px border-l" />
                {ghlChecks.map((c) => (
                  <TableHead key={c.key} className="whitespace-nowrap text-center text-xs">{c.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.isLoading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={12}><Skeleton className="h-6" /></TableCell>
                  </TableRow>
                ))}
              {d?.clients.map((c) => (
                <Fragment key={c.client_id}>
                  <TableRow className="cursor-pointer" onClick={() => setOpen(open === c.client_id ? null : c.client_id)}>
                    <TableCell><Dot status={c.overall} size="h-3.5 w-3.5" /></TableCell>
                    <TableCell className="font-medium">
                      <Link href={`/clients/${c.slug}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{c.name}</Link>
                    </TableCell>
                    {adsChecks.map((k) => (
                      <TableCell key={k.key} className="text-center">
                        <Dot status={c.checks[k.key]?.status ?? "grey"} detail={c.checks[k.key]?.detail} />
                      </TableCell>
                    ))}
                    <TableCell className="w-px border-l" />
                    {ghlChecks.map((k) => (
                      <TableCell key={k.key} className="text-center">
                        <Dot status={c.checks[k.key]?.status ?? "grey"} detail={c.checks[k.key]?.detail} />
                      </TableCell>
                    ))}
                  </TableRow>
                  {open === c.client_id && (
                    <TableRow className="bg-muted/30">
                      <TableCell colSpan={3 + adsChecks.length + ghlChecks.length}>
                        <ul className="grid gap-1.5 py-1 text-sm sm:grid-cols-2">
                          {d.checks.map((k) => {
                            const v = c.checks[k.key];
                            if (!v || v.status === "grey") return null;
                            return (
                              <li key={k.key} className="flex items-start gap-2">
                                <Dot status={v.status} />
                                <span><span className="font-medium">{k.label}:</span> {v.detail}</span>
                              </li>
                            );
                          })}
                        </ul>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
              {!q.isLoading && (d?.clients.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={12} className="py-8 text-center text-muted-foreground">
                    No checks yet.{isAdmin && " Use Re-check now."}
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
