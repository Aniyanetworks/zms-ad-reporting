import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { destinationFor } from "@/lib/auth-redirect";

// Landing route for Supabase Auth email links (invite, password recovery,
// magic link). Supabase redirects `{{ .ConfirmationURL }}` here.
//
// OPS NOTE (Supabase Dashboard → Authentication → URL Configuration → Redirect
// URLs): the allow-list MUST include
//   https://adbuildout.contractorscalingblueprint.com/auth/callback
//   https://staging-adbuildout.contractorscalingblueprint.com/auth/callback
//   https://ads.contractorscalingblueprint.com/auth/callback   (legacy host)
//   http://localhost:3010/auth/callback                        (local dev)
// and the Site URL should be the production origin. With those in place the
// default email templates' {{ .ConfirmationURL }} lands on this route.
//
// Two flows arrive here:
//  1. PKCE: `?code=...` — exchanged server-side for a session cookie below.
//  2. Implicit: tokens in the URL *fragment* (#access_token=...), which never
//     reaches the server. We 302 to /auth/complete (a client page); browsers
//     preserve the fragment across the redirect and the page calls setSession.
//
// Where to go afterwards: `next` if it is a same-origin path, else
// /set-password for invite/recovery (the user has no usable password yet),
// else /.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const type = url.searchParams.get("type");
  const next = url.searchParams.get("next");
  const dest = destinationFor(type, next);

  // Supabase reports link errors (expired, already used) as query params.
  const linkError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (linkError && !code) {
    return NextResponse.redirect(loginWithError(url, linkError));
  }

  if (!code) {
    // Implicit flow: hand off to the client page, keeping type/next.
    const complete = url.clone();
    complete.pathname = "/auth/complete";
    complete.search = "";
    if (type) complete.searchParams.set("type", type);
    if (next) complete.searchParams.set("next", next);
    return NextResponse.redirect(complete);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(loginWithError(url, error.message));
  }

  const target = url.clone();
  target.pathname = dest.split("?")[0];
  target.search = dest.includes("?") ? dest.slice(dest.indexOf("?")) : "";
  return NextResponse.redirect(target);
}

function loginWithError(base: URL, message: string): URL {
  const url = new URL(base);
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("error", message.slice(0, 160));
  return url;
}
