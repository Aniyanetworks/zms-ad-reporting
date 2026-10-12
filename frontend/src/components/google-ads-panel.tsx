"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch, type GoogleAdsCampaign, type GoogleAdsReport, type LandingPageCheck } from "@/lib/api";
import type { DateRange } from "@/components/date-range-picker";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

const LEVEL: Record<string, string> = {
  red: "bg-red-500/15 text-red-400 border-red-500/30",
  yellow: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  info: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  green: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
};

function Flag({ level, text }: { level: string; text: string }) {
  return (
    <span className={cn("inline-flex items-start gap-1.5 rounded-md border px-2 py-1 text-xs", LEVEL[level] ?? LEVEL.info)}>
      {level === "info" ? <Info className="mt-0.5 h-3 w-3 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />}
      {text}
    </span>
  );
}

function Money({ v }: { v: number | null | undefined }) {
  return <TableCell className="text-right tabular-nums">{fmtMoney(v)}</TableCell>;
}
function Num({ v }: { v: number | null | undefined }) {
  return <TableCell className="text-right tabular-nums">{fmtNum(v)}</TableCell>;
}

function LandingRow({ lp }: { lp: LandingPageCheck }) {
  return (
    <TableRow>
      <TableCell>
        <span className={cn("inline-block h-2.5 w-2.5 rounded-full", lp.status === "red" ? "bg-red-500" : lp.status === "yellow" ? "bg-amber-500" : "bg-emerald-500")} />
      </TableCell>
      <TableCell className="max-w-[28rem] truncate">
        <a href={lp.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
          {lp.url.replace(/^https?:\/\//, "")}
          <ExternalLink className="h-3 w-3" />
        </a>
        {lp.title && <div className="truncate text-xs text-muted-foreground">{lp.title}</div>}
      </TableCell>
      <TableCell className="text-xs">{(lp.platforms ?? []).join(", ")}</TableCell>
      <Money v={lp.spend_30d} />
      <TableCell className="text-right tabular-nums">{lp.http_status ?? "—"}</TableCell>
      <TableCell className="text-xs">{lp.client_rendered ? "app page" : lp.has_form === null ? "—" : lp.has_form ? "yes" : "no"}</TableCell>
      <TableCell className="text-xs">{lp.client_rendered ? "app page" : lp.has_tel_link === null ? "—" : lp.has_tel_link ? "yes" : "no"}</TableCell>
      <TableCell className="text-xs">{lp.looks_thank_you ? <span className="font-medium text-red-400">YES</span> : "no"}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{(lp.flags ?? []).join("; ") || lp.error || ""}</TableCell>
    </TableRow>
  );
}

function CampaignBlock({ c, green, red }: { c: GoogleAdsCampaign; green: number; red: number }) {
  const [open, setOpen] = useState(c.flags.some((f) => f.level === "red"));
  const ts = c.term_stats;
  const unmanagedPct = ts.spend ? ts.unmanaged_spend / ts.spend : null;
  const mixTotal = c.match_mix.EXACT + c.match_mix.PHRASE + c.match_mix.BROAD;
  const cpcColor = c.cost_per_conv === null ? "" : c.cost_per_conv <= green ? "text-emerald-400" : c.cost_per_conv <= red ? "text-amber-400" : "text-red-400";
  return (
    <div className="rounded-lg border">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left">
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <span className="font-medium">{c.campaign_name ?? c.campaign_id}</span>
        <span className="text-xs text-muted-foreground">{c.campaign_status}{c.daily_budget ? ` · ${fmtMoney(c.daily_budget)}/day` : c.lifetime_budget ? ` · ${fmtMoney(c.lifetime_budget)} total` : ""}</span>
        <span className="ml-auto flex flex-wrap gap-x-4 text-sm tabular-nums">
          <span>{fmtMoney(c.spend)} spend</span>
          <span>{fmtNum(c.clicks)} clicks</span>
          <span>{fmtMoney(c.cpc)} CPC</span>
          <span>{fmtNum(c.conversions)} conv</span>
          <span className={cpcColor}>{fmtMoney(c.cost_per_conv)}/conv</span>
          {c.phone_calls > 0 && <span>{fmtNum(c.phone_calls)} calls</span>}
        </span>
      </button>
      {c.flags.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          {c.flags.map((f, i) => <Flag key={i} level={f.level} text={f.text} />)}
        </div>
      )}
      {open && (
        <div className="border-t px-4 py-3">
          <div className="mb-3 grid gap-3 text-xs text-muted-foreground sm:grid-cols-4">
            <div><span className="text-foreground">{fmtMoney(ts.spend)}</span> search-term spend across {ts.terms} terms</div>
            <div><span className={cn("text-foreground", unmanagedPct !== null && unmanagedPct > 0.5 && "text-amber-400")}>{fmtPct(unmanagedPct, 0)}</span> on queries that aren&apos;t keywords ({fmtMoney(ts.unmanaged_spend)})</div>
            <div><span className="text-foreground">{fmtMoney(ts.converting_spend)}</span> on converting terms · <span className="text-foreground">{fmtMoney(ts.off_intent_spend)}</span> off-intent</div>
            <div>
              Match mix:{" "}
              {(["EXACT", "PHRASE", "BROAD"] as const).map((m) => (
                <span key={m} className="mr-2"><span className="text-foreground">{mixTotal ? Math.round((c.match_mix[m] / mixTotal) * 100) : 0}%</span> {m.toLowerCase()}</span>
              ))}
            </div>
          </div>
          <Tabs defaultValue="terms">
            <TabsList>
              <TabsTrigger value="terms">Search terms ({ts.terms})</TabsTrigger>
              <TabsTrigger value="keywords">Keywords ({c.keyword_count})</TabsTrigger>
              <TabsTrigger value="ads">Ads ({c.ads.length})</TabsTrigger>
              <TabsTrigger value="adgroups">Ad groups ({c.ad_groups.length})</TabsTrigger>
              <TabsTrigger value="landing">Landing pages ({c.landing_pages.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="terms">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>Search term</TableHead><TableHead>Keyword?</TableHead><TableHead className="text-right">Spend</TableHead><TableHead className="text-right">Clicks</TableHead><TableHead className="text-right">Conv</TableHead><TableHead className="text-right">Cost/Conv</TableHead><TableHead>Flag</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {c.search_terms.map((t) => (
                      <TableRow key={t.search_term}>
                        <TableCell>{t.search_term}</TableCell>
                        <TableCell className="text-xs">{t.term_status === "ADDED" ? "yes" : t.term_status === "EXCLUDED" ? "negative" : "no"}</TableCell>
                        <Money v={t.spend} /><Num v={t.clicks} /><Num v={t.conversions} /><Money v={t.cost_per_conv} />
                        <TableCell className={cn("text-xs", t.flag === "converting" ? "text-emerald-400" : t.flag === "off-intent" ? "text-red-400" : t.flag?.includes("no conv") ? "text-amber-400" : "text-muted-foreground")}>{t.flag ?? ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
            <TabsContent value="keywords">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>Keyword</TableHead><TableHead>Match</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Spend</TableHead><TableHead className="text-right">Impr.</TableHead><TableHead className="text-right">Clicks</TableHead><TableHead className="text-right">CPC</TableHead><TableHead className="text-right">Conv</TableHead><TableHead className="text-right">Cost/Conv</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {c.keywords.map((k) => (
                      <TableRow key={`${k.ad_group_id}-${k.criterion_id}`}>
                        <TableCell>{k.keyword_text}</TableCell>
                        <TableCell className={cn("text-xs", k.match_type === "BROAD" && "text-amber-400")}>{k.match_type?.toLowerCase()}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{k.status?.toLowerCase()}</TableCell>
                        <Money v={k.spend} /><Num v={k.impressions} /><Num v={k.clicks} /><Money v={k.cpc} /><Num v={k.conversions} /><Money v={k.cost_per_conv} />
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
            <TabsContent value="ads">
              <div className="space-y-3">
                {c.ads.map((a) => (
                  <div key={a.ad_id} className="rounded-md border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="font-medium">{a.ad_group_name}</span>
                      <span className="text-xs text-muted-foreground">{a.ad_type?.replace(/_/g, " ").toLowerCase()} · {a.status?.toLowerCase()}</span>
                      <span className={cn("text-xs", a.ad_strength === "EXCELLENT" || a.ad_strength === "GOOD" ? "text-emerald-400" : "text-amber-400")}>strength {a.ad_strength?.toLowerCase() ?? "—"}</span>
                      <span className="ml-auto text-xs tabular-nums">{fmtMoney(a.spend)} · {fmtNum(a.clicks)} clicks · {fmtNum(a.conversions)} conv · {fmtMoney(a.cost_per_conv)}/conv</span>
                    </div>
                    {(a.final_urls ?? []).map((u) => (
                      <a key={u} href={u} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">{u}<ExternalLink className="h-3 w-3" /></a>
                    ))}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(a.headlines ?? []).map((h, i) => <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-xs">{h.text}</span>)}
                    </div>
                    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                      {(a.descriptions ?? []).map((d, i) => <div key={i}>{d.text}</div>)}
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>
            <TabsContent value="adgroups">
              <Table>
                <TableHeader><TableRow><TableHead>Ad group</TableHead><TableHead>Type</TableHead><TableHead className="text-right">Spend</TableHead><TableHead className="text-right">Impr.</TableHead><TableHead className="text-right">Clicks</TableHead><TableHead className="text-right">CPC</TableHead><TableHead className="text-right">Conv</TableHead><TableHead className="text-right">Cost/Conv</TableHead></TableRow></TableHeader>
                <TableBody>
                  {c.ad_groups.map((g) => (
                    <TableRow key={g.ad_group_id}>
                      <TableCell>{g.ad_group_name} <span className="text-xs text-muted-foreground">{g.status?.toLowerCase()}</span></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{g.type?.replace(/_/g, " ").toLowerCase()}</TableCell>
                      <Money v={g.spend} /><Num v={g.impressions} /><Num v={g.clicks} /><Money v={g.cpc} /><Num v={g.conversions} /><Money v={g.cost_per_conv} />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="landing">
              {c.landing_pages.length === 0 ? (
                <p className="text-sm text-muted-foreground">No landing-page check yet (runs nightly at 2:05 AM).</p>
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead></TableHead><TableHead>URL</TableHead><TableHead>Used by</TableHead><TableHead className="text-right">Spend 30d</TableHead><TableHead className="text-right">HTTP</TableHead><TableHead>Form</TableHead><TableHead>Tap-to-call</TableHead><TableHead>Thank-you page?</TableHead><TableHead>Flags</TableHead></TableRow></TableHeader>
                  <TableBody>{c.landing_pages.map((lp) => <LandingRow key={lp.url} lp={lp} />)}</TableBody>
                </Table>
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );
}

/** Google Ads decision report: campaign → ad groups / RSA copy / keywords / search terms / landing pages, with waste flags. */
export function GoogleAdsPanel({ slug, range }: { slug: string; range: DateRange }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["google-ads", slug, range.start, range.end],
    queryFn: () => apiFetch<GoogleAdsReport>(`/api/clients/${slug}/google-ads?start=${range.start}&end=${range.end}`),
  });
  if (isLoading) return <Skeleton className="h-40" />;
  if (error || !data) return null;
  if (data.campaigns.length === 0 && data.landing_pages.length === 0) return null;
  const t = data.totals;
  const unmanagedPct = t.term_spend ? t.unmanaged_spend / t.term_spend : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-3 text-base">
          Google Ads decisions
          {t.red_flags > 0 && <Flag level="red" text={`${t.red_flags} red`} />}
          {t.yellow_flags > 0 && <Flag level="yellow" text={`${t.yellow_flags} to review`} />}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {fmtMoney(t.spend)} spend · {fmtNum(t.clicks)} clicks · {fmtNum(t.conversions)} conversions
          {t.phone_calls > 0 ? ` · ${fmtNum(t.phone_calls)} calls` : ""} · {fmtPct(unmanagedPct, 0)} of search-term spend on queries that aren&apos;t keywords ·{" "}
          {fmtMoney(t.off_intent_spend)} off-intent. Ad groups, RSA copy, keywords and search terms sync nightly; landing pages are checked at 2:05 AM.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.campaigns.map((c) => (
          <CampaignBlock key={c.campaign_id} c={c} green={data.client.cpl_target_green} red={data.client.cpl_target_red} />
        ))}
        {data.landing_pages.some((lp) => !data.campaigns.some((c) => c.landing_pages.some((x) => x.url === lp.url))) && (
          <div className="rounded-lg border p-3">
            <div className="mb-2 text-sm font-medium">Other landing pages receiving paid traffic</div>
            <Table>
              <TableHeader><TableRow><TableHead></TableHead><TableHead>URL</TableHead><TableHead>Used by</TableHead><TableHead className="text-right">Spend 30d</TableHead><TableHead className="text-right">HTTP</TableHead><TableHead>Form</TableHead><TableHead>Tap-to-call</TableHead><TableHead>Thank-you page?</TableHead><TableHead>Flags</TableHead></TableRow></TableHeader>
              <TableBody>
                {data.landing_pages.filter((lp) => !data.campaigns.some((c) => c.landing_pages.some((x) => x.url === lp.url))).map((lp) => <LandingRow key={lp.url} lp={lp} />)}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
