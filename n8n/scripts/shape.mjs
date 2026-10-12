// Run a generated workflow's "Shape" Code node locally with fixture data — catches runtime
// errors (undefined names, bad field access) before anything reaches n8n.
//
//   import { runShape } from "./shape.mjs";
//   const out = await runShape("today", { data, req, user, input });
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows");

export async function runShape(file, { data = null, req = { headers: {}, query: {}, params: {}, body: {} }, user = null, input = null, node = "Shape" } = {}) {
  const wf = JSON.parse(readFileSync(join(dir, `${file}.json`), "utf8"));
  const code = wf.nodes.find((n) => n.name === node).parameters.jsCode;
  const items = {
    Webhook: { json: req },
    "Build user": { json: { user } },
    Validate: { json: { value: input } },
  };
  const $ = (name) => ({ first: () => items[name], all: () => [items[name]] });
  const fn = new Function("$", "$json", `return (async () => {\n${code}\n})();`);
  const out = await fn($, { data });
  return out[0].json;
}
