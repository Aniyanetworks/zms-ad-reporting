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

// Rejections from a Validate step. fail() for plain errors, invalid() for FastAPI-style 422s.
const fail = (status, detail) => ({ __fail: { status, detail } });
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const invalid = (loc, msg, type = 'value_error') => fail(422, [{ type, loc, msg }]);

// Minimal pydantic: spec = { field: { type: 'str'|'num'|'bool', required?, nullable?, min?, max?,
// pattern?, default?, ge?, le?, int? } }. Unknown keys are rejected (extra="forbid") unless allowExtra; strings are capped at 500 chars
// (str_max_length). partial=true validates only the keys present (exclude_unset). Returns
// { value } or a fail().
const checkBody = (spec, body, partial = false, allowExtra = false) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return invalid(['body'], 'Input should be a valid dictionary', 'dict_type');
  }
  const errors = [];
  const out = {};
  for (const k of Object.keys(body)) {
    if (!allowExtra && !(k in spec)) errors.push({ type: 'extra_forbidden', loc: ['body', k], msg: 'Extra inputs are not permitted' });
  }
  for (const [k, f] of Object.entries(spec)) {
    const present = Object.prototype.hasOwnProperty.call(body, k);
    if (!present) {
      if (f.required && !partial) errors.push({ type: 'missing', loc: ['body', k], msg: 'Field required' });
      else if (!partial) out[k] = f.default ?? null;
      continue;
    }
    let v = body[k];
    if (v === null) {
      if (f.nullable === false) errors.push({ type: f.type + '_type', loc: ['body', k], msg: 'Input should not be None' });
      out[k] = null;
      continue;
    }
    if (f.type === 'str') {
      if (typeof v !== 'string') { errors.push({ type: 'string_type', loc: ['body', k], msg: 'Input should be a valid string' }); continue; }
      const max = Math.min(f.max ?? 500, 500);
      if (f.min && v.length < f.min) errors.push({ type: 'string_too_short', loc: ['body', k], msg: 'String should have at least ' + f.min + ' character' + (f.min === 1 ? '' : 's') });
      if (v.length > max) errors.push({ type: 'string_too_long', loc: ['body', k], msg: 'String should have at most ' + max + ' characters' });
      if (f.pattern && !new RegExp(f.pattern).test(v)) errors.push({ type: 'string_pattern_mismatch', loc: ['body', k], msg: "String should match pattern '" + f.pattern + "'" });
    } else if (f.type === 'num') {
      if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) v = Number(v);
      if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push({ type: 'float_parsing', loc: ['body', k], msg: 'Input should be a valid number' }); continue; }
      if (f.ge !== undefined && v < f.ge) errors.push({ type: 'greater_than_equal', loc: ['body', k], msg: 'Input should be greater than or equal to ' + f.ge });
      if (f.le !== undefined && v > f.le) errors.push({ type: 'less_than_equal', loc: ['body', k], msg: 'Input should be less than or equal to ' + f.le });
      if (f.int && !Number.isInteger(v)) errors.push({ type: 'int_from_float', loc: ['body', k], msg: 'Input should be a valid integer, got a number with a fractional part' });
    } else if (f.type === 'bool') {
      if (typeof v !== 'boolean') { errors.push({ type: 'bool_parsing', loc: ['body', k], msg: 'Input should be a valid boolean' }); continue; }
    }
    out[k] = v;
  }
  return errors.length ? fail(422, errors) : { value: out };
};

// audit_log context from the webhook request (core/audit.py client_ip + user agent)
const auditCtx = (req, user) => {
  const h = req.headers || {};
  let ip = h['cf-connecting-ip'] || h['x-real-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || null;
  if (ip && !/^[0-9a-fA-F:.]{2,45}$/.test(ip)) ip = null; // only values the ::inet cast accepts
  const ua = h['user-agent'] ? String(h['user-agent']).slice(0, 500) : null;
  return { actor_id: user ? user.id : null, actor_email: user ? user.email : null, ip, user_agent: ua };
};
`;
