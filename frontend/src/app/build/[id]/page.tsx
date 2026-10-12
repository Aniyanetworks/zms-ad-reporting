"use client";

import { use } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Nav } from "@/components/nav";
import { BriefPanel } from "@/components/build/brief-panel";
import { ChatPanel } from "@/components/build/chat-panel";
import { PlanPanel } from "@/components/build/plan-panel";
import { StatusBar } from "@/components/build/status-bar";
import { useBuild } from "@/components/build/use-build";
import { Skeleton } from "@/components/ui/skeleton";
import { canEditBuilds, isEditable } from "@/lib/build";
import { useMe } from "@/lib/me";

export default function BuildWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: me } = useMe();
  const build = useBuild(id);
  const b = build.data;
  // Viewers see everything read-only; editors lose edit rights once creation starts.
  const canEdit = canEditBuilds(me) && !!b && isEditable(b.status);

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <Nav />
      {build.error ? (
        <main className="mx-auto w-full max-w-screen-2xl space-y-4 p-4 sm:p-6">
          <Link href="/build" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> All builds
          </Link>
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Failed to load build: {(build.error as Error).message}
          </p>
        </main>
      ) : !b ? (
        <main className="mx-auto w-full max-w-screen-2xl space-y-4 p-4 sm:p-6">
          <Skeleton className="h-12" />
          <div className="grid gap-4 lg:grid-cols-3">
            <Skeleton className="h-96" />
            <Skeleton className="h-96" />
            <Skeleton className="h-96" />
          </div>
        </main>
      ) : (
        <>
          <StatusBar build={b} />
          <main className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[minmax(300px,0.9fr)_minmax(0,1.3fr)_minmax(340px,1.1fr)] lg:overflow-hidden">
            <section className="min-h-0 rounded-xl bg-card ring-1 ring-foreground/10 lg:overflow-y-auto">
              <BriefPanel build={b} canEdit={canEdit} />
            </section>
            <section className="flex min-h-[32rem] flex-col rounded-xl bg-card ring-1 ring-foreground/10 lg:min-h-0">
              <ChatPanel build={b} canEdit={canEdit} />
            </section>
            <section className="relative min-h-0 rounded-xl bg-card ring-1 ring-foreground/10 lg:overflow-y-auto">
              <PlanPanel build={b} me={me} canEdit={canEdit} />
            </section>
          </main>
        </>
      )}
    </div>
  );
}
