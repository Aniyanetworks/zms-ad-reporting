"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "zms.hideNoSpend";

/** Remembered per browser: whether tables hide clients with $0 spend in range. */
export function useHideNoSpend(defaultValue = true): [boolean, (v: boolean) => void] {
  const [hide, setHide] = useState(defaultValue);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved !== null) setHide(saved === "1");
    } catch {}
  }, []);
  const set = (v: boolean) => {
    setHide(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {}
  };
  return [hide, set];
}

export function SpendFilter({
  hide,
  onChange,
  hiddenCount,
}: {
  hide: boolean;
  onChange: (v: boolean) => void;
  hiddenCount: number;
}) {
  const opt = (value: boolean, label: string) => (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        hide === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="inline-flex items-center gap-1 rounded-md border p-0.5" title="Clients with $0 spend in the selected range">
      {opt(true, hiddenCount > 0 ? `Spending only (${hiddenCount} hidden)` : "Spending only")}
      {opt(false, "All clients")}
    </div>
  );
}
