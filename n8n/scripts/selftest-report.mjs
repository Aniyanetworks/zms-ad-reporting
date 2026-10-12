// Summarise a _selftest execution: node n8n/scripts/selftest-report.mjs <executionId>
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const out = execFileSync("node", [join(here, "execution.mjs"), process.argv[2], "Report"], { encoding: "utf8" });
const r = JSON.parse(out.slice(out.indexOf("\n") + 1))[0];
console.log(`total ${r.total}, failed ${r.failed} (1 expected: the canary)`);
for (const x of r.results) if (!x.ok) {
  let msg = x.error; try { const e = JSON.parse(x.error); msg = e.description || e.message || x.error; } catch {}
  console.log("FAIL", x.name, "\n     ", String(msg).slice(0, 400));
}
