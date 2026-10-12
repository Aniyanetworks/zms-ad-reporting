// Build the "ZMS API · _selftest" workflow: a Manual Trigger that runs the SQL of every
// GET endpoint with sample parameters (computed by running each endpoint's own Validate
// node against a fake request) and reports which statements fail. Read-only: write
// endpoints are skipped. Postgres parses and plans the whole statement even when the
// client slug matches nothing, so unknown columns / type errors still surface.
//
//   node n8n/scripts/selftest.mjs     → writes n8n/workflows/_selftest.json
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CREDENTIALS } from "../src/lib.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows");
const req = {
  headers: {}, body: {},
  params: { slug: "selftest", client_id: "00000000-0000-0000-0000-000000000000", campaign_id: "1", adset_id: "1", service: "Roofing", platform: "meta", build_id: "00000000-0000-0000-0000-000000000000", rec_id: "1", asset_id: "1" },
  query: { start: "2026-09-01", end: "2026-09-30", date: "2026-09-30", as_of: "2026-09-30", month: "2026-09" },
};
const user = { id: "00000000-0000-0000-0000-000000000000", email: "selftest@example.com", role: "admin", full_name: null };

// Request bodies for write endpoints (by workflow file name). Writes run under EXPLAIN:
// planned and type-checked, never executed.
const BODY = {
  "clients-create": { name: "Selftest", slug: "selftest" },
  "clients-update": { name: "Selftest" },
  "service-targets-put": { service: "Selftest", platform: "meta", cpl_green: 50 },
  "recommendations-bulk-approve": { ids: [1, 2] },
};

const cases = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort()) {
  const wf = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const hook = wf.nodes.find((n) => n.name === "Webhook");
  const query = wf.nodes.find((n) => n.name === "Query");
  if (!query) continue;
  const write = hook.parameters.httpMethod !== "GET";
  req.body = BODY[f.replace(/.json$/, "")] ?? {};
  let input = null;
  const validate = wf.nodes.find((n) => n.name === "Validate");
  const $ = (name) => ({ first: () => ({ Webhook: { json: req }, "Build user": { json: { user } }, Validate: { json: { value: input } } })[name] });
  if (validate) {
    const out = await new Function("$", "$json", `return (async () => {\n${validate.parameters.jsCode}\n})();`)($, {});
    if (out[0].json.error) { console.log(`skip ${f}: sample request rejected`, out[0].json.error); continue; }
    input = out[0].json.value;
  }
  const expr = query.parameters.options?.queryReplacement;
  const params = expr ? new Function("$", `return ${expr.replace(/^=\{\{\s*/, "").replace(/\s*\}\}$/, "")};`)($) : [];
  cases.push({ name: wf.name, sql: (write ? "explain " : "") + query.parameters.query, params });
}

// Canary: must FAIL on every run, proving failures are reported.
cases.push({ name: "(canary — expected to fail)", sql: "select no_such_column from clients", params: [] });

const workflow = {
  name: "ZMS API · _selftest",
  nodes: [
    { id: "st-1", name: "Run", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} },
    { id: "st-2", name: "Cases", type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 0],
      parameters: { jsCode: `return ${JSON.stringify(cases)}.map((c) => ({ json: { name: c.name, sql: c.sql, params: JSON.stringify(c.params) } }));` } },
    { id: "st-3", name: "Execute", type: "n8n-nodes-base.postgres", typeVersion: 2.5, position: [440, 0],
      onError: "continueRegularOutput", alwaysOutputData: true,
      credentials: { postgres: CREDENTIALS.postgres },
      parameters: { operation: "executeQuery", query: "={{ $json.sql }}",
        options: { queryBatching: "independently", queryReplacement: "={{ JSON.parse($json.params) }}" } } },
    { id: "st-4", name: "Report", type: "n8n-nodes-base.code", typeVersion: 2, position: [660, 0],
      parameters: { jsCode: [
        "const cases = $('Cases').all();",
        "const by = new Map(cases.map((c, i) => [i, { name: c.json.name, ok: true, error: null }]));",
        "for (const it of $input.all()) { const i = it.json.error?.context?.itemIndex ?? (Array.isArray(it.pairedItem) ? it.pairedItem[0].item : it.pairedItem?.item); const r = by.get(i); if (r && it.json.error) { r.ok = false; r.error = it.json.error.message || JSON.stringify(it.json.error); } }",
        "const out = [...by.values()];",
        "return [{ json: { total: out.length, failed: out.filter((o) => !o.ok).length, results: out } }];",
      ].join("\n") } },
  ],
  connections: {
    Run: { main: [[{ node: "Cases", type: "main", index: 0 }]] },
    Cases: { main: [[{ node: "Execute", type: "main", index: 0 }]] },
    Execute: { main: [[{ node: "Report", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1" },
};
writeFileSync(join(dir, "_selftest.json"), JSON.stringify(workflow, null, 2) + "\n");
console.log(`selftest: ${cases.length} queries (writes under EXPLAIN)`);
