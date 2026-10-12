"use client";

/** Tiny inline spend trend — direction at a glance, no axes. */
export function Sparkline({ points, className }: { points: number[]; className?: string }) {
  if (!points || points.length < 2) return <span className="text-xs text-muted-foreground">—</span>;
  const w = 96;
  const h = 28;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const coords = points
    .map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`)
    .join(" ");
  const rising = points[points.length - 1] >= points[0];
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={className}
      aria-hidden="true"
    >
      <polyline
        points={coords}
        fill="none"
        stroke={rising ? "var(--color-emerald-500, #10b981)" : "var(--color-muted-foreground, #888)"}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.9"
      />
    </svg>
  );
}
