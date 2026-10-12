"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Nav } from "@/components/nav";
import { KpiCard } from "@/components/kpi-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, type BriefFinding, type BriefResponse, type ClientBrief } from "@/lib/api";
import { fmtMoney, fmtNum } from "@/lib/format";
import { useMe } from "@/lib/me";
import { canManage } from "@/lib/permissions";
import { cn } from "@/lib/utils";

const DOT: Record<string, string> = { green: "bg-emerald-500", yellow: "bg-amber-500", red: "bg-red-500" };
const SEV: Record<BriefFinding["severity"], string> = {
  red: "bg-red-500/15 text-red-400",
  yellow: "bg-amber-500/15 text-amber-400",
  info: "bg-sky-500/15 text-sky-400",
};
const ACTION_LABEL: Record<string, string> = {
  pause: "Pause",
  budget_change: "Budget change",
  refresh_creative: "Refresh creative",
  fix_signal: "Fix tracking",
  investigate: "Investigate",
  activate: "Activate",
};

const VERDICT: Record<string, { label: string; cls: string }> = {
  fix: { label: "FIX", cls: "bg-red-500/15 text-red-400" },
  kill: { label: "KILL", cls: "bg-red-500/15 text-red-400" },
  kill_or_rebuild: { label: "KILL / REBUILD", cls: "bg-red-500/15 text-red-400" },
  quality_fail: { label: "QUALITY", cls: "bg-amber-500/15 text-amber-400" },
  diagnose: { label: "DIAGNOSE", cls: "bg-amber-500/15 text-amber-400" },
  scale: { label: "SCALE", cls: "bg-emerald-500/15 text-emerald-400" },
  micro_scale: { label: "MICRO-SCALE", cls: "bg-emerald-500/15 text-emerald-400" },
  hold: { label: "HOLD", cls: "bg-muted text-muted-foreground" },
  no_verdict: { label: "NO VERDICT", cls: "bg-muted text-muted-foreground" },
};

