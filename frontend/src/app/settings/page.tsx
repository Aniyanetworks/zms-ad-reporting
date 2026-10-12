"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Pencil, Plus, RefreshCw } from "lucide-react";
import { Nav } from "@/components/nav";
import { ClientFormDialog, type ClientFormValues } from "@/components/client-form";
import { ServiceTargetsCard } from "@/components/service-targets-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch, type Client, type SyncStatusResponse } from "@/lib/api";
import { useMe } from "@/lib/me";
import { canManage } from "@/lib/permissions";

function statusBadge(status: string) {
  if (status === "success") return <Badge className="bg-emerald-500/15 text-emerald-400">success</Badge>;
  if (status === "error") return <Badge variant="destructive">error</Badge>;
  if (status === "partial") return <Badge className="bg-amber-500/15 text-amber-400">partial</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}

function ago(ts: string | null): string {
  if (!ts) return "—";
  return formatDistanceToNow(new Date(ts), { addSuffix: true });
}

export default function SettingsPage() {
  const meQuery = useMe();
  const isAdmin = canManage(meQuery.data?.role);

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-screen-2xl space-y-6 p-4 sm:p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        {meQuery.isLoading ? (
          <Skeleton className="h-40" />
        ) : isAdmin ? (
          <AdminSettings />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Admin only</CardTitle>
              <CardDescription>
                The client registry and sync controls are limited to the Agency Owner.
                {meQuery.data?.role && (
                  <>
                    {" "}
                    You are signed in as <span className="font-medium text-foreground">{meQuery.data.role}</span>.
                  </>
                )}
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </main>
    </div>
  );
}

/** The forms + sync panel. Only mounted for admins (the API enforces the same rule). */
function AdminSettings() {
  const queryClient = useQueryClient();
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);

  const clientsQuery = useQuery({
    queryKey: ["clients"],
    queryFn: () => apiFetch<Client[]>("/api/clients"),
  });

  const syncQuery = useQuery({
    queryKey: ["sync-status"],
    queryFn: () => apiFetch<SyncStatusResponse>("/api/sync/status"),
    refetchInterval: 30_000,
  });

  const createClient = useMutation({
    mutationFn: (values: ClientFormValues) =>
      apiFetch<Client>("/api/clients", { method: "POST", body: JSON.stringify(values) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });

  const updateClient = useMutation({
    mutationFn: ({ id, values }: { id: string; values: Partial<ClientFormValues> }) =>
      apiFetch<Client>(`/api/clients/${id}`, { method: "PATCH", body: JSON.stringify(values) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });

  const triggerSync = useMutation({
    mutationFn: (source: "meta" | "google" | "ghl" | "setters") =>
      apiFetch<{ task_id: string }>("/api/sync/trigger", {
        method: "POST",
        body: JSON.stringify({ source }),
      }),
    onSuccess: (data, source) => {
      setTriggerMsg(`${source} sync queued (task ${data.task_id.slice(0, 8)}…)`);
      setTimeout(() => syncQuery.refetch(), 3_000);
    },
    onError: (err) => setTriggerMsg(`Trigger failed: ${(err as Error).message}`),
  });

  const errorRuns = syncQuery.data?.latest_runs.filter((r) => r.status === "error") ?? [];

  return (
    <>
        {/* --- Sync status panel --- */}
        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Sync Status</CardTitle>
              <CardDescription>
                Daily syncs run at 6:00 (Meta), 6:15 (Google), 6:30 (GHL) AM PT.
              </CardDescription>
            </div>
            <div className="flex gap-2">
              {(["meta", "google", "ghl", "setters"] as const).map((source) => (
                <Button
                  key={source}
                  size="sm"
                  variant="outline"
                  disabled={triggerSync.isPending}
                  onClick={() => triggerSync.mutate(source)}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Sync {source}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {triggerMsg && <p className="text-sm text-muted-foreground">{triggerMsg}</p>}
            <div className="grid gap-3 sm:grid-cols-3">
              {(syncQuery.data?.last_per_source ?? []).map((s) => (
                <div key={s.source} className="rounded-md border p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium capitalize">{s.source}</span>
                    {statusBadge(s.status)}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    last run {ago(s.started_at)}
                  </p>
                </div>
              ))}
              {syncQuery.data && syncQuery.data.last_per_source.length === 0 && (
                <p className="text-sm text-muted-foreground sm:col-span-3">
                  No syncs have run yet.
                </p>
              )}
              {syncQuery.isLoading &&
                Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
            </div>

            {errorRuns.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-destructive">
                  Recent failures ({errorRuns.length})
                </p>
                <div className="overflow-x-auto rounded-md border border-destructive/30">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Source</TableHead>
                        <TableHead>Client</TableHead>
                        <TableHead>When</TableHead>
                        <TableHead>Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {errorRuns.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="capitalize">{r.source}</TableCell>
                          <TableCell>{r.client_name ?? "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">{ago(r.started_at)}</TableCell>
                          <TableCell className="max-w-xl truncate text-xs text-muted-foreground" title={r.error ?? ""}>
                            {r.error}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* --- Client registry --- */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Client Registry</CardTitle>
              <CardDescription>Map ad account IDs and GHL location IDs per client.</CardDescription>
            </div>
            <ClientFormDialog
              trigger={
                <Button size="sm">
                  <Plus className="h-4 w-4" />
                  Add client
                </Button>
              }
              onSubmit={async (values) => {
                await createClient.mutateAsync(values);
              }}
            />
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Slug</TableHead>
                    <TableHead>Meta Account</TableHead>
                    <TableHead>Google Customer</TableHead>
                    <TableHead>GHL Location</TableHead>
                    <TableHead className="text-right">CPL Targets</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clientsQuery.isLoading &&
                    Array.from({ length: 4 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell colSpan={8}>
                          <Skeleton className="h-6" />
                        </TableCell>
                      </TableRow>
                    ))}
                  {(clientsQuery.data ?? []).map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="text-muted-foreground">{c.slug}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {c.meta_ad_account_id ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {c.google_ads_customer_id ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {c.ghl_location_id ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        &lt;${c.cpl_target_green} / &gt;${c.cpl_target_red}
                      </TableCell>
                      <TableCell>
                        {c.is_active ? (
                          <Badge className="bg-emerald-500/15 text-emerald-400">active</Badge>
                        ) : (
                          <Badge variant="secondary">inactive</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <ClientFormDialog
                          client={c}
                          trigger={
                            <Button size="sm" variant="ghost">
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          }
                          onSubmit={async (values) => {
                            const { slug: _slug, ...rest } = values;
                            await updateClient.mutateAsync({ id: c.id, values: rest });
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {clientsQuery.data && clientsQuery.data.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                        No clients yet. Add your first client to start syncing.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
        <ServiceTargetsCard />
    </>
  );
}
