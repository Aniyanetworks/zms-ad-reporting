import { describe, expect, it } from "vitest";
import { canAct, canApprove, canManage, OWNER_APPROVAL_PCT, requiresOwner } from "./permissions";

const budget = (pct: number | null) => ({ action: "budget_change" as const, pct_change: pct });
const pause = { action: "pause" as const, pct_change: null };

describe("requiresOwner", () => {
  it("flags budget changes above the threshold", () => {
    expect(requiresOwner(budget(OWNER_APPROVAL_PCT + 0.1))).toBe(true);
    expect(requiresOwner(budget(50))).toBe(true);
  });
  it("does not flag budget changes at or below the threshold", () => {
    expect(requiresOwner(budget(OWNER_APPROVAL_PCT))).toBe(false);
    expect(requiresOwner(budget(10))).toBe(false);
    expect(requiresOwner(budget(null))).toBe(false);
  });
  it("never flags non-budget actions, even with a large pct", () => {
    expect(requiresOwner(pause)).toBe(false);
    expect(requiresOwner({ action: "refresh_creative", pct_change: 80 })).toBe(false);
  });
  it("treats decreases as safe regardless of magnitude", () => {
    expect(requiresOwner(budget(-60))).toBe(false);
  });
});

describe("canApprove", () => {
  it("admin can approve everything", () => {
    expect(canApprove("admin", budget(50))).toBe(true);
    expect(canApprove("admin", budget(5))).toBe(true);
    expect(canApprove("admin", pause)).toBe(true);
  });
  it("media_buyer can approve within policy", () => {
    expect(canApprove("media_buyer", budget(20))).toBe(true);
    expect(canApprove("media_buyer", budget(-30))).toBe(true);
    expect(canApprove("media_buyer", pause)).toBe(true);
  });
  it("media_buyer cannot approve budget increases above 20%", () => {
    expect(canApprove("media_buyer", budget(21))).toBe(false);
    expect(canApprove("media_buyer", budget(100))).toBe(false);
  });
  it("viewer and unknown roles cannot approve anything", () => {
    expect(canApprove("viewer", pause)).toBe(false);
    expect(canApprove("viewer", budget(1))).toBe(false);
    expect(canApprove(null, pause)).toBe(false);
    expect(canApprove(undefined, pause)).toBe(false);
  });
});

describe("canManage", () => {
  it("is admin-only", () => {
    expect(canManage("admin")).toBe(true);
    expect(canManage("media_buyer")).toBe(false);
    expect(canManage("viewer")).toBe(false);
    expect(canManage(undefined)).toBe(false);
  });
});

describe("canAct", () => {
  it("excludes viewers and unknown roles", () => {
    expect(canAct("admin")).toBe(true);
    expect(canAct("media_buyer")).toBe(true);
    expect(canAct("viewer")).toBe(false);
    expect(canAct(null)).toBe(false);
  });
});
