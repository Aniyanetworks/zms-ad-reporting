"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, ImageOff, MoveDownRight, MoveRight, MoveUpRight } from "lucide-react";
import type { DateRange } from "@/components/date-range-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, type Creative, type CreativeGrade } from "@/lib/api";
import { fmtMoney, fmtNum } from "@/lib/format";

const GRADES: { key: CreativeGrade | "all"; label: string; badge?: string }[] = [
  { key: "all", label: "All" },
  { key: "winner", label: "Winners" },
  { key: "ok", label: "OK" },
  { key: "underperforming", label: "Underperforming" },
  { key: "learning", label: "Learning" },
];

const GRADE_STYLES: Record<CreativeGrade, string> = {
  winner: "bg-emerald-500/15 text-emerald-500",
  ok: "bg-sky-500/15 text-sky-500",
  underperforming: "bg-red-500/15 text-red-500",
  learning: "bg-muted text-muted-foreground",
};

const GRADE_LABELS: Record<CreativeGrade, string> = {
  winner: "Winner",
  ok: "OK",
  underperforming: "Underperforming",
  learning: "Learning",
};

function TrendIcon({ trend }: { trend: Creative["trend"] }) {
  if (trend === "fatiguing")
    return (
      <span title="Fatiguing — CPL got worse in the second half of this range" className="text-red-500">
        <MoveDownRight className="h-3.5 w-3.5" />
      </span>
    );
  if (trend === "improving")
    return (
      <span title="Improving — CPL got better in the second half of this range" className="text-emerald-500">
        <MoveUpRight className="h-3.5 w-3.5" />
      </span>
    );
  if (trend === "stable")
    return (
      <span title="Stable CPL across this range" className="text-muted-foreground">
        <MoveRight className="h-3.5 w-3.5" />
      </span>
    );
  return null;
}

/** Creative performance board: every ad graded against the client's CPL
 * targets, filterable, with previews for iteration. */
export function CreativeBoard({ slug, range }: { slug: string; range: DateRange }) {
  const [filter, setFilter] = useState<CreativeGrade | "all">("all");

  const { data, isLoading } = useQuery({
    queryKey: ["creatives", slug, range],
    queryFn: () =>
      apiFetch<Creative[]>(`/api/clients/${slug}/creatives?start=${range.start}&end=${range.end}`),
  });

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data?.length ?? 0 };
    for (const ad of data ?? []) c[ad.grade] = (c[ad.grade] ?? 0) + 1;
    return c;
  }, [data]);

  const shown = useMemo(
    () => (data ?? []).filter((ad) => filter === "all" || ad.grade === filter),
    [data, filter],
  );

  if (!isLoading && (!data || data.length === 0)) return null;

  return (
    <Card>
      <CardHeader className="space-y-3">
        <CardTitle className="text-base">Creative Performance</CardTitle>
        <div className="flex flex-wrap gap-1.5">
          {GRADES.map((g) => (
            <button
              key={g.key}
              onClick={() => setFilter(g.key)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                filter === g.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {g.label}
              {counts[g.key] !== undefined && (
                <span className="ml-1 opacity-70">{counts[g.key] ?? 0}</span>
              )}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-40" />
        ) : shown.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No creatives in this bucket for the selected range.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((ad) => {
              const card = (
                <div className="flex h-full items-start gap-3 rounded-md border p-3 transition-colors hover:bg-muted/50">
                  {ad.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={ad.thumbnail_url} alt="" className="h-16 w-16 shrink-0 rounded object-cover" />
                  ) : (
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded bg-muted">
                      <ImageOff className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${GRADE_STYLES[ad.grade]}`}
                      >
                        {GRADE_LABELS[ad.grade]}
                      </span>
                      <TrendIcon trend={ad.trend} />
                      {ad.preview_link && (
                        <ExternalLink className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                    </div>
                    <p className="truncate text-sm font-medium" title={ad.ad_name ?? ad.ad_id}>
                      {ad.ad_name ?? ad.ad_id}
                    </p>
                    <p className="truncate text-xs text-muted-foreground" title={ad.campaign_name ?? ""}>
                      {ad.campaign_name}
                    </p>
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {fmtNum(ad.leads)} leads · {fmtMoney(ad.spend)} ·{" "}
                      {ad.cpl !== null ? `${fmtMoney(ad.cpl)} CPL` : "no leads yet"}
                    </p>
                  </div>
                </div>
              );
              return ad.preview_link ? (
                <a key={ad.ad_id} href={ad.preview_link} target="_blank" rel="noreferrer">
                  {card}
                </a>
              ) : (
                <div key={ad.ad_id}>{card}</div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
