"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { CplCell } from "@/components/cpl-cell";
import { TableCell, TableRow } from "@/components/ui/table";
import { apiFetch, type AdRow, type AdsetRow } from "@/lib/api";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/format";

interface DrillProps {
  slug: string;
  platform: string;
  start: string;
  end: string;
  green: number;
  red: number;
}

function MetricCells({
  row,
  green,
  red,
}: {
  row: {
    spend: number;
    impressions: number;
    clicks: number;
    ctr: number | null;
    leads: number;
    cpl: number | null;
    ghl_appointments?: number;
    cost_per_appt?: number | null;
  };
  green: number;
  red: number;
}) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{fmtMoney(row.spend)}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtNum(row.impressions)}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtNum(row.clicks)}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtPct(row.ctr, 2)}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtNum(row.leads)}</TableCell>
      <TableCell className="text-right">
        <CplCell cpl={row.cpl} green={green} red={red} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {row.ghl_appointments !== undefined ? fmtNum(row.ghl_appointments) : ""}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {row.cost_per_appt !== undefined ? fmtMoney(row.cost_per_appt) : ""}
      </TableCell>
    </>
  );
}

function LoadingRow({ indent, label }: { indent: string; label: string }) {
  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30">
      <TableCell colSpan={10} className={`${indent} py-2 text-sm text-muted-foreground`}>
        <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" />
        Loading {label}…
      </TableCell>
    </TableRow>
  );
}

function EmptyRow({ indent, label }: { indent: string; label: string }) {
  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30">
      <TableCell colSpan={10} className={`${indent} py-2 text-sm text-muted-foreground`}>
        No {label} in this range.
      </TableCell>
    </TableRow>
  );
}

/** Ads inside one ad set — third level of the drill-down. */
export function AdRows({ adsetId, slug, platform, start, end, green, red }: DrillProps & { adsetId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["ads", slug, platform, adsetId, start, end],
    queryFn: () =>
      apiFetch<AdRow[]>(
        `/api/clients/${slug}/adsets/${adsetId}/ads?start=${start}&end=${end}&platform=${platform}`,
      ),
  });

  if (isLoading) return <LoadingRow indent="pl-20" label="ads" />;
  if (!data?.length) return <EmptyRow indent="pl-20" label="ads" />;
  return (
    <>
      {data.map((ad) => (
        <TableRow key={ad.ad_id} className="bg-muted/30 hover:bg-muted/40">
          <TableCell className="max-w-72 truncate pl-20 text-sm" title={ad.ad_name ?? ad.ad_id}>
            {ad.preview_link ? (
              <a
                href={ad.preview_link}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {ad.ad_name ?? ad.ad_id}
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
              </a>
            ) : (
              ad.ad_name ?? ad.ad_id
            )}
          </TableCell>
          <TableCell />
          <MetricCells row={ad} green={green} red={red} />
        </TableRow>
      ))}
    </>
  );
}

/** Ad sets inside one campaign — second level, each expandable into ads. */
export function AdsetRows({ campaignId, slug, platform, start, end, green, red }: DrillProps & { campaignId: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { data, isLoading } = useQuery({
    queryKey: ["adsets", slug, platform, campaignId, start, end],
    queryFn: () =>
      apiFetch<AdsetRow[]>(
        `/api/clients/${slug}/campaigns/${campaignId}/adsets?start=${start}&end=${end}&platform=${platform}`,
      ),
  });

  if (isLoading) return <LoadingRow indent="pl-12" label="ad sets" />;
  if (!data?.length) return <EmptyRow indent="pl-12" label="ad sets" />;
  return (
    <>
      {data.map((adset) => (
        <Fragment key={adset.adset_id}>
          <TableRow
            className="cursor-pointer bg-muted/20 hover:bg-muted/40"
            onClick={() => setOpen((s) => ({ ...s, [adset.adset_id]: !s[adset.adset_id] }))}
          >
            <TableCell className="max-w-72 truncate pl-12 text-sm font-medium" title={adset.adset_name ?? adset.adset_id}>
              <span className="mr-1.5 inline-flex align-middle text-muted-foreground">
                {open[adset.adset_id] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </span>
              {adset.adset_name ?? adset.adset_id}
            </TableCell>
            <TableCell />
            <MetricCells row={adset} green={green} red={red} />
          </TableRow>
          {open[adset.adset_id] && (
            <AdRows
              adsetId={adset.adset_id}
              slug={slug}
              platform={platform}
              start={start}
              end={end}
              green={green}
              red={red}
            />
          )}
        </Fragment>
      ))}
    </>
  );
}
