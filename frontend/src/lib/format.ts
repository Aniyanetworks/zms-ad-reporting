const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const usdCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v >= 1000 ? usd.format(v) : usdCents.format(v);
}

export function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return num.format(v);
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

/** Conditional formatting vs client-configurable CPL targets. */
export function cplColor(
  cpl: number | null | undefined,
  green: number,
  red: number,
): "green" | "yellow" | "red" | "none" {
  if (cpl === null || cpl === undefined) return "none";
  if (cpl < green) return "green";
  if (cpl > red) return "red";
  return "yellow";
}
