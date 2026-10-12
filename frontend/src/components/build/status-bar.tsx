"use client";

import Link from "next/link";
import { ArrowLeft, Check, Loader2, X } from "lucide-react";
import { PlatformBadge, StatusPill } from "@/components/build/status-pill";
import type { Build } from "@/lib/api";
import { BUILD_STATUS_LABELS, BUILD_STATUS_ORDER, buildDisplayName, statusIndex } from "@/lib/build";
import { cn } from "@/lib/utils";

/** draft → planned → approved → creating → created, with failed / cancelled hanging off the end. */
function Timeline({ build }: { build: Build }) {
  const idx = statusIndex(build.status);
  const terminal = build.status === "failed" || build.status === "cancelled";
  return (
    <ol className="flex items-center gap-1 text-[11px]" aria-label="Build progress">
      {BUILD_STATUS_ORDER.map((s, i) => {
        const done = idx > i || build.status === "created";
        const current = idx === i && !terminal;
        const active = build.status === "creating" && s === "creating";
        return (
          <li key={s} className="flex items-center gap-1">
            {i > 0 && <span className={cn("h-px w-4", done || current ? "bg-emerald-500/60" : "bg-border")} />}
            <span
              className={cn(
                "flex items-center gap-1 rounded-full px-1.5 py-0.5",
                current ? "bg-accent text-foreground" : done ? "text-emerald-400" : "text-muted-foreground",
              )}
              aria-current={current ? "step" : undefined}
            >
              {active ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : done ? (
                <Check className="h-3 w-3" />
              ) : (
                <span className={cn("inline-block h-1.5 w-1.5 rounded-full", current ? "bg-foreground" : "bg-border")} />
              )}
              {BUILD_STATUS_LABELS[s]}
            </span>
          </li>
        );
      })}
      {terminal && (
        <li className="flex items-center gap-1">
          <span className="h-px w-4 bg-red-500/60" />
          <span className="flex items-center gap-1 rounded-full bg-red-500/15 px-1.5 py-0.5 text-red-400">
            <X className="h-3 w-3" /> {BUILD_STATUS_LABELS[build.status]}
          </span>
        </li>
      )}
    </ol>
  );
}

export function StatusBar({ build }: { build: Build }) {
  return (
    <div className="border-b bg-sidebar/60 px-3 py-2 sm:px-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link href="/build" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Builds
        </Link>
        <div className="flex min-w-0 items-center gap-2">
          <Link href={`/clients/${build.client_slug}`} className="truncate font-medium hover:underline">
            {build.client_name}
          </Link>
          <span className="text-xs text-muted-foreground">{build.client_slug}</span>
          <PlatformBadge platform={build.platform} />
        </div>
        <span className="min-w-0 truncate text-sm text-muted-foreground" title={buildDisplayName(build)}>
          {buildDisplayName(build)}
        </span>
        <StatusPill status={build.status} />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <Timeline build={build} />
          {build.approved_by_email && (
            <span className="text-[11px] text-muted-foreground">
              approved by {build.approved_by_email}
              {build.approved_at && ` · ${new Date(build.approved_at).toLocaleString()}`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
