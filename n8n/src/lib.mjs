// Builds n8n workflow JSON for one API endpoint from a small definition.
//
// Every endpoint workflow has the same skeleton:
//   Webhook → [auth chain] → [Query (Postgres, returns one row: { data })] → Shape (Code) → Respond
// The auth chain mirrors backend/app/core/security.py: Bearer token → JWT verify against
// the Supabase project's public key (ES256) → profiles.role → 401 / 403 with FastAPI's
// {"detail": ...} body. SQL builds the JSON in Postgres (json_agg / to_json) so numbers
// and timestamps serialize the way FastAPI's encoder did.
import { createHash } from "node:crypto";
import { HELPERS } from "./helpers.mjs";

export const CREDENTIALS = {
  postgres: { id: "UmpkC3NkKcg32kNA", name: "ZMS Supabase Postgres" },
  jwt: { id: "VO3CX2JfTZ8fKIez", name: "ZMS Supabase JWT (public key)" },
};

export const ROLES = ["admin", "media_buyer", "viewer"];

// Frontend API_URL = https://<n8n>/webhook/zms  (Next rewrites /api/* → ${API_URL}/api/*)
export const WEBHOOK_PREFIX = "zms";

const uuid = (seed) => {
  const h = createHash("sha1").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const ifTrue = (expr) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
    conditions: [
      {
        id: uuid(expr),
        leftValue: `={{ ${expr} }}`,
        rightValue: "",
        operator: { type: "boolean", operation: "true", singleValue: true },
      },
    ],
    combinator: "and",
  },
  options: {},
});

const jsonResponse = (bodyExpr, statusExpr) => ({
  respondWith: "text",
  responseBody: `={{ ${bodyExpr} === undefined ? '' : JSON.stringify(${bodyExpr}) }}`,
  options: {
    responseCode: `={{ ${statusExpr} }}`,
    responseHeaders: {
      entries: [
        { name: "Content-Type", value: "application/json" },
        { name: "Cache-Control", value: "no-store" },
      ],
    },
  },
});

/**
 * @param {object} def
 * @param {string} def.method   GET | POST | PUT | PATCH | DELETE
 * @param {string} def.path     e.g. "/api/clients/:slug/campaigns"
 * @param {"none"|"user"|string[]} def.auth   "user" = any signed-in user; array = allowed roles
 * @param {string} [def.sql]    must return exactly one row with a `data` column
 * @param {string} [def.params] JS array expression for $1..$n, e.g. "[$('Webhook').first().json.params.slug]"
 * @param {string} def.shape    Code-node body. In scope: data, user, req (webhook item json).
 *                              Must `return { status?, body }`.
 * @param {string} [def.onDbError] Code-node body run when the query fails; same return shape.
 * @param {string} [def.validate] Code-node body run before the query. In scope: user, req and
 *                              the helpers. Return fail(status, detail) / invalid(...) to reject;
 *                              any other return value is exposed to SQL params and Shape as `input`
 *                              ($('Validate').first().json.value).
 */
