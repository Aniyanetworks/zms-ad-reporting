import { cplColor, fmtMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

const COLOR_CLASSES = {
  green: "bg-emerald-500/15 text-emerald-400",
  yellow: "bg-amber-500/15 text-amber-400",
  red: "bg-red-500/15 text-red-400",
  none: "text-muted-foreground",
} as const;

/** CPL cell with conditional formatting vs the client's configurable targets. */
export function CplCell({
  cpl,
  green,
  red,
}: {
  cpl: number | null;
  green: number;
  red: number;
}) {
  const color = cplColor(cpl, green, red);
  return (
    <span
      className={cn(
        "inline-block rounded px-1.5 py-0.5 text-sm tabular-nums",
        COLOR_CLASSES[color],
      )}
    >
      {fmtMoney(cpl)}
    </span>
  );
}
