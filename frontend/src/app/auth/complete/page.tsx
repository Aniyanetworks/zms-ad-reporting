"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { destinationFor } from "@/lib/auth-redirect";

// Second half of /auth/callback for the implicit flow: the tokens live in the
// URL fragment, which only the browser can read. Sets the session cookie via
// supabase-js, then routes exactly like the server callback does.
export default function AuthCompletePage() {
  return (
    <Suspense fallback={null}>
      <AuthComplete />
    </Suspense>
  );
}

function AuthComplete() {
  const router = useRouter();
  const params = useSearchParams();
  const [message, setMessage] = useState("Signing you in…");

  useEffect(() => {
    const type = params.get("type");
    const next = params.get("next");

    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const hashError = hash.get("error_description") ?? hash.get("error");
    const accessToken = hash.get("access_token");
    const refreshToken = hash.get("refresh_token");
    const hashType = hash.get("type");

    (async () => {
      if (hashError) {
        router.replace(`/login?error=${encodeURIComponent(hashError)}`);
        return;
      }
      const supabase = createClient();
      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        if (error) {
          router.replace(`/login?error=${encodeURIComponent(error.message)}`);
          return;
        }
        // Clear the tokens from the address bar / history before moving on.
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } else {
        // No tokens at all — maybe the session already exists (link clicked twice).
        const { data } = await supabase.auth.getSession();
        if (!data.session) {
          router.replace("/login?error=" + encodeURIComponent("Sign-in link is invalid or has expired."));
          return;
        }
      }
      setMessage("Redirecting…");
      router.replace(destinationFor(type ?? hashType, next));
      router.refresh();
    })();
  }, [params, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">ZMS Ads Intelligence</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  );
}