export function endpoint(def) {
  const name = `ZMS API · ${def.method} ${def.path.replace(/:(\w+)/g, "{$1}")}`;
  const nodes = [];
  const connections = {};
  const link = (from, to, output = 0) => {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= output) connections[from].main.push([]);
    connections[from].main[output].push({ node: to, type: "main", index: 0 });
  };
  let x = 0;
  const add = (node, dy = 0) => {
    nodes.push({ id: uuid(`${name}/${node.name}`), position: [x, dy], ...node });
    x += 220;
    return node.name;
  };

  const webhook = add({
    name: "Webhook",
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    // n8n serves webhooks with :params at /webhook/<webhookId>/<path>. Sharing one webhookId and
    // prefixing static paths with the same segment puts every endpoint under /webhook/zms/api/...
    webhookId: WEBHOOK_PREFIX,
    parameters: {
      httpMethod: def.method,
      path: /:\w+/.test(def.path) ? def.path.replace(/^\//, "") : `${WEBHOOK_PREFIX}${def.path}`,
      responseMode: "responseNode",
      options: {},
    },
  });

  const respondError = {
    name: "Respond error",
    type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1.1,
    parameters: jsonResponse("{ detail: $json.error.detail }", "$json.error.status"),
  };

  let last = webhook;
  if (def.auth !== "none") {
    const allowed = Array.isArray(def.auth) ? def.auth : null;
    const forbidden = allowed
      ? allowed.length === 1 && allowed[0] === "admin"
        ? "Admin role required"
        : `Requires one of roles: ${allowed.join(", ")}`
      : "";

    const readToken = add({
      name: "Read token",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      parameters: {
        jsCode: [
          "const m = /^Bearer\\s+(.+)$/i.exec(($json.headers || {}).authorization || '');",
          "return [{ json: m ? { token: m[1].trim() } : { error: { status: 401, detail: 'Missing token' } } }];",
        ].join("\n"),
      },
    });
    link(last, readToken);

    const hasToken = add({ name: "Has token?", type: "n8n-nodes-base.if", typeVersion: 2, parameters: ifTrue("!$json.error") });
    link(readToken, hasToken);

    const verify = add({
      name: "Verify JWT",
      type: "n8n-nodes-base.jwt",
      typeVersion: 1,
      onError: "continueErrorOutput",
      credentials: { jwtAuth: CREDENTIALS.jwt },
      parameters: { operation: "verify", token: "={{ $json.token }}", options: {} },
    });
    link(hasToken, verify, 0);

    const tokenError = add(
      {
        name: "Token error",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        parameters: {
          jsCode: [
            "const e = $json.error;",
            "const msg = (e && (e.message || e.description)) || (typeof e === 'string' ? e : 'invalid token');",
            "return [{ json: { error: { status: 401, detail: `Invalid token: ${msg}` } } }];",
          ].join("\n"),
        },
      },
      200,
    );
    link(verify, tokenError, 1);

    const profile = add({
      name: "Load profile",
      type: "n8n-nodes-base.postgres",
      typeVersion: 2.5,
      credentials: { postgres: CREDENTIALS.postgres },
      parameters: {
        operation: "executeQuery",
        query:
          "select coalesce((select to_jsonb(p) from (select role, full_name from profiles where id = $1::uuid) p), '{}'::jsonb) as profile",
        options: { queryReplacement: "={{ [($json.payload ?? $json).sub] }}" },
      },
    });
    link(verify, profile, 0);

    const buildUser = add({
      name: "Build user",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      parameters: {
        jsCode: [
          "const v = $('Verify JWT').first().json;",
          "const claims = v.payload ?? v;",
          "const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];",
          "if (!aud.includes('authenticated')) return [{ json: { error: { status: 401, detail: 'Invalid token: Invalid audience' } } }];",
          "const p = $json.profile || {};",
          `const role = ${JSON.stringify(ROLES)}.includes(p.role) ? p.role : 'viewer';`,
          "const user = { id: claims.sub, email: claims.email ?? null, role, full_name: p.full_name ?? null };",
          allowed
            ? `if (!${JSON.stringify(allowed)}.includes(role)) return [{ json: { error: { status: 403, detail: ${JSON.stringify(forbidden)} } } }];`
            : "",
          "return [{ json: { user } }];",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    });
    link(profile, buildUser);

    const authorized = add({ name: "Authorized?", type: "n8n-nodes-base.if", typeVersion: 2, parameters: ifTrue("!$json.error") });
    link(buildUser, authorized);

    // Every failing branch converges on one error responder.
    nodes.push({ id: uuid(`${name}/${respondError.name}`), position: [x, 300], ...respondError });
    link(hasToken, respondError.name, 1);
    link(tokenError, respondError.name);
    link(authorized, respondError.name, 1);
    last = authorized;
  }

  const userExpr = def.auth === "none" ? "null" : "$('Build user').first().json.user";
  const prelude = [
    HELPERS.trim(),
    ...(def.libs || []).map((l) => l.trim()),
    "const req = $('Webhook').first().json;",
    `const user = ${userExpr};`,
  ];

  if (def.validate) {
    if (!nodes.some((n) => n.name === respondError.name)) {
      nodes.push({ id: uuid(`${name}/${respondError.name}`), position: [x, 300], ...respondError });
    }
    const validate = add({
      name: "Validate",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      parameters: {
        jsCode: [...prelude, def.validate]
          .join("\n")
          .replace(/^/, "const r = (() => {\n")
          .concat("\n})();\nreturn [{ json: r && r.__fail ? { error: r.__fail } : { value: r ?? null } }];"),
      },
    });
    link(last, validate, 0);
    const valid = add({ name: "Valid?", type: "n8n-nodes-base.if", typeVersion: 2, parameters: ifTrue("!$json.error") });
    link(validate, valid);
    link(valid, respondError.name, 1);
    last = valid;
    prelude.push("const input = $('Validate').first().json.value;");
  }

  let shapeInput = last;
  let dbErrorNode;
  if (def.sql) {
    const query = add({
      name: "Query",
      type: "n8n-nodes-base.postgres",
      typeVersion: 2.5,
      onError: "continueErrorOutput",
      credentials: { postgres: CREDENTIALS.postgres },
      parameters: {
        operation: "executeQuery",
        query: def.sql.trim(),
        options: def.params ? { queryReplacement: `={{ ${def.params} }}` } : {},
      },
    });
    link(last, query, 0);

    const dbError = add(
      {
        name: "DB error",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        parameters: {
          jsCode: [
            ...prelude,
            "const err = $json.error;",
            def.onDbError ?? "return { status: 500, body: { detail: 'Internal Server Error' } };",
          ]
            .join("\n")
            .replace(/^/, "const out = (() => {\n")
            .concat("\n})();\nreturn [{ json: out }];"),
        },
      },
      200,
    );
    link(query, dbError, 1);
    shapeInput = query;
    dbErrorNode = dbError;
  }

  const shape = add({
    name: "Shape",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    parameters: {
      jsCode: [...prelude, def.sql ? "const data = $json.data;" : "const data = null;", def.shape]
        .join("\n")
        .replace(/^/, "const out = (() => {\n")
        .concat("\n})();\nreturn [{ json: out }];"),
    },
  });
  link(shapeInput, shape, 0);

  const respond = add({
    name: "Respond",
    type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1.1,
    parameters: jsonResponse("$json.body", "$json.status ?? 200"),
  });
  link(shape, respond);
  if (def.sql) link(dbErrorNode, respond);

  return {
    name,
    nodes,
    connections,
    settings: { executionOrder: "v1", saveDataSuccessExecution: "none", saveDataErrorExecution: "all" },
  };
}
