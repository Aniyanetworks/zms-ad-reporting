"use client";

import { Fragment, use, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { Nav } from "@/components/nav";
import { CplCell } from "@/components/cpl-cell";
import { AdsetRows } from "@/components/drilldown-rows";
import { PeriodTable } from "@/components/period-table";
import { CreativeBoard } from "@/components/creative-board";
import { ActionsQueue } from "@/components/actions-queue";
import { AiBundleButton } from "@/components/ai-bundle-button";
import { GoogleAdsPanel } from "@/components/google-ads-panel";
import { FunnelCard } from "@/components/funnel-card";
import { CreativeHealth, TodayPlays } from "@/components/creative-health";
import { DateRangePicker, defaultRange, type DateRange } from "@/components/date-range-picker";
import { KpiCard } from "@/components/kpi-card";
import { TrendChart } from "@/components/trend-chart";
import { Badge } from "@/components/ui/badge";
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
import { apiFetch, type Campaign, type ClientDetailResponse, type Scorecard } from "@/lib/api";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

const SCORE_DOT: Record<string, string> = { green: "bg-emerald-500", yellow: "bg-amber-500", red: "bg-red-500" };
const SCORE_CLASS: Record<string, string> = {
  green: "bg-emerald-500/15 text-emerald-400",
  yellow: "bg-amber-500/15 text-amber-400",
  red: "bg-red-500/15 text-red-400",
};

/** Per-service rollup of one client's campaigns, each judged against the portfolio average for that service. */
function ServiceSummary({ campaigns }: { campaigns: Campaign[] }) {
  const groups = new Map<string, { service: string; platform: string; spend: number; leads: number; appts: number; service_cpl: number | null; n: number }>();
  for (const c of campaigns) {
    if (c.spend <= 0) continue;
    // Meta and Google buy differently — never average them into one CPL.
    const key = `${c.service ?? "Unclassified"}|${c.platform}`;
    const g = groups.get(key) ?? { service: c.service ?? "Unclassified", platform: c.platform, spend: 0, leads: 0, appts: 0, service_cpl: c.service_cpl, n: 0 };
    g.spend += c.spend;
    g.leads += c.leads;
    g.appts += c.appointments;
    g.n += 1;
    groups.set(key, g);
  }
  if (groups.size < 2) return null;
  const rows = [...groups.entries()].sort((a, b) => b[1].spend - a[1].spend);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          By service
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            this client&rsquo;s campaigns grouped by what they sell, vs the portfolio average for that service
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Service</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead className="text-right">Campaigns</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead className="text-right">CPL</TableHead>
              <TableHead className="text-right">Portfolio CPL</TableHead>
              <TableHead className="text-right">Appts</TableHead>
              <TableHead className="text-right">Cost/Appt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(([key, g]) => {
              const cpl = g.leads ? g.spend / g.leads : null;
              const ratio = cpl !== null && g.service_cpl ? cpl / g.service_cpl : null;
              const cls = ratio === null ? "" : ratio <= 0.85 ? SCORE_CLASS.green : ratio <= 1.15 ? SCORE_CLASS.yellow : SCORE_CLASS.red;
              return (
                <TableRow key={key}>
                  <TableCell className="font-medium">{g.service}</TableCell>
                  <TableCell>
                    <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium uppercase", g.platform === "google" ? "bg-amber-500/15 text-amber-400" : g.platform === "lsa" ? "bg-violet-500/15 text-violet-400" : "bg-sky-500/15 text-sky-400")}>
                      {g.platform}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{g.n}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoney(g.spend)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(g.leads)}</TableCell>
                  <TableCell className="text-right">
                    <span className={cn("inline-block rounded px-1.5 py-0.5 text-sm tabular-nums", cls)}>{fmtMoney(cpl)}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{fmtMoney(g.service_cpl)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(Math.round(g.appts))}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoney(g.appts ? g.spend / g.appts : null)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function statusVariant(status: string | null): "default" | "secondary" | "destructive" | "outline" {
  const s = (status ?? "").toUpperCase();
  if (s === "ACTIVE" || s === "ENABLED") return "default";
  if (s === "PAUSED") return "secondary";
  if (s === "REMOVED" || s === "DELETED" || s === "ARCHIVED") return "destructive";
  return "outline";
}

function CampaignTable({
  title,
  campaigns,
  green,
  red,
  slug,
  range,
}: {
  title: string;
  campaigns: Campaign[];
  green: number;
  red: number;
  slug: string;
  range: DateRange;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead></TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">Impr.</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead className="text-right">CTR</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">CPL</TableHead>
                <TableHead
                  className="text-right"
                  title="Booked appointments (GHL or the client's booking sheet). Bookings without an ad-set tag are split across campaigns by lead share."
                >
                  Appts
                </TableHead>
                <TableHead className="text-right">Cost/Appt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.map((c) => {
                const key = `${c.platform}-${c.campaign_id}`;
                return (
                  <Fragment key={key}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setOpen((s) => ({ ...s, [key]: !s[key] }))}
                    >
                      <TableCell>
                        <span
                          className={cn("inline-block h-2.5 w-2.5 rounded-full", SCORE_DOT[c.score ?? ""] ?? "bg-muted")}
                          title={
                            c.score
                              ? `${c.score} — CPL ${fmtMoney(c.cpl)}; target for ${c.service ?? "this client"} (${c.target_source}): ≤${fmtMoney(c.target_cpl_green)} green, ≤${fmtMoney(c.target_cpl_red)} yellow`
                              : "not enough leads to score (needs 3)"
                          }
                        />
                      </TableCell>
                      <TableCell className="max-w-72 truncate font-medium" title={c.campaign_name ?? c.campaign_id}>
                        <span className="mr-1.5 inline-flex align-middle text-muted-foreground">
                          {open[key] ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </span>
                        {c.campaign_name ?? c.campaign_id}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{c.service ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(c.campaign_status)}>
                          {(c.campaign_status ?? "unknown").toLowerCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(c.spend)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(c.impressions)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(c.clicks)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtPct(c.ctr, 2)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(c.leads)}</TableCell>
                      <TableCell className="text-right">
                        {c.service_cpl ? (
                          <span
                            className={cn("inline-block rounded px-1.5 py-0.5 text-sm tabular-nums", SCORE_CLASS[c.score ?? ""] ?? "text-muted-foreground")}
                            title={`Target (${c.target_source}): ≤${fmtMoney(c.target_cpl_green)} green · ≤${fmtMoney(c.target_cpl_red)} yellow · portfolio avg ${fmtMoney(c.service_cpl)}`}
                          >
                            {fmtMoney(c.cpl)}
                          </span>
                        ) : (
                          <CplCell cpl={c.cpl} green={green} red={red} />
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(Math.round(c.appointments))}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(c.cost_per_appt)}</TableCell>
                    </TableRow>
                    {open[key] && (
                      <AdsetRows
                        campaignId={c.campaign_id}
                        slug={slug}
                        platform={c.platform}
                        start={range.start}
                        end={range.end}
                        green={green}
                        red={red}
                      />
                    )}
                  </Fragment>
                );
              })}
              {campaigns.length === 0 && (
                <TableRow>
                  <TableCell colSpan={12} className="py-6 text-center text-muted-foreground">
                    No campaigns in this range.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ClientDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [range, setRange] = useState<DateRange>(defaultRange);

  const { data, isLoading, error } = useQuery({
    queryKey: ["client", slug, range],
    queryFn: () =>
      apiFetch<ClientDetailResponse>(
        `/api/clients/${slug}/campaigns?start=${range.start}&end=${range.end}`,
      ),
  });

  const { data: scorecard } = useQuery({
    queryKey: ["scorecard", slug],
    queryFn: () => apiFetch<Scorecard | null>(`/api/clients/${slug}/scorecard`),
  });
  const divergent = (scorecard?.divergence_ratio ?? 0) > 0.2;

  const totals = data
    ? data.campaigns.reduce(
        (acc, c) => ({
          spend: acc.spend + c.spend,
          leads: acc.leads + c.leads,
        }),
        { spend: 0, leads: 0 },
      )
    : { spend: 0, leads: 0 };
  const blendedCpl = totals.leads ? totals.spend / totals.leads : null;
  const appointments = data?.ghl?.appointments_booked ?? 0;
  const costPerAppt = appointments ? totals.spend / appointments : null;
  const leadToAppt = totals.leads ? appointments / totals.leads : null;

  const metaCampaigns = data?.campaigns.filter((c) => c.platform === "meta") ?? [];
  const googleCampaigns = data?.campaigns.filter((c) => c.platform === "google") ?? [];
  const lsaCampaigns = data?.campaigns.filter((c) => c.platform === "lsa") ?? [];

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-screen-2xl space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">
              {data?.client.name ?? slug}
            </h1>
            {divergent && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-400"
                title={`GHL booked ${scorecard?.appointments_ghl} vs Meta reported ${scorecard?.appointments_meta_reported} — fix the conversion signal before changing budgets`}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Signal off by {Math.round((scorecard?.divergence_ratio ?? 0) * 100)}%
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <AiBundleButton slug={slug} start={range.start} end={range.end} />
            <DateRangePicker value={range} onChange={setRange} />
          </div>
        </div>

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Failed to load client: {(error as Error).message}
          </p>
        )}

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {isLoading || !data ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)
          ) : (
            <>
              <KpiCard label="Spend" value={fmtMoney(totals.spend)} />
              <KpiCard label="Leads" value={fmtNum(totals.leads)} />
              <KpiCard
                label="Blended CPL"
                value={fmtMoney(blendedCpl)}
                hint={
                  costPerAppt !== null ? `${fmtMoney(costPerAppt)} per booked appt` : undefined
                }
              />
              <KpiCard
                label="GHL Appointments"
                value={fmtNum(appointments)}
                hint={leadToAppt !== null ? `${fmtPct(leadToAppt)} lead→appt` : undefined}
              />
            </>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Daily Spend & Leads</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading || !data ? <Skeleton className="h-72" /> : <TrendChart data={data.trend} />}
          </CardContent>
        </Card>

        {data && (
          <>
            <TodayPlays slug={slug} />
            <ActionsQueue slug={slug} />
            <FunnelCard slug={slug} range={range} />
            <CreativeHealth slug={slug} />
            <ServiceSummary campaigns={data.campaigns} />
            <CreativeBoard slug={slug} range={range} />
            <PeriodTable
              slug={slug}
              range={range}
              green={data.client.cpl_target_green}
              red={data.client.cpl_target_red}
            />
            <CampaignTable
              title="Meta Campaigns"
              campaigns={metaCampaigns}
              green={data.client.cpl_target_green}
              red={data.client.cpl_target_red}
              slug={slug}
              range={range}
            />
            <CampaignTable
              title="Google Ads Campaigns"
              campaigns={googleCampaigns}
              green={data.client.cpl_target_green}
              red={data.client.cpl_target_red}
              slug={slug}
              range={range}
            />
            {googleCampaigns.length > 0 && (
              <GoogleAdsPanel slug={slug} range={range} />
            )}
            {lsaCampaigns.length > 0 && (
              <CampaignTable
                title="Local Services Ads"
                campaigns={lsaCampaigns}
                green={data.client.cpl_target_green}
                red={data.client.cpl_target_red}
                slug={slug}
                range={range}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
