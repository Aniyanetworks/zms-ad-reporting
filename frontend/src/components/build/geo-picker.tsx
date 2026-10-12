"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { apiFetch, type GeoTarget } from "@/lib/api";
import { cn } from "@/lib/utils";

const TYPE_LABEL: Record<GeoTarget["type"], string> = {
  city: "City",
  region: "Region",
  zip: "ZIP",
  country: "Country",
  neighborhood: "Neighborhood",
};

function geoLabel(g: GeoTarget): string {
  const parts = [g.name];
  if (g.region && g.type !== "region") parts.push(g.region);
  if (g.country_code && g.type !== "country") parts.push(g.country_code);
  return parts.join(", ");
}

/** Chip list of Meta locations with a debounced search over /api/builds/{id}/geo?q=. */
export function GeoPicker({
  buildId,
  value,
  onChange,
  disabled,
}: {
  buildId: string;
  value: GeoTarget[];
  onChange: (next: GeoTarget[]) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const search = useQuery({
    queryKey: ["build-geo", buildId, dq],
    queryFn: () => apiFetch<GeoTarget[]>(`/api/builds/${encodeURIComponent(buildId)}/geo?q=${encodeURIComponent(dq)}`),
    enabled: dq.length >= 2,
    staleTime: 5 * 60_000,
  });

  const chosen = new Set(value.map((g) => g.key));
  const results = (search.data ?? []).filter((g) => !chosen.has(g.key));

  function add(g: GeoTarget) {
    onChange([...value, g.type === "city" && g.radius_miles === undefined ? { ...g, radius_miles: 15 } : g]);
    setQ("");
    setDq("");
    setOpen(false);
  }
  function remove(key: string) {
    onChange(value.filter((g) => g.key !== key));
  }
  function setRadius(key: string, miles: number | undefined) {
    onChange(value.map((g) => (g.key === key ? { ...g, radius_miles: miles === undefined ? undefined : Math.min(50, Math.max(10, miles)) } : g)));
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-2 left-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={q}
          disabled={disabled}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search cities, regions, ZIPs…"
          className="pl-8"
          aria-label="Search locations"
        />
        {open && dq.length >= 2 && (
          <div className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg bg-popover p-1 text-sm shadow-md ring-1 ring-foreground/10">
            {search.isLoading ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">Searching…</div>
            ) : search.error ? (
              <div className="px-2 py-1.5 text-xs text-red-400">{(search.error as Error).message}</div>
            ) : results.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No locations match “{dq}”.</div>
            ) : (
              results.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(g)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                >
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{geoLabel(g)}</span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                    {TYPE_LABEL[g.type]}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((g) => (
            <li
              key={g.key}
              className={cn("flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs", disabled && "opacity-70")}
            >
              <span className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">{TYPE_LABEL[g.type]}</span>
              <span className="max-w-[14rem] truncate">{geoLabel(g)}</span>
              {g.type === "city" && (
                <label className="flex items-center gap-0.5 text-muted-foreground">
                  +
                  <input
                    type="number"
                    min={10}
                    max={50}
                    disabled={disabled}
                    value={g.radius_miles ?? ""}
                    onChange={(e) => setRadius(g.key, e.target.value === "" ? undefined : Number(e.target.value))}
                    className="w-10 rounded border border-input bg-transparent px-1 text-right text-xs tabular-nums outline-none focus:border-ring"
                    aria-label={`Radius in miles around ${g.name}`}
                  />
                  mi
                </label>
              )}
              {!disabled && (
                <button type="button" onClick={() => remove(g.key)} className="text-muted-foreground hover:text-foreground" aria-label={`Remove ${g.name}`}>
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No locations yet — the assistant can also add them from the chat.</p>
      )}
    </div>
  );
}

export { geoLabel, TYPE_LABEL as GEO_TYPE_LABEL };
