import { describe, expect, it } from "vitest";
import { cplColor, fmtMoney, fmtNum, fmtPct } from "./format";

describe("fmtMoney", () => {
  it("renders a dash for null/undefined", () => {
    expect(fmtMoney(null)).toBe("—");
    expect(fmtMoney(undefined)).toBe("—");
  });
  it("keeps cents below $1,000", () => {
    expect(fmtMoney(0)).toBe("$0.00");
    expect(fmtMoney(42.5)).toBe("$42.50");
    expect(fmtMoney(999.99)).toBe("$999.99");
  });
  it("drops cents at $1,000 and above", () => {
    expect(fmtMoney(1000)).toBe("$1,000");
    expect(fmtMoney(12345.67)).toBe("$12,346");
  });
});

describe("fmtNum", () => {
  it("formats integers with separators and dashes for null", () => {
    expect(fmtNum(1234567)).toBe("1,234,567");
    expect(fmtNum(null)).toBe("—");
  });
});

describe("fmtPct", () => {
  it("renders a dash for null/undefined", () => {
    expect(fmtPct(null)).toBe("—");
    expect(fmtPct(undefined)).toBe("—");
  });
  it("multiplies by 100 with one decimal by default", () => {
    expect(fmtPct(0.1234)).toBe("12.3%");
    expect(fmtPct(1)).toBe("100.0%");
  });
  it("honours the digits argument", () => {
    expect(fmtPct(0.1234, 0)).toBe("12%");
    expect(fmtPct(0.1234, 2)).toBe("12.34%");
  });
});

describe("cplColor", () => {
  it("returns none when there is no CPL", () => {
    expect(cplColor(null, 50, 100)).toBe("none");
    expect(cplColor(undefined, 50, 100)).toBe("none");
  });
  it("is green strictly below the green target", () => {
    expect(cplColor(49.99, 50, 100)).toBe("green");
    expect(cplColor(50, 50, 100)).toBe("yellow");
  });
  it("is red strictly above the red target", () => {
    expect(cplColor(100.01, 50, 100)).toBe("red");
    expect(cplColor(100, 50, 100)).toBe("yellow");
  });
  it("is yellow in between", () => {
    expect(cplColor(75, 50, 100)).toBe("yellow");
  });
});
