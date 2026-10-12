"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TrendPoint } from "@/lib/api";

/** Daily spend (bars) + leads (line), Recharts, themed via CSS chart tokens. */
export function TrendChart({ data }: { data: TrendPoint[] }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
            tickFormatter={(d: string) => d.slice(5)}
            minTickGap={24}
          />
          <YAxis
            yAxisId="spend"
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
            tickFormatter={(v: number) => `$${v}`}
            width={56}
          />
          <YAxis
            yAxisId="leads"
            orientation="right"
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
            width={36}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              color: "var(--popover-foreground)",
            }}
            formatter={(value, name) =>
              typeof value === "number" && String(name).toLowerCase().includes("spend")
                ? [`$${value.toFixed(2)}`, name]
                : [value, name]
            }
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar
            yAxisId="spend"
            dataKey="meta_spend"
            name="Meta Spend"
            stackId="spend"
            fill="var(--chart-1)"
            radius={[0, 0, 0, 0]}
          />
          <Bar
            yAxisId="spend"
            dataKey="google_spend"
            name="Google Spend"
            stackId="spend"
            fill="var(--chart-2)"
            radius={[2, 2, 0, 0]}
          />
          <Line
            yAxisId="leads"
            type="monotone"
            dataKey="leads"
            name="Leads"
            stroke="var(--chart-3)"
            strokeWidth={2}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
