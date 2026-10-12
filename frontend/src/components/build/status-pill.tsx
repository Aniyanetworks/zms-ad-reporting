import type { BuildStatus } from "@/lib/api";
import { BUILD_STATUS_LABELS, BUILD_STATUS_STYLES } from "@/lib/build";
import { cn } from "@/lib/utils";

export function StatusPill({ status, className }: { status: BuildStatus; className?: string }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", BUILD_STATUS_STYLES[status], className)}>
      {BUILD_STATUS_LABELS[status]}
    </span>
  );
}

export function PlatformBadge({ platform }: { platform: "meta" | "google" }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
        platform === "google" ? "bg-amber-500/15 text-amber-400" : "bg-sky-500/15 text-sky-400",
      )}
    >
      {platform}
    </span>
  );
}
