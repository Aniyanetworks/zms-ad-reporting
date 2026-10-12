import type { Recommendation, Role } from "@/lib/api";

/** Budget increases above this percentage need the Agency Owner (admin). */
export const OWNER_APPROVAL_PCT = 20;

/** Minimal shape needed to decide approval rights; accepts a full Recommendation. */
export type RecLike = Pick<Recommendation, "action" | "pct_change">;

/** True when a budget_change is large enough that only an admin may approve it. */
export function requiresOwner(rec: RecLike): boolean {
  return rec.action === "budget_change" && (rec.pct_change ?? 0) > OWNER_APPROVAL_PCT;
}

/**
 * Can this role approve or dismiss the recommendation?
 *  - admin: always
 *  - media_buyer: yes, except budget_change with pct_change > 20
 *  - viewer / unknown: never
 * Mirrors backend `policy.py`; the server is authoritative.
 */
export function canApprove(role: Role | null | undefined, rec: RecLike): boolean {
  if (role === "admin") return true;
  if (role === "media_buyer") return !requiresOwner(rec);
  return false;
}

/** Client registry + sync triggers (Settings page) are admin-only. */
export function canManage(role: Role | null | undefined): boolean {
  return role === "admin";
}

/** Whether the role may act on recommendations at all (viewer is read-only). */
export function canAct(role: Role | null | undefined): boolean {
  return role === "admin" || role === "media_buyer";
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Owner",
  media_buyer: "Media buyer",
  viewer: "Viewer",
};
