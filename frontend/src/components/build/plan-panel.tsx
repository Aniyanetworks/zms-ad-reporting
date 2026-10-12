"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Code2,
  ExternalLink,
  ImageOff,
  Loader2,
  Pencil,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { AssetThumb } from "@/components/build/creatives-dropzone";
import { geoLabel } from "@/components/build/geo-picker";
import { StatusPill } from "@/components/build/status-pill";
import { useSetBuild } from "@/components/build/use-build";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiFetch, type ApproveResponse, type Build, type Me, type Plan, type PlanAd, type PlanAdSet, type Validation } from "@/lib/api";
import { canApproveBuild, countAds, fmtCents, isInFlight } from "@/lib/build";
import { cn } from "@/lib/utils";

/** Click-to-edit text. Enter commits (Shift+Enter newline when multiline), Esc cancels, blur commits. */
function EditableText({
  value,
  onCommit,
  canEdit,
  multiline,
  className,
  placeholder,
  label,
}: {
  value: string;
  onCommit: (next: string) => void;
  canEdit: boolean;
  multiline?: boolean;
  className?: string;
  placeholder?: string;
  label: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function start() {
    if (!canEdit) return;
    setDraft(value);
    setEditing(true);
  }
  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next !== value) onCommit(next);
  }
  function cancel() {
    setEditing(false);
    setDraft(value);
  }

  if (editing) {
    const shared = {
      autoFocus: true,
      value: draft,
      "aria-label": label,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        } else if (e.key === "Enter" && (!multiline || !e.shiftKey)) {
          e.preventDefault();
          commit();
        }
      },
    };
    return multiline ? <Textarea {...shared} rows={3} className={cn("text-sm", className)} /> : <Input {...shared} className={cn("h-7 text-sm", className)} />;
  }
  return (
    <button
      type="button"
      onClick={start}
      disabled={!canEdit}
      title={canEdit ? `Edit ${label.toLowerCase()}` : undefined}
      className={cn(
        "group/edit -mx-1 inline-flex max-w-full items-start gap-1 rounded px-1 text-left whitespace-pre-wrap break-words",
        canEdit && "hover:bg-accent/60",
        !value && "text-muted-foreground italic",
        className,
      )}
    >
      <span className="min-w-0">{value || placeholder || "—"}</span>
      {canEdit && <Pencil className="mt-0.5 h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/edit:opacity-60" />}
    </button>
  );
}

