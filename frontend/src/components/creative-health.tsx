"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PlayLegend, PlayList, StatusPill } from "@/components/plays";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, type ClientPlaysResponse, type CreativeAdRow, type CreativeHealthResponse } from "@/lib/api";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

const PLAY_ICON: Record<string, string> = {
  new_hook: "🎣", sharper_hook: "🎣", swap_open: "🎣", fix_promise: "🎬", new_angle: "💡", fix_form: "📝",
  fix_page: "🐢", fresh_test: "🔁",
};
const PLAY_LABEL: Record<string, string> = {
  new_hook: "New hook", sharper_hook: "Sharpen hook", swap_open: "Swap first 3s", fix_promise: "Promise sooner",
  new_angle: "New angle", fix_form: "Fix form", fix_page: "Fix page", fresh_test: "Fresh test",
};

/** "Today's plays" for one client — the same card the Today page and the Slack post show. */
export function TodayPlays({ slug }: { slug: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["plays", slug], queryFn: () => apiFetch<ClientPlaysResponse>(`/api/clients/${slug}/plays`) });
  if (isLoading) return <Skeleton className="h-32" />;
  if (!data?.card) return null;
  return (
    <Card className={cn("border-l-4", data.card.status === "red" ? "border-l-red-500" : data.card.status === "yellow" ? "border-l-amber-500" : data.card.status === "green" ? "border-l-emerald-500" : "border-l-muted")}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          Today&apos;s plays <StatusPill status={data.card.status} />
          <span className="text-xs font-normal text-muted-foreground">data through {data.date}{data.brief_date ? ` · brief ${data.brief_date}` : ""}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <PlayList issues={data.card.issues} max={8} />
        <PlayLegend />
      </CardContent>
    </Card>
  );
}

function Rate({ v, bad, good, nd = 0, title }: { v: number | null; bad?: (v: number) => boolean; good?: (v: number) => boolean; nd?: number; title?: string }) {
  if (v === null || v === undefined) return <TableCell className="text-right text-muted-foreground">—</TableCell>;
  return (
    <TableCell title={title} className={cn("text-right tabular-nums", bad?.(v) ? "text-red-400" : good?.(v) ? "text-emerald-400" : "")}>
      {fmtPct(v, nd)}
    </TableCell>
  );
}

function Trend({ now, prev, money }: { now: number | null; prev: number | null; money?: boolean }) {
  if (now === null) return <TableCell className="text-right text-muted-foreground">—</TableCell>;
  const up = prev ? now / prev - 1 : null;
  const f = (x: number) => (money ? fmtMoney(x) : x.toFixed(2));
  return (
    <TableCell className="text-right tabular-nums">
      {f(now)}
      {up !== null && Math.abs(up) >= 0.2 && <span className={cn("ml-1 text-[11px]", up > 0 ? "text-amber-400" : "text-muted-foreground")}>{up > 0 ? "▲" : "▼"}{Math.round(Math.abs(up) * 100)}%</span>}
    </TableCell>
  );
}

/** Per-ad creative health for the last 7 days: the metrics the Meta Ad Mastery checks read. */
export function CreativeHealth({ slug }: { slug: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["creative-health", slug], queryFn: () => apiFetch<CreativeHealthResponse>(`/api/clients/${slug}/creative-health`) });
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  if (isLoading) return <Skeleton className="h-48" />;
  if (!data || data.ads.length === 0) return null;
  const b = data.benchmarks;
  const rows: CreativeAdRow[] = onlyFlagged ? data.ads.filter((a) => a.plays.length > 0) : data.ads;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-3 text-base">
          Creative health <span className="text-xs font-normal text-muted-foreground">Meta ads · last 7 days vs the 7 before · through {data.end}</span>
          <label className="ml-auto flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
            <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> only ads with a play
          </label>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Hook = 3-second plays ÷ impressions (red &lt;20%, green ≥35%). Hold = ThruPlays ÷ 3-second plays (red &lt;20%, green ≥40%). CTR = unique clicks ÷ impressions (red &lt;1%). Form-through = leads ÷ unique link clicks (Instant Forms). Page load = landing-page views ÷ clicks (website ads, red &lt;60%). Frequency and cost per 1,000 reached rising together = real fatigue.
        </p>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ad</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">CPL</TableHead>
                <TableHead className="text-right" title="unique clicks ÷ impressions">CTR</TableHead>
                <TableHead className="text-right" title="cost per unique click">Cost/click</TableHead>
                <TableHead className="text-right" title="3-second plays ÷ impressions">Hook</TableHead>
                <TableHead className="text-right" title="ThruPlays ÷ 3-second plays">Hold</TableHead>
                <TableHead className="text-right" title="Instant Form: leads ÷ unique link clicks · Website: landing-page views ÷ clicks">Form / page</TableHead>
                <TableHead className="text-right" title="impressions ÷ reach, vs prior 7 days">Freq.</TableHead>
                <TableHead className="text-right" title="cost per 1,000 people reached, vs prior 7 days">CPMr</TableHead>
                <TableHead>Play</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 40).map((a) => (
                <TableRow key={a.ad_id}>
                  <TableCell className="max-w-[16rem]">
                    <div className="truncate font-medium">{a.ad_name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{a.campaign}</div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{a.format} · {a.destination === "website" ? "web" : "form"}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoney(a.spend)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(a.leads)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoney(a.cpl)}</TableCell>
                  <Rate v={a.ctr} nd={2} bad={(v) => v < b.ctr_low} good={(v) => v >= 0.015} />
                  <TableCell className={cn("text-right tabular-nums", a.cpc && a.cpc > b.cpc_warn ? "text-amber-400" : "")}>{fmtMoney(a.cpc)}</TableCell>
                  {a.format === "video" ? (
                    <>
                      <Rate v={a.hook} bad={(v) => v < b.hook_low} good={(v) => v >= 0.35} />
                      <Rate v={a.hold} bad={(v) => v < b.hold_low} good={(v) => v >= b.hold_high} />
                    </>
                  ) : (
                    <>
                      <TableCell className="text-right text-[11px] text-muted-foreground">image</TableCell>
                      <TableCell />
                    </>
                  )}
                  {a.destination === "website" ? (
                    <Rate v={a.lpv_ratio} bad={(v) => v < b.lpv_low} title="landing-page views ÷ clicks" />
                  ) : (
                    <Rate v={a.form_through} bad={(v) => v < b.ft_low} title="leads ÷ unique link clicks" />
                  )}
                  <Trend now={a.freq} prev={a.freq_prev} />
                  <Trend now={a.cpmr} prev={a.cpmr_prev} money />
                  <TableCell className="whitespace-nowrap text-xs">
                    {a.plays.map((p) => <span key={p} className="mr-1" title={PLAY_LABEL[p] ?? p}>{PLAY_ICON[p] ?? "•"} {PLAY_LABEL[p] ?? p}</span>)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {rows.length > 40 && <p className="px-4 pt-2 text-xs text-muted-foreground">Showing the 40 highest-spend ads of {rows.length}.</p>}
      </CardContent>
    </Card>
  );
}
