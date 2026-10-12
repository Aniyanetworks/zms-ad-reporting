# Remote MCP server (mcp.contractorscalingblueprint.com)

**Status: DEFERRED.** Decision 2026-09-16: the DNS name `mcp.contractorscalingblueprint.com` is
reserved, nothing is deployed, and no work starts before the prerequisites below are met.
Today the Claude Code plugin talks to the dashboard over `https://…/api/plugin/*` with a shared
bearer token from each operator's own machine (`~/zeal-paid-ads/docs/TEAM_HANDOFF.md`). That
remains the supported path.

## Why later, not now

- The shared `PLUGIN_API_TOKEN` is acceptable for a few known operators running Claude Code
  locally. A remote MCP endpoint is reachable by anyone on the internet, so it needs per-user
  identity, OAuth, and its own hardening before it exists at all.
- The human-control rules (approval by a signed-in person, PAUSED objects, owner-only large
  budgets) must be enforced by the same server-side policy, not re-implemented in a new service.

## Target design

```
Claude (claude.ai / Claude Code)  --OAuth 2.1 + PKCE-->  Cloudflare edge  --tunnel b9929fe5-->
Mac mini: container zms-ads-mcp (127.0.0.1:3020)  --same FastAPI services + policy.py-->  Supabase
```

| Aspect | Design |
|---|---|
| Hostname | `mcp.contractorscalingblueprint.com`, CNAME to `b9929fe5-4b97-4708-acdb-734c224430e5.cfargotunnel.com`, proxied; tunnel ingress -> `http://localhost:3020` |
| Process | separate container in the production compose project (`mcp` service), same api image or a thin image importing `app.services` and `app.core.policy`; never the api container itself |
| Transport | Streamable HTTP MCP, TLS at Cloudflare only |
| Authentication | OAuth 2.1 with PKCE. Option A: Supabase Auth as the identity provider (the dashboard's users, same MFA); Option B: Cloudflare Access service tokens for machine clients. Never API keys in URLs |
| Authorization | each token maps to one `auth.users.id`; role read from `profiles.role` on every call, same as `security.get_current_user()` |
| Tool surface | **read + propose only**: list clients, scorecard, portfolio, metrics, recommendations, propose recommendation, record triage run, dismiss own proposals. **Never** approve, never execute, never `activate`, never write to Meta/Google/GHL |
| Policy | import `app.core.policy`; MCP has no code path to `status='approved'`; add tests mirroring `test_plugin_transitions.py` |
| Rate limits | Cloudflare rule on the host + slowapi keyed on user id (not IP): e.g. 60 tool calls / min / user |
| Audit | every tool call writes `audit_log` with `actor_type='user'`, `actor_id` = the OAuth user, `action='mcp.<tool>'`, plus the request id |
| Secrets | the MCP container gets `SUPABASE_URL`, a service-role key scoped as today, and nothing from Meta/Google/GHL; it cannot reach ad platforms |
| Callback | `https://mcp.contractorscalingblueprint.com/oauth/callback` (DEPLOYMENT_PLAN section 4) |
| Health | `GET /healthz` on the container, included in `scripts/health.sh` and the uptime monitor |

## Hard rules

1. **Never an unauthenticated MCP endpoint.** No anonymous tools, not even read-only, not even
   "temporarily". If OAuth is not finished the hostname stays unrouted (404 from the tunnel).
2. Approval and execution stay in the dashboard (signed-in person) and in the operator's local
   `/execute`. The remote server proposes; people decide.
3. Same `policy.py`, same `audit_log`, same role source (`profiles`). No second permission model.
4. Per-user tokens only; revoking a user in Supabase must cut their MCP access within one token
   lifetime (keep access tokens short, 15 min, refresh with rotation).
5. Staging first: `staging-mcp.` behind Cloudflare Access before any production hostname.

## Prerequisites before building

- [ ] Phases 1 to 4 of `DEPLOYMENT_PLAN.md` complete: RBAC live, audit log live, staging exists,
      CI/CD deploys, backups and uptime alerts running.
- [ ] Supabase Auth hardening applied (invite-only, 12-char passwords, MFA available), and MFA
      enrolled for every account that will get MCP tokens.
- [ ] Decision by Carl: identity provider (Supabase Auth vs Cloudflare Access) and who gets access.
- [ ] Written tool list reviewed against the human-control rules (read + propose only).
- [ ] Cloudflare: Access application or WAF rule on `mcp.` limiting to expected clients; rate rule
      (Free plan allows one rate-limiting rule; combine with the existing `/api/*` rule expression
      or upgrade the plan).
- [ ] Threat review: token theft, prompt injection via ad names / GHL notes (treat as data),
      replay, and denial of service against the home connection.
- [ ] Uptime monitor and `scripts/health.sh` extended with the new container.
- [ ] Docs: `REMOTE_MCP.md` rewritten as an operating guide; `CREDENTIALS_CHECKLIST.md` updated
      with the OAuth client secret and its rotation.

Until every box is ticked, this document is the only deliverable for `mcp.`.
