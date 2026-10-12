// JavaScript injected at the top of every Code node that shapes a response.
// Ports of backend/app/services/{economics,targets}.py and small router helpers.
export const HELPERS = String.raw`
// Python's round(x, n) for display values (half-to-even on exact ties is not reproduced).
const pyRound = (x, n = 0) => (x === null || x === undefined ? x : Number(Number(x).toFixed(n)));
const num = (x) => (x === null || x === undefined ? 0 : Number(x));
const safeDiv = (a, b) => (b ? pyRound(a / b, 2) : null);

// economics.py
const maxCpba = (job, close, margin, share) => {
  const j = Number(job || 0);
  if (!(j > 0)) return null;
  return pyRound(j * Number(close || 0) * Number(margin || 0) * Number(share || 0), 2);
};
const cpbaColor = (cpba, ceiling) => {
  if (cpba === null || cpba === undefined || !ceiling) return null;
  return cpba <= ceiling * 0.75 ? 'green' : cpba <= ceiling ? 'yellow' : 'red';
};

// targets.py — targets: array of service_targets rows
const indexTargets = (rows) => {
  const m = new Map();
  for (const r of rows || []) m.set(r.service + '|' + r.platform, r);
  return m;
};
const resolveTarget = (tg, service, platform) => {
  if (!service) return null;
  return tg.get(service + '|' + (platform || 'all')) || tg.get(service + '|all') || null;
};
// overview.py _expected: lead-weighted (else spend-weighted) CPL green/red for service rows
const expectedCpl = (rows, tg, clientGreen, clientRed) => {
  let wg = 0, wr = 0, ws = 0;
  for (const r of rows) {
    const t = resolveTarget(tg, r.service, r.platform);
    const g = t && t.cpl_green !== null && t.cpl_green !== undefined ? Number(t.cpl_green) : clientGreen;
    const rd = t && t.cpl_red !== null && t.cpl_red !== undefined ? Number(t.cpl_red) : t ? g * 1.5 : clientRed;
    const w = num(r.leads) || num(r.spend) * 0.01;
    if (w <= 0) continue;
    wg += g * w; wr += rd * w; ws += w;
  }
  return ws === 0 ? null : [pyRound(wg / ws, 2), pyRound(wr / ws, 2)];
};

// FastAPI-style 422 for a missing / malformed query parameter
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const invalid = (loc, msg) => ({ status: 422, detail: [{ type: 'value_error', loc, msg }] });
`;
