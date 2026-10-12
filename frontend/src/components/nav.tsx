"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Activity, BarChart3, ClipboardList, Hammer, LayoutGrid, ListChecks, LogOut, Settings, Trophy, Wrench } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/me";
import { canEditBuilds } from "@/lib/build";
import { canManage, ROLE_LABELS } from "@/lib/permissions";
import { cn } from "@/lib/utils";

const IS_STAGING = process.env.NEXT_PUBLIC_ENVIRONMENT === "staging";

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: me } = useMe();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const links = [
    { href: "/today", label: "Today", icon: ListChecks },
    { href: "/", label: "Overview", icon: BarChart3 },
    { href: "/brief", label: "Daily Brief", icon: ClipboardList },
    { href: "/portfolio", label: "Portfolio", icon: LayoutGrid },
    { href: "/services", label: "Services", icon: Wrench },
    { href: "/leaderboard", label: "Setters", icon: Trophy },
    { href: "/integrations", label: "Integrations", icon: Activity },
    // Campaign Builder: admin + media_buyer create builds; viewers can still open
    // an existing /build/{id} read-only if they land on it.
    ...(canEditBuilds(me) ? [{ href: "/build", label: "Build", icon: Hammer }] : []),
    // Settings (client registry, sync triggers) is admin-only; the API enforces it too.
    ...(canManage(me?.role) ? [{ href: "/settings", label: "Settings", icon: Settings }] : []),
  ];

  return (
    <header className="sticky top-0 z-40 border-b bg-sidebar/95 backdrop-blur">
      {IS_STAGING && (
        <div className="bg-amber-500 px-4 py-0.5 text-center text-[11px] font-semibold uppercase tracking-wider text-black">
          Staging — not production data
        </div>
      )}
      <div className="mx-auto flex h-14 max-w-screen-2xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <BarChart3 className="h-5 w-5 text-primary" />
          <span>ZMS Ads Intelligence</span>
        </Link>
        <nav className="flex flex-1 items-center gap-1">
          {links.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
                (href === "/" ? pathname === "/" : pathname.startsWith(href)) &&
                  "bg-accent text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>
        {me && me.id && (
          <Link
            href="/account"
            title="Account: password & two-factor"
            className={cn(
              "hidden items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground sm:flex",
              pathname.startsWith("/account") && "bg-accent text-foreground",
            )}
          >
            {me.email && <span className="max-w-[16rem] truncate">{me.email}</span>}
            <span className="rounded-full border px-2 py-0.5 text-[11px] font-medium text-foreground">
              {ROLE_LABELS[me.role] ?? me.role}
            </span>
          </Link>
        )}
        {me && !me.id ? (
          <Link href="/login" className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
            Sign in
          </Link>
        ) : (
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        )}
      </div>
    </header>
  );
}
