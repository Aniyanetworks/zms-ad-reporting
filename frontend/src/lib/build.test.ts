import { describe, expect, it } from "vitest";
import type { Me, Plan } from "@/lib/api";
import {
  BUILD_STATUS_ORDER,
  buildDailyBudgetCents,
  buildDisplayName,
  canApproveBuild,
  canEditBuilds,
  countAds,
  dollarsToCents,
  fmtCents,
  isCancellable,
  isEditable,
  isInFlight,
  statusIndex,
  statusSortRank,
} from "./build";

const me = (role: Me["role"], cap: number | null, create = true): Me => ({
  id: "u1",
  email: "x@y.z",
  role,
  full_name: null,
  permissions: { create_build: create, approve_build_max_daily_cents: cap },
});

const plan = (dailyCents: number, ads = 2): Plan => ({
  version: 1,
  campaign: {
    name: "Dove | Roofing | Lead Form",
    objective: "OUTCOME_LEADS",
    daily_budget_cents: dailyCents,
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    special_ad_categories: [],
  },
  ad_sets: [
    {
      name: "Broad",
      destination: "instant_form",
      lead_form_id: "f1",
      targeting: { geo: [], age_min: 25, age_max: 65, genders: [] },
      placements: "advantage_plus",
      ads: Array.from({ length: ads }, (_, i) => ({
        name: `Ad ${i + 1}`,
        asset_id: `a${i}`,
        primary_text: "p",
        headline: "h",
        cta: "LEARN_MORE",
      })),
    },
  ],
  url_tags: "utm_source=facebook",
});

describe("status helpers", () => {
  it("orders the happy path and puts failed/cancelled off the timeline", () => {
    expect(BUILD_STATUS_ORDER).toEqual(["draft", "planned", "approved", "creating", "created"]);
    expect(statusIndex("draft")).toBe(0);
    expect(statusIndex("created")).toBe(4);
    expect(statusIndex("failed")).toBe(-1);
    expect(statusIndex("cancelled")).toBe(-1);
  });
  it("sorts live work ahead of finished and cancelled builds", () => {
    expect(statusSortRank("creating")).toBeLessThan(statusSortRank("planned"));
    expect(statusSortRank("planned")).toBeLessThan(statusSortRank("created"));
    expect(statusSortRank("created")).toBeLessThan(statusSortRank("cancelled"));
  });
  it("only draft/planned/failed/cancelled can be deleted", () => {
    expect(isCancellable("draft")).toBe(true);
    expect(isCancellable("planned")).toBe(true);
    expect(isCancellable("failed")).toBe(true);
    expect(isCancellable("cancelled")).toBe(true);
    expect(isCancellable("approved")).toBe(false);
    expect(isCancellable("creating")).toBe(false);
    expect(isCancellable("created")).toBe(false);
  });
  it("editable vs in-flight are disjoint", () => {
    for (const s of ["draft", "planned", "failed"] as const) {
      expect(isEditable(s)).toBe(true);
      expect(isInFlight(s)).toBe(false);
    }
    for (const s of ["approved", "creating"] as const) {
      expect(isEditable(s)).toBe(false);
      expect(isInFlight(s)).toBe(true);
    }
    expect(isEditable("created")).toBe(false);
    expect(isInFlight("created")).toBe(false);
  });
});

describe("fmtCents / dollarsToCents", () => {
  it("formats whole dollars without cents and fractional with two", () => {
    expect(fmtCents(4500)).toBe("$45");
    expect(fmtCents(123456)).toBe("$1,234.56");
    expect(fmtCents(0)).toBe("$0");
    expect(fmtCents(5)).toBe("$0.05");
  });
  it("returns a dash for missing values", () => {
    expect(fmtCents(null)).toBe("—");
    expect(fmtCents(undefined)).toBe("—");
    expect(fmtCents(NaN)).toBe("—");
  });
  it("honours the account currency", () => {
    expect(fmtCents(4500, "CAD")).toMatch(/45/);
    expect(fmtCents(4500, "CAD")).not.toBe("$45");
  });
  it("parses dollar input to cents, tolerating symbols and blanks", () => {
    expect(dollarsToCents("45")).toBe(4500);
    expect(dollarsToCents("$1,250.5")).toBe(125050);
    expect(dollarsToCents(12.345)).toBe(1235);
    expect(dollarsToCents("")).toBeUndefined();
    expect(dollarsToCents("abc")).toBeUndefined();
  });
});

describe("canApproveBuild", () => {
  it("admin approves any budget, cap is unlimited", () => {
    expect(canApproveBuild(me("admin", null), plan(999_999_00))).toEqual({ ok: true, reason: null, cap_cents: null });
  });
  it("admin still needs a plan", () => {
    expect(canApproveBuild(me("admin", null), null).reason).toBe("no_plan");
  });
  it("media_buyer approves at or under the cap", () => {
    expect(canApproveBuild(me("media_buyer", 50_000), plan(50_000)).ok).toBe(true);
    expect(canApproveBuild(me("media_buyer", 50_000), plan(4_500)).ok).toBe(true);
  });
  it("media_buyer is blocked above the cap and told the cap", () => {
    const d = canApproveBuild(me("media_buyer", 50_000), plan(50_001));
    expect(d).toEqual({ ok: false, reason: "budget_cap", cap_cents: 50_000 });
  });
  it("media_buyer with a null cap is unlimited; with a zero cap is blocked", () => {
    expect(canApproveBuild(me("media_buyer", null), plan(1_000_000)).ok).toBe(true);
    expect(canApproveBuild(me("media_buyer", 0), plan(100)).reason).toBe("role");
  });
  it("viewer and missing user never approve", () => {
    expect(canApproveBuild(me("viewer", 0), plan(100))).toMatchObject({ ok: false, reason: "role" });
    expect(canApproveBuild(null, plan(100))).toMatchObject({ ok: false, reason: "no_permissions" });
    expect(canApproveBuild(undefined, plan(100)).ok).toBe(false);
  });
  it("tolerates a Me without permissions (older backend)", () => {
    const legacy = { ...me("media_buyer", null), permissions: undefined } as unknown as Me;
    expect(canApproveBuild(legacy, plan(100)).ok).toBe(true);
    expect(canEditBuilds(legacy)).toBe(false);
  });
});

describe("canEditBuilds", () => {
  it("follows permissions.create_build", () => {
    expect(canEditBuilds(me("media_buyer", 50_000, true))).toBe(true);
    expect(canEditBuilds(me("viewer", 0, false))).toBe(false);
    expect(canEditBuilds(null)).toBe(false);
  });
});

describe("display helpers", () => {
  it("prefers the planned campaign name, then the title, then a fallback", () => {
    expect(buildDisplayName({ title: "T", plan: plan(1) })).toBe("Dove | Roofing | Lead Form");
    expect(buildDisplayName({ title: "T", plan: null })).toBe("T");
    expect(buildDisplayName({ title: "  ", plan: null })).toBe("Untitled build");
    expect(buildDisplayName({ title: null, plan: null })).toBe("Untitled build");
  });
  it("uses the plan budget when planned, else the brief", () => {
    expect(buildDailyBudgetCents({ plan: plan(7000), brief: { daily_budget_cents: 100 } })).toBe(7000);
    expect(buildDailyBudgetCents({ plan: null, brief: { daily_budget_cents: 100 } })).toBe(100);
    expect(buildDailyBudgetCents({ plan: null, brief: {} })).toBeNull();
  });
  it("counts ads across ad sets", () => {
    expect(countAds(plan(1, 3))).toBe(3);
    expect(countAds(null)).toBe(0);
  });
});
