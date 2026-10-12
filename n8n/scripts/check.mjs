// Compile every Code node of every generated workflow (syntax check before pushing).
//   node n8n/scripts/check.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows");
let bad = 0, n = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const wf = JSON.parse(readFileSync(join(dir, f), "utf8"));
  for (const node of wf.nodes.filter((x) => x.type === "n8n-nodes-base.code")) {
    n++;
    try {
      // n8n runs Code-node bodies inside an async function.
      new Function("$", "$json", "$input", `return (async () => {\n${node.parameters.jsCode}\n})();`);
    } catch (e) {
      bad++;
      console.log(`${f} › ${node.name}: ${e.message}`);
    }
  }
}
console.log(`${n} code nodes checked, ${bad} with syntax errors`);
process.exit(bad ? 1 : 0);
