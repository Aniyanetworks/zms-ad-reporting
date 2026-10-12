import { describe, expect, it } from "vitest";
import { PASSWORD_MIN_LENGTH, passwordError, passwordPairError } from "./password";

describe("passwordError", () => {
  it("accepts 12+ chars with letters and digits", () => {
    expect(passwordError("correcthorse1")).toBeNull();
    expect(passwordError("a".repeat(11) + "1")).toBeNull();
    expect(passwordError("Sup3r-long-passphrase!")).toBeNull();
  });
  it("rejects short passwords first", () => {
    expect(passwordError("abc123")).toMatch(/12 characters/);
    expect(passwordError("a".repeat(PASSWORD_MIN_LENGTH - 1))).toMatch(/12 characters/);
    expect(passwordError("")).toMatch(/12 characters/);
  });
  it("requires at least one letter", () => {
    expect(passwordError("123456789012")).toMatch(/letter/);
    expect(passwordError("1234-5678-9012!")).toMatch(/letter/);
  });
  it("requires at least one digit", () => {
    expect(passwordError("abcdefghijkl")).toMatch(/digit/);
    expect(passwordError("Passphrase-without-numbers")).toMatch(/digit/);
  });
});

describe("passwordPairError", () => {
  it("passes through rule failures", () => {
    expect(passwordPairError("short1", "short1")).toMatch(/12 characters/);
  });
  it("requires the confirmation to match", () => {
    expect(passwordPairError("correcthorse1", "correcthorse2")).toBe("Passwords do not match.");
  });
  it("returns null for a valid matching pair", () => {
    expect(passwordPairError("correcthorse1", "correcthorse1")).toBeNull();
  });
});
