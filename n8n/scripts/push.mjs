// Create or update n8n workflows from n8n/workflows/*.json through the n8n public API,
// then activate them. Matching is by workflow name, so files are the source of truth.
//
//   node n8n/scripts/push.mjs                 # all workflows
//   node n8n/scripts/push.mjs health-live     # only files whose name contains "health-live"
//
// Reads N8N_URL and N8N_API_KEY from n8n/.env (gitignored). The public API cannot set
// folders; new workflows are listed at the end so they can be moved into the
// "ZMS API" folder from the n8n UI (or the in-app API).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const base = (env.N8N_URL || "").replace(/\/+$/, "");
if (!base || !env.N8N_API_KEY) throw new Error("N8N_URL and N8N_API_KEY must be set in n8n/.env");

async function api(method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "X-N8N-API-KEY": env.N8N_API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.message ?? text}`);
  return data;
}

async function existingByName() {
  const byName = new Map();
  let cursor;
  do {
    const q = `/workflows?limit=250&excludePinnedData=true${cursor ? `&cursor=${cursor}` : ""}`;
    const page = await api("GET", q);
    for (const w of page.data) if (w.name.startsWith("ZMS API")) byName.set(w.name, w);
    cursor = page.nextCursor;
  } while (cursor);
  return byName;
}

const filter = process.argv[2] ?? "";
const dir = join(root, "workflows");
const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f.includes(filter)).sort();
const existing = await existingByName();
const created = [];

for (const file of files) {
  const wf = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings ?? {} };
  const prev = existing.get(wf.name);
  const saved = prev ? await api("PUT", `/workflows/${prev.id}`, body) : await api("POST", "/workflows", body);
  if (!prev) created.push(saved);
  const hasTrigger = wf.nodes.some((n) => /webhook|scheduleTrigger|cron/i.test(n.type));
  if (hasTrigger) await api("POST", `/workflows/${saved.id}/activate`);
  console.log(`${prev ? "updated" : "created"}  ${saved.id}  ${wf.name}${hasTrigger ? "  (active)" : ""}`);
}

if (created.length) {
  console.log("\nNew workflows to move into the ZMS API folder:");
  for (const w of created) console.log(`  ${w.id}  ${w.name}`);
}
