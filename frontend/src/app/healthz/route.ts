import { NextResponse } from "next/server";

// Liveness probe for the Next.js container (compose `healthcheck:` + deploy
// health gate). It also calls the API THROUGH THIS CONTAINER'S OWN /api rewrite:
// after an API redeploy the Next proxy kept dialling the old container IP
// (ECONNREFUSED 172.19.0.3:8000, 2026-09-25 — the dashboard showed "Failed to load
// overview: 500" while both containers reported healthy). A 503 here makes that
// visible to compose / the deploy gate instead of silently breaking every page.
export const dynamic = "force-dynamic";

export async function GET() {
  const base = { service: "web", version: process.env.NEXT_PUBLIC_GIT_SHA ?? "dev" };
  const headers = { "Cache-Control": "no-store" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/health`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    // 200 = deep checks fine, 503 = API up but db/redis degraded — either way the
    // proxy path works. Only a transport failure means this container is the problem.
    return NextResponse.json({ status: "ok", api_via_proxy: res.status, ...base }, { headers });
  } catch (e) {
    return NextResponse.json(
      { status: "degraded", reason: `api unreachable via proxy: ${(e as Error).message}`, ...base },
      { status: 503, headers },
    );
  }
}
