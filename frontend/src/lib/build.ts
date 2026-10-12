import type { Build, BuildStatus, Me, Plan } from "@/lib/api";

/** The happy path, in order. failed / cancelled sit outside the timeline. */
export const BUILD_STATUS_ORDER: readonly BuildStatus[] = [
  "draft",
  "planned",
  "approved",
  "creating",
  "created",
];

export const BUILD_STATUS_LABELS: Record<BuildStatus, string> = {
  draft: "Draft",
  planned: "Planned",
  approved: "Approved",
  creating: "Creating",
  created: "Created",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const BUILD_STATUS_STYLES: Record<BuildStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  planned: "bg-sky-500/15 text-sky-400",
  approved: "bg-violet-500/15 text-violet-400",
  creating: "bg-amber-500/15 text-amber-400",
  created: "bg-emerald-500/15 text-emerald-400",
  failed: "bg-red-500/15 text-red-400",
  cancelled: "bg-muted text-muted-foreground line-through",
};

/** Position on the timeline; -1 for failed / cancelled. */
export function statusIndex(status: BuildStatus): number {
  return BUILD_STATUS_ORDER.indexOf(status);
}

/** Sort key: live work first (creating, approved, planned, draft), then done, then failed/cancelled. */
export function statusSortRank(status: BuildStatus): number {
  const rank: Record<BuildStatus, number> = {
    creating: 0,
    approved: 1,
    planned: 2,
    draft: 3,
    failed: 4,
    created: 5,
    cancelled: 6,
  };
  return rank[status];
}

/** DELETE is only allowed for these — the server turns them into `cancelled`. */
export function isCancellable(status: BuildStatus): boolean {
  return status === "draft" || status === "planned" || status === "failed" || status === "cancelled";
}

/** Brief / plan / chat may change in these statuses (failed goes back to planned on the next plan or validate). */
export function isEditable(status: BuildStatus): boolean {
  return status === "draft" || status === "planned" || status === "failed";
}

/** While the background creation runs the UI polls GET /api/builds/{id}. */
export function isInFlight(status: BuildStatus): boolean {
  return status === "approved" || status === "creating";
}

/** Cents → "$1,234.50" ("$1,234" when whole). "—" for null/undefined. */
export function fmtCents(cents: number | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return "—";
  const dollars = cents / 100;
  const whole = Number.isInteger(dollars);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(dollars);
  } catch {
    return `${dollars.toFixed(whole ? 0 : 2)} ${currency}`;
  }
}

/** "$45" → 4500; blank/invalid → undefined. Rounds to the cent. */
export function dollarsToCents(input: string | number): number | undefined {
  const n = typeof input === "number" ? input : parseFloat(String(input).replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 100);
}

export type ApproveBlock = "no_permissions" | "role" | "no_plan" | "budget_cap" | null;

export interface ApproveDecision {
  ok: boolean;
  /** Why not, when `ok` is false. */
  reason: ApproveBlock;
  /** The user's cap in cents (null = unlimited) — used for the "Owner approval required over $X/day" hint. */
  cap_cents: number | null;
}

/**
 * May this user approve this plan?
 *  - admin: always (cap is null = unlimited)
 *  - media_buyer: when plan.campaign.daily_budget_cents <= approve_build_max_daily_cents
 *    (a null cap for a media buyer is treated as unlimited too)
 *  - viewer / unknown / missing permissions: never
 * Mirrors the server's approve policy; the server is authoritative.
 */
export function canApproveBuild(me: Me | null | undefined, plan: Plan | null | undefined): ApproveDecision {
  const perms = me?.permissions;
  const cap = perms?.approve_build_max_daily_cents ?? null;
  if (!me) return { ok: false, reason: "no_permissions", cap_cents: cap };
  if (me.role === "admin") {
    return plan ? { ok: true, reason: null, cap_cents: null } : { ok: false, reason: "no_plan", cap_cents: null };
  }
  if (me.role !== "media_buyer") return { ok: false, reason: "role", cap_cents: cap };
  if (!plan) return { ok: false, reason: "no_plan", cap_cents: cap };
  if (cap === null) return { ok: true, reason: null, cap_cents: null };
  if (cap <= 0) return { ok: false, reason: "role", cap_cents: cap };
  if (plan.campaign.daily_budget_cents > cap) return { ok: false, reason: "budget_cap", cap_cents: cap };
  return { ok: true, reason: null, cap_cents: cap };
}

/** Whether the user may create builds and edit briefs / plans / chat. */
export function canEditBuilds(me: Me | null | undefined): boolean {
  return me?.permissions?.create_build === true;
}

/** What to call a build in lists: the planned campaign name, else the title, else a fallback. */
export function buildDisplayName(b: Pick<Build, "title" | "plan">): string {
  return b.plan?.campaign.name?.trim() || b.title?.trim() || "Untitled build";
}

/** Daily budget to show for a build: the plan's when planned, else the brief's. */
export function buildDailyBudgetCents(b: Pick<Build, "plan" | "brief">): number | null {
  return b.plan?.campaign.daily_budget_cents ?? b.brief?.daily_budget_cents ?? null;
}

/** Count ads across all ad sets. */
export function countAds(plan: Plan | null | undefined): number {
  return plan?.ad_sets.reduce((n, s) => n + s.ads.length, 0) ?? 0;
}
