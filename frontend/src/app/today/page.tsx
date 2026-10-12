"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Nav } from "@/components/nav";
import { PlayChip, PlayLegend, PlayList, STATUS_DOT, STATUS_LABEL, StatusPill } from "@/components/plays";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, type ClientStatus, type TodayCard, type TodayResponse } from "@/lib/api";
import { fmtMoney, fmtNum } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Today — the dashboard version of the 5 AM Slack report: every spending client as a card,
 * worst first, with its numbers and the specific plays to make. Same builder as the Slack post.
 */

function Delta({ v }: { v: number | null }) {
  if (v === null) return null;
  return <span className={cn("ml-1 text-[11px]", v > 0 ? "text-emerald-400" : "text-red-400")}>{v > 0 ? "▲" : "▼"}{Math.abs(v)}%</span>;
}

function Triple({ label, y, d7, d30, delta }: { label: string; y: number; d7: number; d30: number; delta: number | null }) {
  return (
    <div className="rounded-md border border-border/60 p-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-3 tabular-nums">
        <span title="yesterday"><span className="text-[10px] text-muted-foreground">yday </span>{fmtNum(y)}</span>
        <span title="last 7 days" className="text-base font-semibold">{fmtNum(d7)}<Delta v={delta} /><span className="text-[10px] font-normal text-muted-foreground"> 7d</span></span>
        <span title="last 30 days" className="text-muted-foreground">{fmtNum(d30)}<span className="text-[10px]"> 30d</span></span>
      </div>
    </div>
  );
}

function CostTile({ card }: { card: TodayCard }) {
  const t = card.target_cpba;
  const c = card.cpba7;
  const ratio = c && t ? c / t : null;
  const color = ratio === null ? "bg-muted-foreground/40" : ratio <= 1 ? "bg-emerald-500" : ratio <= 1.3 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="rounded-md border border-border/60 p-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Cost per booked · 7d</div>
      <div className="mt-0.5 flex items-baseline gap-2 tabular-nums">
        <span className="text-base font-semibold">{c ? fmtMoney(c) : "—"}</span>
        {t && <span className="text-xs text-muted-foreground">target {fmtMoney(t)}</span>}
      </div>
      {ratio !== null && (
        <div className="mt-1 h-1.5 rounded bg-muted" title={`${ratio.toFixed(1)}× target`}>
          <div className={cn("h-1.5 rounded", color)} style={{ width: `${Math.min(ratio / 2, 1) * 100}%` }} />
        </div>
      )}
      <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
        {fmtMoney(card.spend.d7)} spend · CPL {card.cpl7 ? fmtMoney(card.cpl7) : "—"}
      </div>
    </div>
  );
}

function ClientCard({ card }: { card: TodayCard }) {
  return (
    <Card className={cn("border-l-4", card.status === "red" ? "border-l-red-500" : card.status === "yellow" ? "border-l-amber-500" : card.status === "green" ? "border-l-emerald-500" : "border-l-muted")}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Link href={`/clients/${card.slug}`} className="hover:underline">{card.name}</Link>
          <StatusPill status={card.status} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <Triple label="Leads" y={card.leads.y} d7={card.leads.d7} d30={card.leads.d30} delta={card.leads.delta7} />
          {card.booked ? (
            <Triple label="Booked" y={card.booked.y} d7={card.booked.d7} d30={card.booked.d30} delta={card.booked.delta7} />
          ) : (
            <div className="rounded-md border border-border/60 p-2 text-xs text-muted-foreground">
              <div className="text-[11px] uppercase tracking-wide">Booked</div>
              Not tracked — no GHL location or booking sheet
            </div>
          )}
          <CostTile card={card} />
        </div>
        <PlayList issues={card.issues} max={6} />
      </CardContent>
    </Card>
  );
}

export default function TodayPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["today"], queryFn: () => apiFetch<TodayResponse>("/api/today") });
  const groups: ClientStatus[] = ["red", "yellow", "green", "grey"];
  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-screen-xl space-y-5 p-4 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
            <p className="text-sm text-muted-foreground">
              {data ? `Data through ${data.date}. ` : ""}Same report as the 5 AM post in #ads-daily-report. Kills and scales wait in each client&apos;s Actions queue — nothing changes until someone approves.
            </p>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">Failed to load: {(error as Error).message}</p>}
        {isLoading || !data ? (
          <Skeleton className="h-96" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
              {groups.map((g) => (
                <a key={g} href={`#${g}`} className="rounded-lg border p-3 hover:bg-muted/40">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className={cn("h-2 w-2 rounded-full", STATUS_DOT[g])} />{STATUS_LABEL[g]}</div>
                  <div className="text-2xl font-semibold tabular-nums">{data.counts[g]}</div>
                </a>
              ))}
              {(["spend", "leads", "booked"] as const).map((k) => (
                <div key={k} className="rounded-lg border p-3">
                  <div className="text-xs capitalize text-muted-foreground">{k} · 7d</div>
                  <div className="text-2xl font-semibold tabular-nums">{k === "spend" ? fmtMoney(data.totals[k].d7) : fmtNum(data.totals[k].d7)}</div>
                  <div className="text-[11px] text-muted-foreground tabular-nums">yday {k === "spend" ? fmtMoney(data.totals[k].y) : fmtNum(data.totals[k].y)} · 30d {k === "spend" ? fmtMoney(data.totals[k].d30) : fmtNum(data.totals[k].d30)}</div>
                </div>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader className="pb-2"><CardTitle className="text-base">Top actions today</CardTitle></CardHeader>
                <CardContent>
                  <ol className="space-y-2">
                    {data.top_actions.map((i, n) => (
                      <li key={n} className="flex items-start gap-2 text-sm">
                        <span className="w-4 shrink-0 text-right text-muted-foreground tabular-nums">{n + 1}.</span>
                        <PlayChip issue={i} />
                        <span className="min-w-0">
                          <Link href={`/clients/${i.slug}`} className="font-medium hover:underline">{i.client}</Link>
                          {i.campaign && <span className="text-muted-foreground"> · {i.campaign}</span>}
                          <span className="block text-muted-foreground">{i.text}</span>
                        </span>
                      </li>
                    ))}
                    {data.top_actions.length === 0 && <li className="text-sm text-muted-foreground">Nothing urgent.</li>}
                  </ol>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Ready to scale</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {data.wins.map((i, n) => (
                    <div key={n} className="text-sm">
                      <div className="flex items-center gap-2"><PlayChip issue={i} /><Link href={`/clients/${i.slug}`} className="font-medium hover:underline">{i.client}</Link></div>
                      <div className="text-xs text-muted-foreground">{i.campaign} — {i.text}</div>
                    </div>
                  ))}
                  {data.wins.length === 0 && <p className="text-sm text-muted-foreground">No campaign passes the scale gates yet.</p>}
                </CardContent>
              </Card>
            </div>

            <PlayLegend />

            {groups.map((g) => {
              const cards = data.clients.filter((c) => c.status === g);
              if (cards.length === 0) return null;
              return (
                <section key={g} id={g} className="space-y-3">
                  <h2 className="flex items-center gap-2 text-lg font-semibold"><span className={cn("h-2.5 w-2.5 rounded-full", STATUS_DOT[g])} />{STATUS_LABEL[g]} <span className="text-sm font-normal text-muted-foreground">({cards.length})</span></h2>
                  <div className="grid gap-4 xl:grid-cols-2">{cards.map((c) => <ClientCard key={c.slug} card={c} />)}</div>
                </section>
              );
            })}
          </>
        )}
      </main>
    </div>
  );
}
