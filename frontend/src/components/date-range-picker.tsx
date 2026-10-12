"use client";

import {
  endOfMonth,
  format,
  startOfMonth,
  subDays,
  subMonths,
} from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface DateRange {
  start: string; // YYYY-MM-DD
  end: string;
}

const fmt = (d: Date) => format(d, "yyyy-MM-dd");

export const PRESETS: { key: string; label: string; range: () => DateRange }[] = [
  {
    key: "7d",
    label: "Last 7d",
    range: () => ({ start: fmt(subDays(new Date(), 7)), end: fmt(new Date()) }),
  },
  {
    key: "30d",
    label: "Last 30d",
    range: () => ({ start: fmt(subDays(new Date(), 30)), end: fmt(new Date()) }),
  },
  {
    key: "90d",
    label: "Last 90d",
    range: () => ({ start: fmt(subDays(new Date(), 90)), end: fmt(new Date()) }),
  },
  {
    key: "mtd",
    label: "MTD",
    range: () => ({ start: fmt(startOfMonth(new Date())), end: fmt(new Date()) }),
  },
  {
    key: "lastmonth",
    label: "Last month",
    range: () => {
      const lastMonth = subMonths(new Date(), 1);
      return { start: fmt(startOfMonth(lastMonth)), end: fmt(endOfMonth(lastMonth)) };
    },
  },
];

export function defaultRange(): DateRange {
  return PRESETS[1].range(); // last 30d
}

export function DateRangePicker({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((preset) => {
        const range = preset.range();
        const active = range.start === value.start && range.end === value.end;
        return (
          <Button
            key={preset.key}
            variant={active ? "default" : "outline"}
            size="sm"
            className={cn(!active && "text-muted-foreground")}
            onClick={() => onChange(range)}
          >
            {preset.label}
          </Button>
        );
      })}
      <div className="flex items-center gap-1.5">
        <Input
          type="date"
          className="h-8 w-36"
          value={value.start}
          onChange={(e) => e.target.value && onChange({ ...value, start: e.target.value })}
        />
        <span className="text-sm text-muted-foreground">to</span>
        <Input
          type="date"
          className="h-8 w-36"
          value={value.end}
          onChange={(e) => e.target.value && onChange({ ...value, end: e.target.value })}
        />
      </div>
    </div>
  );
}
