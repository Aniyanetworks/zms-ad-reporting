"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Play, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, type Recommendation } from "@/lib/api";
import { useMe } from "@/lib/me";
import { canAct, canApprove, requiresOwner } from "@/lib/permissions";

const ACTION_LABELS: Record<Recommendation["action"], string> = {
  budget_change: "Budget change",
  pause: "Pause",
  activate: "Activate (human, in Ads Manager)",
  refresh_creative: "Refresh creative",
  fix_signal: "Fix tracking signal",
  investigate: "Investigate",
  fix_utm: "Add standard UTM tags",
  create_pixel: "Create Meta pixel",
  fix_tracking: "Turn on Website + Offline events",
};

/** Actions the dashboard can perform itself once approved (everything else runs via the plugin's /execute). */
const EXECUTABLE = new Set<Recommendation["action"]>(["fix_utm", "create_pixel", "fix_tracking"]);

const STATUS_STYLES: Record<Recommendation["status"], string> = {
  proposed: "bg-sky-500/15 text-sky-400",
  approved: "bg-emerald-500/15 text-emerald-400",
  executed: "bg-muted text-muted-foreground",
  dismissed: "bg-muted text-muted-foreground",
  failed: "bg-red-500/15 text-red-400",
};

/** The plugin's proposal queue for one client. Approving here is what makes a
 * recommendation eligible for the plugin's /execute. */
export function ActionsQueue({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const role = me?.role;
  // Per-recommendation error text (403 from policy, network, etc.) shown inline.
  const [errors, setErrors] = useState<Record<number, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["recommendations", slug],
    queryFn: () => apiFetch<Recommendation[]>(`/api/clients/${slug}/recommendations?status=open`),
  });

  const act = useMutation({
    mutationFn: ({ id, verb }: { id: number; verb: "approve" | "dismiss" | "execute" }) =>
      apiFetch(`/api/clients/${slug}/recommendations/${id}/${verb}`, { method: "POST" }),
    onMutate: ({ id }) =>
      setErrors((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recommendations", slug] }),
    onError: (err, { id }) =>
      setErrors((prev) => ({ ...prev, [id]: (err as Error).message.replace(/^\d{3}:\s*/, "") })),
  });

  if (!isLoading && (!data || data.length === 0)) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Actions
          {data && <span className="ml-2 text-sm font-normal text-muted-foreground">{data.length} open</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading || !data ? (
          <Skeleton className="h-24" />
        ) : (
          data.map((r) => (
            <div key={r.id} className="flex flex-wrap items-start gap-3 rounded-md border p-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[r.status]}`}>
                    {r.status}
                  </span>
                  <Badge variant="outline">{ACTION_LABELS[r.action]}</Badge>
                  <span className="text-sm font-medium">{r.entity_name ?? r.entity_type}</span>
                  {r.entity_id && (
                    <span className="text-xs text-muted-foreground">{r.entity_type} · {r.entity_id}</span>
                  )}
                </div>
                <p className="text-sm">{r.reason}</p>
                {(r.current_value || r.proposed_value) && (
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {r.current_value ?? "—"} → <span className="font-medium text-foreground">{r.proposed_value ?? "—"}</span>
                    {r.pct_change !== null && ` (${r.pct_change > 0 ? "+" : ""}${r.pct_change}%)`}
                    {r.rollback_value && ` · rollback: ${r.rollback_value}`}
                  </p>
                )}
                {r.risk && <p className="text-xs text-muted-foreground">Risk: {r.risk}</p>}
                <p className="text-[11px] text-muted-foreground">
                  Proposed {new Date(r.created_at).toLocaleDateString()}
                  {r.window_start && ` · window ${r.window_start} → ${r.window_end}`}
                  {r.approved_by && ` · approved by ${r.approved_by}`}
                </p>
              </div>
              {r.status === "proposed" && canAct(role) && (() => {
                const allowed = canApprove(role, r);
                const ownerOnly = !allowed && requiresOwner(r);
                const busy = act.isPending && act.variables?.id === r.id;
                return (
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex gap-2" title={ownerOnly ? "Owner approval required" : undefined}>
                      <Button
                        size="sm"
                        onClick={() => act.mutate({ id: r.id, verb: "approve" })}
                        disabled={!allowed || act.isPending}
                      >
                        <Check className="h-4 w-4" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => act.mutate({ id: r.id, verb: "dismiss" })}
                        disabled={!allowed || act.isPending}
                      >
                        <X className="h-4 w-4" /> Dismiss
                      </Button>
                    </div>
                    {ownerOnly && (
                      <span className="text-[11px] text-amber-400">Owner approval required</span>
                    )}
                    {busy && <span className="text-[11px] text-muted-foreground">Saving…</span>}
                    {errors[r.id] && (
                      <span className="max-w-xs text-right text-[11px] text-red-400" role="alert">
                        {errors[r.id]}
                      </span>
                    )}
                  </div>
                );
              })()}
              {r.status === "approved" && EXECUTABLE.has(r.action) && canAct(me?.role) && (
                <Button size="sm" onClick={() => act.mutate({ id: r.id, verb: "execute" })} disabled={act.isPending}>
                  <Play className="h-4 w-4" /> Execute
                </Button>
              )}
              {r.status === "approved" && !EXECUTABLE.has(r.action) && (
                <span className="self-center text-xs text-muted-foreground">
                  Awaiting <code>/execute {r.id}</code>
                </span>
              )}
              {r.status === "executed" && r.verification && (
                <span className="self-center text-xs text-emerald-400">Done · {(r.verification as { log?: unknown[] }).log?.length ?? 0} step(s)</span>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
