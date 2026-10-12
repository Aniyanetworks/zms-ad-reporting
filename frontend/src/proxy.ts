import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Hostname that serves ONLY the public setter leaderboard (no login). Set via
// LEADERBOARD_HOST in docker-compose; the same Next.js container answers both
// hostnames and the Cloudflare tunnel routes both to it.
const LEADERBOARD_HOST = (process.env.LEADERBOARD_HOST ?? "setter.contractorscalingblueprint.com").toLowerCase();

// Refresh the Supabase session cookie and gate all pages behind auth —
// except /leaderboard, which is a view-only shared page for the setters.
export default async function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").split(":")[0].toLowerCase();
  const path = request.nextUrl.pathname;

  // Liveness probe — answered on every hostname, never gated behind auth.
  if (path === "/healthz") return NextResponse.next();

  if (host === LEADERBOARD_HOST) {
    if (path === "/") {
      const url = request.nextUrl.clone();
      url.pathname = "/leaderboard";
      return NextResponse.rewrite(url);
    }
    if (path.startsWith("/leaderboard")) return NextResponse.next();
    // Nothing else exists on this hostname (the internal dashboard stays on ads.*).
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (path.startsWith("/leaderboard")) return NextResponse.next();
  // Auth email links (invite / recovery) arrive here with no session yet; the
  // route + page set the cookie themselves. /set-password is NOT exempt — it
  // needs the session those routes create, so it stays behind the login gate.
  if (path.startsWith("/auth/")) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isLoginPage = request.nextUrl.pathname.startsWith("/login");
  // Carl 2026-09-25: the reporting pages are public (read-only) for anyone with the
  // domain. Only pages that write — settings, campaign builder, account — still need a
  // signed-in user; the API refuses writes from the anonymous viewer regardless.
  const needsLogin = ["/settings", "/build", "/account", "/set-password"].some((p) => path.startsWith(p));
  if (!user && !isLoginPage && needsLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  if (user && isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Everything except Next internals, static assets, the liveness probe, and
  // the API proxy (the FastAPI backend does its own JWT verification).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|healthz|api/).*)"],
};
