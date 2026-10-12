"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CloudOff, Loader2, X } from "lucide-react";
import { CreativesDropzone } from "@/components/build/creatives-dropzone";
import { GeoPicker } from "@/components/build/geo-picker";
import { useSetBuild } from "@/components/build/use-build";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, type Brief, type Build } from "@/lib/api";
import { dollarsToCents } from "@/lib/build";
import { cn } from "@/lib/utils";

const AUDIENCE_PRESETS = ["Broad", "Retargeting 30d", "Lookalike 1%", "Homeowners 35+"];
const DEBOUNCE_MS = 700;

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/** The media buyer's inputs. Edits overlay the server brief and are PATCHed
 * (merged server-side) after a short pause; the overlay is cleared once the
 * server echoes each value back. */
export function BriefPanel({ build, canEdit }: { build: Build; canEdit: boolean }) {
  const setBuild = useSetBuild(build.id);
  const [pending, setPending] = useState<Partial<Brief>>({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const pendingRef = useRef<Partial<Brief>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);

  const brief: Brief = { ...build.brief, ...pending };
  const ctx = build.account_context;
  const forms = ctx?.lead_forms ?? [];
  const formKnown = !!brief.lead_form_id && forms.some((f) => f.id === brief.lead_form_id);
  const [pasteForm, setPasteForm] = useState(false);
  const showPaste = pasteForm || (!!brief.lead_form_id && !formKnown) || forms.length === 0;

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  async function flush() {
    if (inFlightRef.current) {
      schedule();
      return;
    }
    const patch = pendingRef.current;
    if (Object.keys(patch).length === 0) return;
    inFlightRef.current = true;
    setSaveState("saving");
    try {
      const next = await apiFetch<Build>(`/api/builds/${encodeURIComponent(build.id)}/brief`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setBuild(next);
      // Drop overlay keys the server now agrees with; keep anything typed meanwhile.
      const remaining: Partial<Brief> = {};
      for (const [k, v] of Object.entries(pendingRef.current) as [keyof Brief, unknown][]) {
        if (JSON.stringify(v) !== JSON.stringify(next.brief[k])) (remaining as Record<string, unknown>)[k] = v;
      }
      pendingRef.current = remaining;
      setPending(remaining);
      setSaveError(null);
      if (Object.keys(remaining).length > 0) {
        setSaveState("dirty");
        schedule();
      } else {
        setSaveState("saved");
      }
    } catch (err) {
      setSaveError((err as Error).message);
      setSaveState("error");
    } finally {
      inFlightRef.current = false;
    }
  }

  function schedule() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, DEBOUNCE_MS);
  }

  function update(patch: Partial<Brief>) {
    if (!canEdit) return;
    pendingRef.current = { ...pendingRef.current, ...patch };
    setPending(pendingRef.current);
    setSaveState("dirty");
    schedule();
  }

  const disabled = !canEdit;

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-card/95 px-4 py-2.5 backdrop-blur">
        <h2 className="text-sm font-semibold">Brief</h2>
        <SaveIndicator state={saveState} error={saveError} readOnly={disabled} />
      </div>

      <div className="space-y-4 p-4">
        <Field label="Service" htmlFor="brief-service">
          <Input
            id="brief-service"
            disabled={disabled}
            value={brief.service ?? ""}
            onChange={(e) => update({ service: e.target.value })}
            placeholder="e.g. Roof replacement"
          />
        </Field>

        <Field label="Offer" htmlFor="brief-offer">
          <Textarea
            id="brief-offer"
            disabled={disabled}
            value={brief.offer ?? ""}
            onChange={(e) => update({ offer: e.target.value })}
            placeholder="What the ad promises — e.g. Free inspection + $500 off a full replacement this month"
            rows={3}
          />
        </Field>

        <Field label="Destination">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-[3px] text-sm">
            {(["instant_form", "website"] as const).map((d) => (
              <button
                key={d}
                type="button"
                disabled={disabled}
                onClick={() => update({ destination: d })}
                className={cn(
                  "rounded-md px-2 py-1 transition-colors disabled:opacity-60",
                  (brief.destination ?? "instant_form") === d ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={(brief.destination ?? "instant_form") === d}
              >
                {d === "instant_form" ? "Instant Form" : "Website"}
              </button>
            ))}
          </div>
          {(brief.destination ?? "instant_form") === "instant_form" ? (
            <div className="mt-2 space-y-1.5">
              {!showPaste ? (
                <Select
                  value={formKnown ? brief.lead_form_id : ""}
                  onValueChange={(v) => update({ lead_form_id: v })}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={forms.length ? "Choose a lead form" : "No lead forms found on the page"} />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {forms.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name ?? f.id}
                        <span className="text-muted-foreground">
                          {" "}
                          · {f.id}
                          {f.seen_in_ads > 0 && ` · in ${f.seen_in_ads} ad${f.seen_in_ads === 1 ? "" : "s"}`}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  disabled={disabled}
                  value={brief.lead_form_id ?? ""}
                  onChange={(e) => update({ lead_form_id: e.target.value.trim() })}
                  placeholder="Paste a Meta lead form ID"
                  className="font-mono"
                />
              )}
              {forms.length > 0 && (
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setPasteForm((v) => !v)}
                >
                  {showPaste ? "Choose from the page's forms" : "Paste a form ID instead"}
                </button>
              )}
            </div>
          ) : (
            <Input
              className="mt-2"
              type="url"
              disabled={disabled}
              value={brief.landing_page_url ?? ""}
              onChange={(e) => update({ landing_page_url: e.target.value })}
              placeholder="https://client-site.com/offer"
            />
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Daily budget" htmlFor="brief-budget">
            <div className="relative">
              <span className="pointer-events-none absolute top-1.5 left-2.5 text-sm text-muted-foreground">$</span>
              <Input
                id="brief-budget"
                type="number"
                min={1}
                step={1}
                inputMode="decimal"
                disabled={disabled}
                className="pl-6 tabular-nums"
                value={brief.daily_budget_cents !== undefined ? brief.daily_budget_cents / 100 : ""}
                onChange={(e) => update({ daily_budget_cents: dollarsToCents(e.target.value) })}
                placeholder="50"
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              per day{ctx?.currency && ctx.currency !== "USD" ? ` · account bills in ${ctx.currency}` : ""}
            </p>
          </Field>
          <Field label="Launch date" htmlFor="brief-launch">
            <Input
              id="brief-launch"
              type="date"
              disabled={disabled}
              value={brief.launch_date ?? ""}
              onChange={(e) => update({ launch_date: e.target.value || undefined })}
            />
          </Field>
        </div>

        <Field label="Locations">
          <GeoPicker buildId={build.id} value={brief.geo ?? []} onChange={(geo) => update({ geo })} disabled={disabled} />
        </Field>

        <Field label="Age range">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={18}
              max={65}
              disabled={disabled}
              className="w-20 tabular-nums"
              value={brief.age_min ?? ""}
              onChange={(e) => update({ age_min: e.target.value === "" ? undefined : Number(e.target.value) })}
              placeholder="25"
              aria-label="Minimum age"
            />
            <span className="text-muted-foreground">to</span>
            <Input
              type="number"
              min={18}
              max={65}
              disabled={disabled}
              className="w-20 tabular-nums"
              value={brief.age_max ?? ""}
              onChange={(e) => update({ age_max: e.target.value === "" ? undefined : Number(e.target.value) })}
              placeholder="65"
              aria-label="Maximum age"
            />
            <span className="text-[11px] text-muted-foreground">65 = 65+</span>
          </div>
        </Field>

        <Field label="Audiences">
          <ChipInput
            value={brief.audiences ?? []}
            onChange={(audiences) => update({ audiences })}
            presets={AUDIENCE_PRESETS}
            disabled={disabled}
            placeholder="Add an audience and press Enter"
          />
        </Field>

        <Field label="Notes for the assistant" htmlFor="brief-notes">
          <Textarea
            id="brief-notes"
            disabled={disabled}
            value={brief.notes ?? ""}
            onChange={(e) => update({ notes: e.target.value })}
            placeholder="Anything else — tone, exclusions, what worked before…"
            rows={3}
          />
        </Field>
      </div>

      <div className="border-t">
        <CreativesDropzone build={build} canEdit={canEdit} />
      </div>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function SaveIndicator({ state, error, readOnly }: { state: SaveState; error: string | null; readOnly: boolean }) {
  if (readOnly) return <span className="text-[11px] text-muted-foreground">Read-only</span>;
  switch (state) {
    case "saving":
      return (
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Saving…
        </span>
      );
    case "dirty":
      return <span className="text-[11px] text-muted-foreground">Unsaved changes</span>;
    case "saved":
      return (
        <span className="flex items-center gap-1 text-[11px] text-emerald-400">
          <Check className="h-3 w-3" /> Saved
        </span>
      );
    case "error":
      return (
        <span className="flex items-center gap-1 text-[11px] text-red-400" title={error ?? undefined} role="alert">
          <CloudOff className="h-3 w-3" /> Not saved{error ? ` — ${error.replace(/^\d{3}:\s*/, "")}` : ""}
        </span>
      );
    default:
      return null;
  }
}

function ChipInput({
  value,
  onChange,
  presets,
  disabled,
  placeholder,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  presets: string[];
  disabled?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  function add(v: string) {
    const t = v.trim();
    if (!t || value.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    onChange([...value, t]);
    setDraft("");
  }
  const unused = presets.filter((p) => !value.some((x) => x.toLowerCase() === p.toLowerCase()));
  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((a) => (
            <li key={a} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
              {a}
              {!disabled && (
                <button type="button" onClick={() => onChange(value.filter((x) => x !== a))} aria-label={`Remove ${a}`} className="text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Input
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => draft && add(draft)}
        placeholder={placeholder}
      />
      {!disabled && unused.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {unused.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => add(p)}
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              + {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
