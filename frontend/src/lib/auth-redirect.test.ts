import { describe, expect, it } from "vitest";
import { destinationFor, safeNextPath } from "./auth-redirect";

describe("safeNextPath", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeNextPath("/clients/dove")).toBe("/clients/dove");
    expect(safeNextPath("/settings?tab=sync")).toBe("/settings?tab=sync");
  });
  it("falls back for absolute URLs, protocol-relative, empty, and null", () => {
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined, "/set-password")).toBe("/set-password");
  });
});

describe("destinationFor", () => {
  it("sends invite and recovery links to /set-password", () => {
    expect(destinationFor("invite", null)).toBe("/set-password");
    expect(destinationFor("recovery", undefined)).toBe("/set-password");
  });
  it("sends everything else to the dashboard", () => {
    expect(destinationFor("magiclink", null)).toBe("/");
    expect(destinationFor(null, null)).toBe("/");
  });
  it("prefers a safe next path over the type default", () => {
    expect(destinationFor("invite", "/clients/dove")).toBe("/clients/dove");
    expect(destinationFor("invite", "https://evil.example")).toBe("/set-password");
  });
});
