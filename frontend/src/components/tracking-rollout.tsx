"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch } from "@/lib/api";
import { useMe } from "@/lib/me";
import { canAct } from "@/lib/permissions";

interface TrackingItem {
  id: number;
  client_slug: string;
  client_name: string;
  action: "fix_tracking" | "fix_utm" | "create_pixel";
  entity_name: string | null;
  status: "proposed" | "approved" | "executed" | "failed";
  reason: string;
  risk: string | null;
  ads: number;
  pixel_id: string | null;
  campaign_name: string | null;
  approved_by: string | null;
  verification: { ok?: boolean; done?: number; failed?: number; needs?: string[]; log?: { ok: boolean }[] } | null;
}

const LABEL: Record<TrackingItem["action"], string> = {
  fix_tracking: "Website + Offline events",
  fix_utm: "Standard UTM tags",
  create_pixel: "Create pixel",
};
const STATUS: Record<TrackingItem["status"], string> = {
  proposed: "bg-sky-500/15 text-sky-400",
  approved: "bg-emerald-500/15 text-emerald-400",
  executed: "bg-muted text-muted-foreground",
  failed: "bg-red-500/15 text-red-400",
};

/** Cross-client queue for the tracking rollout: approve everything in one click,
 * then execute. Each approval is recorded under the signed-in user. */
export function TrackingRollout() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const q = useQuery({
    queryKey: ["tracking-queue"],
    queryFn: () => apiFetch<TrackingItem[]>("/api/recommendations/tracking"),
    refetchInterval: (query) => ((query.state.data ?? []).some((i) => i.status === "approved") ? 5_000 : false),
  });
  const items = q.data ?? [];
  const proposed = items.filter((i) => i.status === "proposed");
  const approved = items.filter((i) => i.status === "approved");
  const refresh = () => qc.invalidateQueries({ queryKey: ["tracking-queue"] });

  const approveAll = useMutation({
    mutationFn: () => apiFetch<{ approved: number[]; denied: unknown[] }>("/api/recommendations/bulk-approve", {
      method: "POST",
      body: JSON.stringify({ ids: proposed.map((i) => i.id) }),
    }),
    onSuccess: refresh,
  });
  const executeAll = useMutation({
    mutationFn: () => apiFetch<{ queued: number[] }>("/api/recommendations/bulk-execute", {
      method: "POST",
      body: JSON.stringify({ ids: approved.map((i) => i.id) }),
    }),
    onSuccess: refresh,
  });
  const one = useMutation({
    mutationFn: ({ id, verb }: { id: number; verb: "bulk-approve" | "bulk-execute" }) =>
      apiFetch(`/api/recommendations/${verb}`, { method: "POST", body: JSON.stringify({ ids: [id] }) }),
    onSuccess: refresh,
  });

  if (!q.isLoading && items.length === 0) return null;
  const may = canAct(me?.role);
  const err = (approveAll.error ?? executeAll.error ?? one.error) as Error | undefined;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Tracking rollout</CardTitle>
          <CardDescription>
            Website + Offline events toggles, standard UTM tags and missing pixels across all clients. Approvals are
            recorded under your login; execution runs in the background and reads every ad back.
          </CardDescription>
        </div>
        {may && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!proposed.length || approveAll.isPending} onClick={() => approveAll.mutate()}>
              <Check className="h-3.5 w-3.5" /> Approve all ({proposed.length})
            </Button>
            <Button size="sm" disabled={!approved.length || executeAll.isPending} onClick={() => executeAll.mutate()}>
              <Play className="h-3.5 w-3.5" /> Execute approved ({approved.length})
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {err && <p className="px-6 pb-2 text-sm text-destructive">{err.message}</p>}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Pixel</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium">{i.client_name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{LABEL[i.action]}</Badge>
                    {i.risk && i.action === "fix_utm" && (
                      <p className="mt-1 max-w-xs text-[11px] text-amber-400">Re-review + learning phase restart</p>
                    )}
                  </TableCell>
                  <TableCell className="max-w-md text-xs text-muted-foreground">
                    {i.action === "fix_utm" ? `${i.campaign_name} › ${i.entity_name}` : i.entity_name}
                    {i.ads ? ` · ${i.ads} ad${i.ads === 1 ? "" : "s"}` : ""}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{i.pixel_id ?? "—"}</TableCell>
                  <TableCell>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS[i.status]}`}>{i.status}</span>
                    {(i.status === "executed" || i.status === "failed") && i.verification?.log && (
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        {i.verification.log.filter((l) => l.ok).length}/{i.verification.log.length} ok
                      </span>
                    )}
                    {i.status === "failed" && i.verification?.needs?.length ? (
                      <ul className="mt-1 max-w-md list-disc pl-4 text-[11px] text-amber-300">
                        {i.verification.needs.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    ) : null}
                    {i.approved_by && i.status !== "proposed" && (
                      <span className="ml-2 text-[11px] text-muted-foreground">by {i.approved_by}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {may && i.status === "proposed" && (
                      <Button size="sm" variant="ghost" onClick={() => one.mutate({ id: i.id, verb: "bulk-approve" })}>Approve</Button>
                    )}
                    {may && i.status === "approved" && (
                      <Button size="sm" variant="ghost" onClick={() => one.mutate({ id: i.id, verb: "bulk-execute" })}>Execute</Button>
                    )}
                    {may && i.status === "failed" && (
                      <Button size="sm" variant="ghost" onClick={() => one.mutate({ id: i.id, verb: "bulk-execute" })}>Retry</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