function ValidationBlock({ v }: { v: Validation | null }) {
  if (!v) {
    return <p className="text-xs text-muted-foreground">Not validated yet.</p>;
  }
  if (v.ok && v.problems.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-emerald-400">
        <CheckCircle2 className="h-4 w-4" /> Ready to create
        <span className="text-[11px] text-muted-foreground">checked {new Date(v.checked_at).toLocaleTimeString()}</span>
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <p className={cn("flex items-center gap-1.5 text-sm", v.ok ? "text-emerald-400" : "text-red-400")}>
        {v.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
        {v.ok ? "Ready to create — with warnings" : "Not ready"}
        <span className="text-[11px] text-muted-foreground">checked {new Date(v.checked_at).toLocaleTimeString()}</span>
      </p>
      <ul className="space-y-1">
        {v.problems.map((p, i) => (
          <li key={`${p.code}-${i}`} className="flex items-start gap-2 text-xs">
            <span
              className={cn(
                "mt-px shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                p.level === "error" ? "bg-red-500/15 text-red-400" : "bg-amber-500/15 text-amber-400",
              )}
            >
              {p.level}
            </span>
            <span className="min-w-0 flex-1">
              {p.message}
              {p.path && <span className="ml-1 font-mono text-[10px] text-muted-foreground">{p.path}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PlanPanel({ build, me, canEdit }: { build: Build; me: Me | undefined; canEdit: boolean }) {
  const setBuild = useSetBuild(build.id);
  const [showPayload, setShowPayload] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const plan = build.plan;
  const currency = build.account_context?.currency ?? "USD";
  const assetById = new Map(build.assets.map((a) => [a.id, a]));
  const formName = (id?: string) => build.account_context?.lead_forms.find((f) => f.id === id)?.name;

  const savePlan = useMutation({
    mutationFn: (next: Plan) =>
      apiFetch<Build>(`/api/builds/${encodeURIComponent(build.id)}/plan`, { method: "PUT", body: JSON.stringify(next) }),
    onSuccess: (b) => {
      setSaveError(null);
      setBuild(b);
    },
    onError: (err) => {
      // 422 carries the server's Validation as `detail` — surface it in the block below.
      if (err instanceof ApiError && err.status === 422 && err.detail && typeof err.detail === "object" && "problems" in err.detail) {
        const v = err.detail as Validation;
        setBuild((b) => ({ ...b, validation: v }));
        setSaveError("The edit was rejected — see the validation problems below.");
      } else {
        setSaveError((err as Error).message.replace(/^\d{3}:\s*/, ""));
      }
    },
  });

  function edit(mutate: (p: Plan) => void) {
    if (!plan) return;
    const next: Plan = structuredClone(plan);
    mutate(next);
    savePlan.mutate(next);
  }

  const validate = useMutation({
    mutationFn: () => apiFetch<Build>(`/api/builds/${encodeURIComponent(build.id)}/validate`, { method: "POST" }),
    onSuccess: (b) => setBuild(b),
  });

  const approve = useMutation({
    mutationFn: () => apiFetch<ApproveResponse>(`/api/builds/${encodeURIComponent(build.id)}/approve`, { method: "POST" }),
    onSuccess: (r) => {
      setConfirmOpen(false);
      setBuild(r.build);
    },
  });

  const decision = canApproveBuild(me, plan);
  const inFlight = isInFlight(build.status);
  const approveEnabled = !!plan && !!build.validation?.ok && build.status === "planned" && decision.ok && !approve.isPending;
  let approveHint: string | null = null;
  if (plan && build.status === "planned") {
    if (decision.reason === "budget_cap") approveHint = `Owner approval required over ${fmtCents(decision.cap_cents, currency)}/day`;
    else if (decision.reason === "role" || decision.reason === "no_permissions") approveHint = "Your role can't approve builds";
    else if (!build.validation) approveHint = "Validate first";
    else if (!build.validation.ok) approveHint = "Fix the errors above, then validate again";
  } else if (plan && build.status === "draft") {
    approveHint = "Validate to move the build to Planned";
  }

  const created = build.created_objects;
  const busy = savePlan.isPending;

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-card/95 px-4 py-2.5 backdrop-blur">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          Plan
          {plan && <span className="text-xs font-normal text-muted-foreground">v{plan.version}</span>}
          {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </h2>
        {plan && (
          <button
            type="button"
            onClick={() => setShowPayload((v) => !v)}
            className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground", showPayload && "bg-accent text-foreground")}
            aria-pressed={showPayload}
          >
            <Code2 className="h-3 w-3" /> {showPayload ? "Hide payload" : "Show payload"}
          </button>
        )}
      </div>

      <div className="flex-1 space-y-4 p-4">
        {(inFlight || created || build.status === "failed") && (
          <CreationStatus build={build} onBackToPlanning={() => validate.mutate()} backPending={validate.isPending} canEdit={canEdit} />
        )}

        {!plan ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No plan yet. Fill in the brief and ask the assistant to <span className="text-foreground">draft a plan</span>; it appears here
            the moment it&rsquo;s proposed.
          </div>
        ) : showPayload ? (
          <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-[11px] leading-relaxed">{JSON.stringify(plan, null, 2)}</pre>
        ) : (
          <>
            {saveError && (
              <p className="flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400" role="alert">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {saveError}
              </p>
            )}

            <section className="rounded-lg border p-3">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Campaign</p>
              <EditableText
                label="Campaign name"
                value={plan.campaign.name}
                canEdit={canEdit && !busy}
                className="text-sm font-semibold"
                onCommit={(v) => edit((p) => void (p.campaign.name = v))}
              />
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Objective</dt>
                <dd>{plan.campaign.objective}</dd>
                <dt className="text-muted-foreground">Daily budget</dt>
                <dd className="tabular-nums">{fmtCents(plan.campaign.daily_budget_cents, currency)}</dd>
                <dt className="text-muted-foreground">Bid strategy</dt>
                <dd>{plan.campaign.bid_strategy}</dd>
                <dt className="text-muted-foreground">Start</dt>
                <dd>{plan.campaign.start_date ?? "On launch (PAUSED until activated)"}</dd>
                {plan.campaign.special_ad_categories.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">Special categories</dt>
                    <dd>{plan.campaign.special_ad_categories.join(", ")}</dd>
                  </>
                )}
              </dl>
            </section>

            {plan.ad_sets.map((s, si) => (
              <AdSetCard
                key={si}
                adSet={s}
                index={si}
                canEdit={canEdit && !busy}
                formName={formName(s.lead_form_id)}
                assetFor={(id) => assetById.get(id)}
                onEditName={(v) => edit((p) => void (p.ad_sets[si].name = v))}
                onEditAd={(ai, field, v) => edit((p) => void ((p.ad_sets[si].ads[ai] as unknown as Record<string, string>)[field] = v))}
              />
            ))}

            <section className="rounded-lg border p-3">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">URL tags</p>
              <code className="block break-all rounded bg-muted/60 p-2 font-mono text-[11px]">{plan.url_tags || "—"}</code>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Website destination only; Instant Forms attribute via the form→GHL mapping.
              </p>
            </section>

            {plan.notes && (
              <section className="rounded-lg border p-3">
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Assistant notes</p>
                <p className="text-xs whitespace-pre-wrap">{plan.notes}</p>
              </section>
            )}
          </>
        )}

        {plan && !showPayload && (
          <section className="rounded-lg border p-3">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Validation</p>
            <ValidationBlock v={build.validation} />
          </section>
        )}
      </div>

      {plan && !created && (
        <div className="sticky bottom-0 z-10 border-t bg-card/95 p-3 backdrop-blur">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canEdit || validate.isPending || inFlight}
              onClick={() => validate.mutate()}
            >
              {validate.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              Validate
            </Button>
            <Button size="sm" className="flex-1" disabled={!approveEnabled} onClick={() => setConfirmOpen(true)} title={approveHint ?? undefined}>
              {inFlight ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BadgeCheck className="h-3.5 w-3.5" />}
              {inFlight ? "Creating…" : "Approve & create (PAUSED)"}
            </Button>
          </div>
          {approveHint && !inFlight && (
            <p className={cn("mt-1.5 text-[11px]", decision.reason === "budget_cap" ? "text-amber-400" : "text-muted-foreground")}>{approveHint}</p>
          )}
          {validate.error && (
            <p className="mt-1.5 text-[11px] text-red-400" role="alert">
              {(validate.error as Error).message.replace(/^\d{3}:\s*/, "")}
            </p>
          )}
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve and create in Meta?</DialogTitle>
            <DialogDescription>Everything is created PAUSED. Launch happens in Ads Manager.</DialogDescription>
          </DialogHeader>
          {plan && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Campaign</dt>
              <dd className="font-medium">{plan.campaign.name}</dd>
              <dt className="text-muted-foreground">Ad sets</dt>
              <dd>{plan.ad_sets.length}</dd>
              <dt className="text-muted-foreground">Ads</dt>
              <dd>{countAds(plan)}</dd>
              <dt className="text-muted-foreground">Daily budget</dt>
              <dd className="tabular-nums">{fmtCents(plan.campaign.daily_budget_cents, currency)}</dd>
              <dt className="text-muted-foreground">Account</dt>
              <dd className="font-mono text-xs">{build.account_context?.ad_account_id ?? "—"}</dd>
            </dl>
          )}
          {approve.error && (
            <p className="text-xs text-red-400" role="alert">
              {(approve.error as Error).message.replace(/^\d{3}:\s*/, "")}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button disabled={approve.isPending} onClick={() => approve.mutate()}>
              {approve.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BadgeCheck className="h-3.5 w-3.5" />}
              Approve & create (PAUSED)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AdSetCard({
  adSet,
  index,
  canEdit,
  formName,
  assetFor,
  onEditName,
  onEditAd,
}: {
  adSet: PlanAdSet;
  index: number;
  canEdit: boolean;
  formName?: string;
  assetFor: (id: string) => Build["assets"][number] | undefined;
  onEditName: (v: string) => void;
  onEditAd: (adIndex: number, field: "name" | "primary_text" | "headline" | "description" | "cta", v: string) => void;
}) {
  const t = adSet.targeting;
  return (
    <section className="rounded-lg border p-3">
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Ad set {index + 1}</p>
      <EditableText label="Ad set name" value={adSet.name} canEdit={canEdit} className="text-sm font-medium" onCommit={onEditName} />
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Destination</dt>
        <dd className="min-w-0 break-all">
          {adSet.destination === "instant_form" ? (
            <>
              Instant Form{adSet.lead_form_id && <> · {formName ?? "form"} <span className="font-mono text-muted-foreground">{adSet.lead_form_id}</span></>}
            </>
          ) : (
            <>Website · {adSet.landing_page_url ?? "—"}</>
          )}
        </dd>
        <dt className="text-muted-foreground">Locations</dt>
        <dd>
          {t.geo.length === 0 ? (
            <span className="text-amber-400">none</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {t.geo.map((g) => (
                <span key={g.key} className="rounded-full border px-1.5 py-px text-[11px]">
                  {geoLabel(g)}
                  {g.radius_miles !== undefined && <span className="text-muted-foreground"> +{g.radius_miles}mi</span>}
                </span>
              ))}
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Age</dt>
        <dd className="tabular-nums">
          {t.age_min}–{t.age_max}
          {t.age_max >= 65 && "+"}
          {t.genders.length > 0 && <span className="text-muted-foreground"> · {t.genders.map((g) => (g === 1 ? "men" : g === 2 ? "women" : String(g))).join(", ")}</span>}
        </dd>
        <dt className="text-muted-foreground">Placements</dt>
        <dd>Advantage+</dd>
      </dl>
      <div className="mt-3 space-y-2">
        {adSet.ads.map((ad, ai) => (
          <AdCard key={ai} ad={ad} asset={assetFor(ad.asset_id)} canEdit={canEdit} onEdit={(f, v) => onEditAd(ai, f, v)} />
        ))}
        {adSet.ads.length === 0 && <p className="text-xs text-amber-400">No ads in this ad set.</p>}
      </div>
    </section>
  );
}

function AdCard({
  ad,
  asset,
  canEdit,
  onEdit,
}: {
  ad: PlanAd;
  asset: Build["assets"][number] | undefined;
  canEdit: boolean;
  onEdit: (field: "name" | "primary_text" | "headline" | "description" | "cta", v: string) => void;
}) {
  return (
    <div className="flex gap-3 rounded-md bg-muted/40 p-2">
      {asset ? (
        <AssetThumb asset={asset} className="h-20 w-20 shrink-0 rounded-md" />
      ) : (
        <div className="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-[10px] text-amber-400" title={`Asset ${ad.asset_id} is not on this build`}>
          <ImageOff className="h-4 w-4" /> missing
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-1 text-xs">
        <EditableText label="Ad name" value={ad.name} canEdit={canEdit} className="font-medium" onCommit={(v) => onEdit("name", v)} />
        <div>
          <span className="text-[10px] uppercase text-muted-foreground">Primary text</span>
          <EditableText label="Primary text" value={ad.primary_text} canEdit={canEdit} multiline className="block w-full" onCommit={(v) => onEdit("primary_text", v)} />
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div className="min-w-0">
            <span className="text-[10px] uppercase text-muted-foreground">Headline</span>
            <EditableText label="Headline" value={ad.headline} canEdit={canEdit} className="block w-full" onCommit={(v) => onEdit("headline", v)} />
          </div>
          <div>
            <span className="text-[10px] uppercase text-muted-foreground">CTA</span>
            <EditableText label="Call to action" value={ad.cta} canEdit={canEdit} className="block font-mono" onCommit={(v) => onEdit("cta", v.toUpperCase().replace(/\s+/g, "_"))} />
          </div>
        </div>
        <div>
          <span className="text-[10px] uppercase text-muted-foreground">Description</span>
          <EditableText label="Description" value={ad.description ?? ""} placeholder="optional" canEdit={canEdit} className="block w-full" onCommit={(v) => onEdit("description", v)} />
        </div>
      </div>
    </div>
  );
}

function CreationStatus({
  build,
  onBackToPlanning,
  backPending,
  canEdit,
}: {
  build: Build;
  onBackToPlanning: () => void;
  backPending: boolean;
  canEdit: boolean;
}) {
  const c = build.created_objects;
  const failed = build.status === "failed";
  const log = c?.log ?? [];
  return (
    <section className={cn("rounded-lg border p-3", failed ? "border-red-500/40 bg-red-500/5" : build.status === "created" ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5")}>
      <div className="flex flex-wrap items-center gap-2">
        {isInFlight(build.status) && <Loader2 className="h-4 w-4 animate-spin text-amber-400" />}
        <StatusPill status={build.status} />
        <span className="text-sm font-medium">
          {build.status === "approved" && "Approved — waiting for the worker to start"}
          {build.status === "creating" && "Creating campaign, ad sets and ads in Meta (PAUSED)…"}
          {build.status === "created" && "Created in Meta — paused"}
          {failed && "Creation failed"}
        </span>
        {c?.verified && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-emerald-400" title="Every object was read back from Meta after creation">
            <ShieldCheck className="h-3.5 w-3.5" /> verified
          </span>
        )}
        {c && !c.verified && build.status === "created" && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" /> not verified
          </span>
        )}
      </div>
      {isInFlight(build.status) && <p className="mt-1 text-[11px] text-muted-foreground">Refreshing every 3 seconds.</p>}

      {failed && build.error && (
        <p className="mt-2 rounded bg-red-500/10 p-2 font-mono text-[11px] break-words text-red-300" role="alert">
          {build.error}
        </p>
      )}

      {c && build.status === "created" && (
        <div className="mt-2 space-y-2 text-xs">
          <a
            href={c.ads_manager_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-primary-foreground hover:bg-primary/80"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open in Ads Manager
          </a>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Campaign</dt>
            <dd className="min-w-0 break-all">
              {c.campaign.name} <span className="font-mono text-muted-foreground">{c.campaign.id}</span> · {c.campaign.status}
            </dd>
            <dt className="text-muted-foreground">Ad sets</dt>
            <dd className="min-w-0 space-y-0.5">
              {c.ad_sets.map((s) => (
                <div key={s.id} className="break-all">
                  {s.name} <span className="font-mono text-muted-foreground">{s.id}</span> · {s.status}
                </div>
              ))}
            </dd>
            <dt className="text-muted-foreground">Ads</dt>
            <dd className="min-w-0 space-y-0.5">
              {c.ads.map((a) => (
                <div key={a.id} className="break-all">
                  {a.name} <span className="font-mono text-muted-foreground">{a.id}</span> · {a.status}
                </div>
              ))}
            </dd>
            {c.creatives.length > 0 && (
              <>
                <dt className="text-muted-foreground">Creatives</dt>
                <dd className="font-mono break-all text-muted-foreground">{c.creatives.map((x) => x.id).join(", ")}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      {log.length > 0 && (
        <details className="mt-2 text-xs" open={failed}>
          <summary className="cursor-pointer text-muted-foreground">Step log ({log.length})</summary>
          <ol className="mt-1 space-y-0.5">
            {log.map((l, i) => (
              <li key={i} className="flex items-start gap-2">
                {l.ok ? <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-emerald-400" /> : <XCircle className="mt-px h-3 w-3 shrink-0 text-red-400" />}
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{new Date(l.at).toLocaleTimeString()}</span>
                <span className="min-w-0 break-words">
                  {l.step}
                  {l.detail && <span className="text-muted-foreground"> — {l.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}

      {failed && canEdit && (
        <Button size="sm" variant="outline" className="mt-3" disabled={backPending} onClick={onBackToPlanning}>
          {backPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          Back to planning
        </Button>
      )}
    </section>
  );
}
