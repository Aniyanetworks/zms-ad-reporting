"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, type ServiceTargetRow } from "@/lib/api";
import { fmtMoney, fmtNum } from "@/lib/format";
import { cn } from "@/lib/utils";

type Draft = { cpl_green: string; cpl_red: string; cpba_green: string; cpba_red: string };

function toDraft(r: ServiceTargetRow): Draft {
  const t = r.target ?? r.fallback;
  const s = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  return { cpl_green: s(t?.cpl_green), cpl_red: s(t?.cpl_red), cpba_green: s(t?.cpba_green), cpba_red: s(t?.cpba_red) };
}

/** Admin editor for service × platform CPL/CPBA targets — the thresholds every
 * colored number on the dashboard now uses. */
export function ServiceTargetsCard() {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["service-targets"],
    queryFn: () => apiFetch<ServiceTargetRow[]>("/api/service-targets"),
  });

  const save = useMutation({
    mutationFn: (r: ServiceTargetRow) => {
      const d = drafts[`${r.service}|${r.platform}`] ?? toDraft(r);
      const num = (v: string) => (v.trim() === "" ? null : Number(v));
      return apiFetch("/api/service-targets", {
        method: "PUT",
        body: JSON.stringify({
          service: r.service,
          platform: r.platform,
          cpl_green: num(d.cpl_green),
          cpl_red: num(d.cpl_red),
          cpba_green: num(d.cpba_green),
          cpba_red: num(d.cpba_red),
        }),
      });
    },
    onSuccess: (_d, r) => {
      setMsg(`Saved ${r.service} · ${r.platform}`);
      qc.invalidateQueries({ queryKey: ["service-targets"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => setMsg(`Save failed: ${(e as Error).message}`),
  });

  const reseed = useMutation({
    mutationFn: () => apiFetch<{ seeded: number }>("/api/service-targets/reseed", { method: "POST" }),
    onSuccess: (d) => {
      setMsg(`Seeded ${d.seeded} new target${d.seeded === 1 ? "" : "s"} from 90-day averages`);
      qc.invalidateQueries({ queryKey: ["service-targets"] });
    },
  });

  const draftFor = (r: ServiceTargetRow) => drafts[`${r.service}|${r.platform}`] ?? toDraft(r);
  const setField = (r: ServiceTargetRow, k: keyof Draft, v: string) =>
    setDrafts((d) => ({ ...d, [`${r.service}|${r.platform}`]: { ...draftFor(r), [k]: v } }));

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Service targets</CardTitle>
          <CardDescription>
            What a lead and a booked appointment should cost, per service and platform. These thresholds
            color every CPL/CPBA on the dashboard and set each client&rsquo;s status from its service mix.
            &ldquo;Seed&rdquo; rows are the portfolio&rsquo;s 90-day average (green) and 1.5× (red) — edit
            any number and save to make it yours.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" disabled={reseed.isPending} onClick={() => reseed.mutate()}>
          <RefreshCw className="h-3.5 w-3.5" /> Seed missing
        </Button>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {msg && <p className="px-6 pb-2 text-xs text-muted-foreground">{msg}</p>}
        {q.isLoading ? (
          <Skeleton className="m-6 h-32" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead className="text-right" title="Trailing 90 days across all clients">90d CPL</TableHead>
                  <TableHead className="text-right">90d CPBA</TableHead>
                  <TableHead className="text-right">CPL green ≤</TableHead>
                  <TableHead className="text-right">CPL red &gt;</TableHead>
                  <TableHead className="text-right">CPBA green ≤</TableHead>
                  <TableHead className="text-right">CPBA red &gt;</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data?.map((r) => {
                  const d = draftFor(r);
                  const src = r.target?.source ?? (r.fallback ? "all-platform fallback" : "none — uses client targets");
                  return (
                    <TableRow key={`${r.service}|${r.platform}`}>
                      <TableCell className="font-medium">{r.service}</TableCell>
                      <TableCell>
                        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium uppercase",
                          r.platform === "google" ? "bg-amber-500/15 text-amber-400" : r.platform === "meta" ? "bg-sky-500/15 text-sky-400" : r.platform === "lsa" ? "bg-violet-500/15 text-violet-400" : "bg-muted text-muted-foreground")}>
                          {r.platform}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmtMoney(r.cpl)} <span className="text-[10px]">({fmtNum(r.leads)}L)</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtMoney(r.cpba)}</TableCell>
                      {(["cpl_green", "cpl_red", "cpba_green", "cpba_red"] as (keyof Draft)[]).map((k) => (
                        <TableCell key={k} className="text-right">
                          <Input
                            className="h-8 w-24 text-right tabular-nums"
                            inputMode="decimal"
                            value={d[k]}
                            placeholder="—"
                            onChange={(e) => setField(r, k, e.target.value)}
                          />
                        </TableCell>
                      ))}
                      <TableCell className="text-xs text-muted-foreground">{src}</TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate(r)}>
                          Save
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
