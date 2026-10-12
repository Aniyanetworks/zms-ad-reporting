"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type Platform = "all" | "meta" | "google" | "lsa";
const STORAGE_KEY = "zms.platform";

/** Remembered per browser: which ad platform the page reports on. */
export function usePlatform(): [Platform, (p: Platform) => void] {
  const [platform, setPlatform] = useState<Platform>("all");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "all" || saved === "meta" || saved === "google" || saved === "lsa") setPlatform(saved);
    } catch {}
  }, []);
  const set = (p: Platform) => {
    setPlatform(p);
    try {
      window.localStorage.setItem(STORAGE_KEY, p);
    } catch {}
  };
  return [platform, set];
}

const LABELS: Record<Platform, string> = { all: "All", meta: "Meta", google: "Google", lsa: "LSA" };
const ACTIVE: Record<Platform, string> = {
  all: "bg-accent text-foreground",
  meta: "bg-sky-500/15 text-sky-400",
  google: "bg-amber-500/15 text-amber-400",
  lsa: "bg-violet-500/15 text-violet-400",
};

/** Shared badge colors for platform chips across pages. */
export const PLATFORM_BADGE: Record<string, string> = {
  meta: "bg-sky-500/15 text-sky-400",
  google: "bg-amber-500/15 text-amber-400",
  lsa: "bg-violet-500/15 text-violet-400",
};
export const PLATFORM_NAME: Record<string, string> = { meta: "Meta", google: "Google", lsa: "LSA" };

export function PlatformSwitch({ value, onChange }: { value: Platform; onChange: (p: Platform) => void }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-md border p-0.5" title="Report on one ad platform or both">
      {(["all", "meta", "google", "lsa"] as Platform[]).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === p ? ACTIVE[p] : "text-muted-foreground hover:text-foreground",
          )}
        >
          {LABELS[p]}
        </button>
      ))}
    </div>
  );
}
