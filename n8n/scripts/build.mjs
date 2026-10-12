// Generate n8n/workflows/*.json from the endpoint definitions in n8n/src/endpoints/.
//   node n8n/scripts/build.mjs
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { endpoint } from "../src/lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src", "endpoints");
const outDir = join(root, "workflows");
mkdirSync(outDir, { recursive: true });

let count = 0;
for (const f of readdirSync(srcDir).filter((f) => f.endsWith(".mjs")).sort()) {
  const defs = (await import(pathToFileURL(join(srcDir, f)).href)).default;
  for (const def of defs) {
    writeFileSync(join(outDir, `${def.file}.json`), JSON.stringify(endpoint(def), null, 2) + "\n");
    count++;
  }
}
console.log(`built ${count} workflows into n8n/workflows/`);