/** Kill/Scale SOP verdicts — one row per campaign, expandable to the five-part decision. */
function Decisions({ verdicts }: { verdicts: BriefFinding[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (verdicts.length === 0) return null;
  const ev = (f: BriefFinding) => f.evidence as Record<string, number | string | null>;
  const money = (v: unknown) => (typeof v === "number" ? fmtMoney(v) : "—");
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Kill / Scale SOP decisions
        <span className="font-normal normal-case tracking-normal">· scheduled = paid GHL bookings (tagged + lead-share estimate) · Tₛ = cost-per-appointment target</span>
      </div>
      <ul className="divide-y">
        {verdicts.map((f) => {
          const e = ev(f);
          const key = String(f.entity_id);
          const v = VERDICT[f.verdict ?? "hold"];
          return (
            <li key={key} className="px-3 py-2 text-sm">
              <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left" onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
                <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold", v.cls)}>{v.label}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{f.entity_name}</span>
                <span className="text-xs text-muted-foreground">{f.gate}</span>
                <span className="ml-auto flex gap-3 text-xs tabular-nums text-muted-foreground">
                  <span title="spend 7d / 14d">{money(e.spend_7)} / {money(e.spend_14)}</span>
                  <span title="scheduled 7d / 14d">{fmtNum(Number(e.scheduled_7 ?? 0))} / {fmtNum(Number(e.scheduled_14 ?? 0))} sched</span>
                  <span title="cost per scheduled (14d) vs target">CPAₛ {money(e.cpa_s_14)} vs {money(e.target_ts)}</span>
                  {f.proposed_value && <span className="text-foreground">→ {f.proposed_value}</span>}
                </span>
              </button>
              {open[key] && f.decision && (
                <dl className="mt-2 grid gap-x-4 gap-y-1 rounded bg-muted/40 p-2 text-xs sm:grid-cols-[7rem_1fr]">
                  <dt className="text-muted-foreground">Decision</dt><dd className="capitalize">{f.decision.decision}</dd>
                  <dt className="text-muted-foreground">Evidence</dt><dd>{f.decision.evidence}</dd>
                  {f.layer && (<><dt className="text-muted-foreground">First leak</dt><dd>{f.layer}</dd></>)}
                  <dt className="text-muted-foreground">Confidence</dt><dd className="capitalize">{f.decision.confidence}</dd>
                  {f.decision.expected_impact && (<><dt className="text-muted-foreground">Expected impact</dt><dd>{f.decision.expected_impact}</dd></>)}
                  <dt className="text-muted-foreground">Next step</dt><dd>{f.decision.next_step}</dd>
                  {f.risk && (<><dt className="text-muted-foreground">Risk</dt><dd>{f.risk}</dd></>)}
                </dl>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function delta(pct: number | null): string {
  if (pct === null) return "";
  return `${pct >= 0 ? "▲" : "▼"}${Math.abs(pct)}%`;
}

function ClientCard({ b }: { b: ClientBrief }) {
  const t = b.platforms.totals;
  const [showAll, setShowAll] = useState(false);
  const verdicts = b.findings.filter((f) => f.kind === "sop_verdict");
  const others = b.findings.filter((f) => f.kind !== "sop_verdict");
  const findings = showAll ? others : others.filter((f) => f.severity !== "info").slice(0, 6);
  const hidden = others.length - findings.length;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-3 text-base">
          <span className={cn("inline-block h-2.5 w-2.5 rounded-full", DOT[b.score ?? ""] ?? "bg-muted")} />
          <Link href={`/clients/${b.slug}`} className="hover:underline">{b.name}</Link>
          <span className="text-xs font-normal text-muted-foreground">
            {b.window_start} → {b.window_end}
          </span>
          <span className="ml-auto flex flex-wrap gap-3 text-sm font-normal tabular-nums">
            {b.platforms.platforms.map((p) => (
              <span key={p.platform} className="text-muted-foreground">
                <span className={cn("mr-1 rounded px-1 text-[10px] font-medium uppercase", p.platform === "google" ? "bg-amber-500/15 text-amber-400" : p.platform === "lsa" ? "bg-violet-500/15 text-violet-400" : "bg-sky-500/15 text-sky-400")}>
                  {p.platform}
                </span>
                {fmtMoney(p.spend_a)} · {fmtNum(p.leads_a)}L ·{" "}
                <span className={cn(p.cpl_a !== null && (p.cpl_a <= p.expected_green ? "text-emerald-400" : p.cpl_a <= p.expected_red ? "text-amber-400" : "text-red-400"))}>
                  {fmtMoney(p.cpl_a)}
                </span>{" "}
                <span className="text-[11px]">{delta(p.spend_delta_pct)}</span>
              </span>
            ))}
            {b.booking_system !== "other" && (
              <span className="text-muted-foreground">
                {fmtNum(Math.round(t.appts_a))} appts{t.cpba_a !== null && ` · ${fmtMoney(t.cpba_a)}`}
              </span>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{b.summary_md}</p>
        <Decisions verdicts={verdicts} />
        {findings.length > 0 && (
          <ul className="space-y-1.5">
            {findings.map((f, i) => (
              <li key={i} className="flex flex-wrap items-start gap-2 text-sm">
                <span className={cn("mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase", SEV[f.severity])}>{f.severity}</span>
                <span className="min-w-0 flex-1">{f.message}</span>
                {f.action && (
                  <span
                    className="shrink-0 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    title={f.recommendation === "proposed" ? "Written to the client's Actions queue tonight" : "An open recommendation for this already exists"}
                  >
                    → {ACTION_LABEL[f.action] ?? f.action}
                    {f.proposed_value && ` ${f.proposed_value}`}
                    {f.recommendation === "already open" && " (open)"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {hidden > 0 && (
          <button className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowAll(true)}>
            Show {hidden} more
          </button>
        )}
        {others.length === 0 && verdicts.length === 0 && <p className="text-xs text-muted-foreground">Nothing flagged — all campaigns inside their service targets.</p>}
      </CardContent>
    </Card>
  );
}

export default function BriefPage() {
  const qc = useQueryClient();
  const me = useMe();
  const isAdmin = canManage(me.data?.role);
  const [date, setDate] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const dates = useQuery({ queryKey: ["brief-dates"], queryFn: () => apiFetch<string[]>("/api/brief/dates") });
  const q = useQuery({
    queryKey: ["brief", date],
    queryFn: () => apiFetch<BriefResponse>(`/api/brief${date ? `?date=${date}` : ""}`),
  });

  const run = useMutation({
    mutationFn: () => apiFetch<{ date: string; clients: number }>("/api/brief/run", { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (r) => {
      setMsg(`Brief refreshed for ${r.date} (${r.clients} clients)`);
      qc.invalidateQueries({ queryKey: ["brief"] });
      qc.invalidateQueries({ queryKey: ["brief-dates"] });
      qc.invalidateQueries({ queryKey: ["recommendations"] });
    },
    onError: (e) => setMsg(`Run failed: ${(e as Error).message}`),
  });

  const list = dates.data ?? [];
  const current = q.data?.date ?? date ?? list[0] ?? null;
  const idx = current ? list.indexOf(current) : -1;
  const clients = q.data?.clients ?? [];
  const counts = { red: 0, yellow: 0, green: 0 };
  let spend = 0, leads = 0, proposed = 0;
  for (const b of clients) {
    if (b.score) counts[b.score] += 1;
    spend += b.platforms.totals.spend_a;
    leads += b.platforms.totals.leads_a;
    proposed += b.findings.filter((f) => f.recommendation === "proposed").length;
  }

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-screen-2xl space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Daily Brief</h1>
            <p className="text-sm text-muted-foreground">
              Written every night at 2:15 AM after the syncs: the last 7 complete days vs the 7 before, per
              client, per platform, judged against the service targets. Anything that calls for a change is
              proposed in that client&rsquo;s Actions queue — nothing changes in Meta or Google until a
              person approves it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={idx < 0 || idx >= list.length - 1} onClick={() => setDate(list[idx + 1])}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-28 text-center text-sm tabular-nums">{current ?? "—"}</span>
            <Button size="sm" variant="outline" disabled={idx <= 0} onClick={() => setDate(list[idx - 1])}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            {isAdmin && (
              <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate()} title="Re-run for yesterday">
                <RefreshCw className={cn("h-3.5 w-3.5", run.isPending && "animate-spin")} /> Refresh
              </Button>
            )}
          </div>
        </div>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {q.isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)
          ) : (
            <>
              <KpiCard label="Clients" value={String(clients.length)} hint={`${counts.red} red · ${counts.yellow} yellow · ${counts.green} green`} />
              <KpiCard label="Spend (7d)" value={fmtMoney(spend)} />
              <KpiCard label="Leads (7d)" value={fmtNum(leads)} hint={`CPL ${fmtMoney(leads ? spend / leads : null)}`} />
              <KpiCard label="New recommendations" value={String(proposed)} hint="approve or dismiss on each client page" />
            </>
          )}
        </div>

        {q.error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Failed to load brief: {(q.error as Error).message}
          </p>
        )}
        {!q.isLoading && clients.length === 0 && (
          <p className="text-sm text-muted-foreground">No brief for this date yet.{isAdmin && " Use Refresh to generate one."}</p>
        )}
        <div className="space-y-4">
          {clients.map((b) => <ClientCard key={b.id} b={b} />)}
        </div>
      </main>
    </div>
  );
}
