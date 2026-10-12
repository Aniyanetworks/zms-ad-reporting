"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Hammer, Plus, Trash2 } from "lucide-react";
import { Nav } from "@/components/nav";
import { PlatformBadge, StatusPill } from "@/components/build/status-pill";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, type Build, type BuildStatus, type Client } from "@/lib/api";
import {
  BUILD_STATUS_LABELS,
  buildDailyBudgetCents,
  buildDisplayName,
  canEditBuilds,
  fmtCents,
  isCancellable,
  statusSortRank,
} from "@/lib/build";
import { useMe } from "@/lib/me";

const STATUSES: BuildStatus[] = ["draft", "planned", "approved", "creating", "created", "failed", "cancelled"];

function NewBuildDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [clientSlug, setClientSlug] = useState("");
  const [title, setTitle] = useState("");

  const clients = useQuery({
    queryKey: ["clients"],
    queryFn: () => apiFetch<Client[]>("/api/clients"),
    enabled: open,
  });
  // Only clients with a Meta ad account can be built for (platform is fixed to Meta for now).
  const eligible = useMemo(
    () => (clients.data ?? []).filter((c) => c.meta_ad_account_id && c.is_active).sort((a, b) => a.name.localeCompare(b.name)),
    [clients.data],
  );

  const create = useMutation({
    mutationFn: () =>
      apiFetch<Build>("/api/builds", {
        method: "POST",
        body: JSON.stringify({ client_slug: clientSlug, platform: "meta", title: title.trim() || undefined }),
      }),
    onSuccess: (b) => {
      setOpen(false);
      router.push(`/build/${b.id}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" /> New build
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New campaign build</DialogTitle>
          <DialogDescription>
            Pick the client. You describe the offer, budget and geography in the workspace; the assistant drafts the
            campaign and nothing reaches Meta until it is approved.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (clientSlug) create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="build-client">Client</Label>
            <Select value={clientSlug} onValueChange={setClientSlug}>
              <SelectTrigger id="build-client" className="w-full">
                <SelectValue placeholder={clients.isLoading ? "Loading clients…" : "Choose a client"} />
              </SelectTrigger>
              <SelectContent position="popper">
                {eligible.map((c) => (
                  <SelectItem key={c.slug} value={c.slug}>
                    {c.name} <span className="text-muted-foreground">· {c.meta_ad_account_id}</span>
                  </SelectItem>
                ))}
                {!clients.isLoading && eligible.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">No active clients with a Meta ad account.</div>
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Platform</Label>
            <div className="flex h-8 items-center gap-2 rounded-lg border border-input px-2.5 text-sm dark:bg-input/30">
              <PlatformBadge platform="meta" /> Meta Ads
              <span className="ml-auto text-xs text-muted-foreground">Google coming later</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="build-title">Title (optional)</Label>
            <Input
              id="build-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Fall roofing push"
              maxLength={120}
            />
          </div>
          {create.error && (
            <p className="text-xs text-red-400" role="alert">
              {(create.error as Error).message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!clientSlug || create.isPending}>
              {create.isPending ? "Creating…" : "Create build"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function BuildListPage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const canEdit = canEditBuilds(me);
  const [status, setStatus] = useState<"all" | BuildStatus>("all");
  const [confirmCancel, setConfirmCancel] = useState<Build | null>(null);

  const builds = useQuery({
    queryKey: ["builds", status],
    queryFn: () => apiFetch<Build[]>(`/api/builds${status === "all" ? "" : `?status=${status}`}`),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/builds/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirmCancel(null);
      qc.invalidateQueries({ queryKey: ["builds"] });
    },
  });

  const rows = useMemo(
    () =>
      [...(builds.data ?? [])].sort(
        (a, b) =>
          statusSortRank(a.status) - statusSortRank(b.status) ||
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      ),
    [builds.data],
  );

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-screen-2xl space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <Hammer className="h-6 w-6 text-primary" /> Campaign Builder
            </h1>
            <p className="text-sm text-muted-foreground">
              Draft a Meta lead campaign with the assistant, review the plan, approve it — everything is created
              PAUSED in Ads Manager, following the naming SOP and the dashboard&rsquo;s UTM set.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={status} onValueChange={(v) => setStatus(v as "all" | BuildStatus)}>
              <SelectTrigger size="sm" className="min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {BUILD_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canEdit && <NewBuildDialog />}
          </div>
        </div>

        {builds.error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Failed to load builds: {(builds.error as Error).message}
          </p>
        )}

        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {builds.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {status === "all" ? "No builds yet." : `No ${BUILD_STATUS_LABELS[status].toLowerCase()} builds.`}
              {canEdit && status === "all" && " Start one with “New build”."}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Daily budget</TableHead>
                  <TableHead>Created by</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <Link href={`/clients/${b.client_slug}`} className="font-medium hover:underline">
                        {b.client_name}
                      </Link>
                      <span className="ml-2 text-xs text-muted-foreground">{b.client_slug}</span>
                    </TableCell>
                    <TableCell>
                      <Link href={`/build/${b.id}`} className="flex items-center gap-2 hover:underline">
                        <PlatformBadge platform={b.platform} />
                        <span className="max-w-[28rem] truncate">{buildDisplayName(b)}</span>
                      </Link>
                      {b.plan && b.title && b.title !== b.plan.campaign.name && (
                        <span className="ml-7 text-xs text-muted-foreground">{b.title}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusPill status={b.status} />
                      {b.plan_version > 0 && (
                        <span className="ml-2 text-[11px] text-muted-foreground">plan v{b.plan_version}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtCents(buildDailyBudgetCents(b), b.account_context?.currency ?? "USD")}
                    </TableCell>
                    <TableCell className="max-w-[14rem] truncate text-xs text-muted-foreground">
                      {b.created_by_email ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={new Date(b.updated_at).toLocaleString()}>
                      {formatDistanceToNow(new Date(b.updated_at), { addSuffix: true })}
                    </TableCell>
                    <TableCell>
                      {canEdit && isCancellable(b.status) && b.status !== "cancelled" && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          title="Cancel this build"
                          onClick={() => setConfirmCancel(b)}
                          disabled={cancel.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </main>

      <Dialog open={confirmCancel !== null} onOpenChange={(o) => !o && setConfirmCancel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this build?</DialogTitle>
            <DialogDescription>
              {confirmCancel && (
                <>
                  <span className="font-medium text-foreground">{buildDisplayName(confirmCancel)}</span> for{" "}
                  {confirmCancel.client_name} will be marked cancelled. Nothing was created in Meta, so there is nothing
                  to undo there.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {cancel.error && (
            <p className="text-xs text-red-400" role="alert">
              {(cancel.error as Error).message}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCancel(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() => confirmCancel && cancel.mutate(confirmCancel.id)}
            >
              {cancel.isPending ? "Cancelling…" : "Cancel build"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
