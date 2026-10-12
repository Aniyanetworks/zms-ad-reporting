// Print the last node's output (or the error) of an n8n execution.
//   node n8n/scripts/execution.mjs <executionId> [nodeName]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const base = env.N8N_URL.replace(/\/+$/, "");
const [id, nodeName] = process.argv.slice(2);

let ex;
for (let i = 0; i < 30; i++) {
  const r = await fetch(`${base}/api/v1/executions/${id}?includeData=true`, { headers: { "X-N8N-API-KEY": env.N8N_API_KEY } });
  ex = await r.json();
  if (ex.finished || ex.stoppedAt || ex.status === "error" || ex.status === "success") break;
  await new Promise((res) => setTimeout(res, 2000));
}
const run = ex.data?.resultData;
if (run?.error) console.log("EXECUTION ERROR:", run.error.message, run.error.node?.name ?? "");
const runs = run?.runData ?? {};
const name = nodeName ?? run?.lastNodeExecuted;
const out = runs[name]?.[0]?.data?.main?.[0]?.map((i) => i.json) ?? runs[name]?.[0]?.error;
console.log(`status=${ex.status} node=${name}`);
console.log(JSON.stringify(out, null, 2));
