"use client";

import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordForm } from "@/components/password-form";

// Where invite and password-recovery links land after /auth/callback. Requires
// a session (the proxy redirects to /login otherwise).
export default function SetPasswordPage() {
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Set your password</CardTitle>
          <CardDescription>Choose the password you will use to sign in to ZMS Ads Intelligence.</CardDescription>
        </CardHeader>
        <CardContent>
          <PasswordForm
            submitLabel="Set password and continue"
            onSaved={() => {
              router.push("/");
              router.refresh();
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
