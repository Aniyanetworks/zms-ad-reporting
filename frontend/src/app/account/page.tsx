"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import type { Factor } from "@supabase/supabase-js";
import { Nav } from "@/components/nav";
import { PasswordForm } from "@/components/password-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { useMe } from "@/lib/me";
import { ROLE_LABELS } from "@/lib/permissions";

export default function AccountPage() {
  const { data: me, isLoading } = useMe();

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Signed in as</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading || !me ? (
              <Skeleton className="h-6 w-64" />
            ) : (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium">{me.email ?? me.id}</span>
                {me.full_name && <span className="text-muted-foreground">{me.full_name}</span>}
                <Badge variant="outline">{ROLE_LABELS[me.role] ?? me.role}</Badge>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Change password</CardTitle>
            <CardDescription>Takes effect immediately; other sessions stay signed in until they expire.</CardDescription>
          </CardHeader>
          <CardContent className="max-w-sm">
            <PasswordForm submitLabel="Change password" />
          </CardContent>
        </Card>

        <MfaCard />
      </main>
    </div>
  );
}

/** TOTP two-factor: list / enrol / verify / remove via supabase-js MFA. */
function MfaCard() {
  const qc = useQueryClient();
  const supabase = createClient();
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // Enrolment in progress (unverified factor + QR) until verify succeeds.
  const [pending, setPending] = useState<{ id: string; qr: string; secret: string } | null>(null);

  const factors = useQuery({
    queryKey: ["mfa-factors"],
    queryFn: async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      return data;
    },
  });

  const enroll = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Authenticator app" });
      if (error) throw error;
      return data;
    },
    onMutate: () => setError(null),
    onSuccess: (data) => setPending({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret }),
    onError: (e) => setError((e as Error).message),
  });

  const verify = useMutation({
    mutationFn: async ({ factorId, code }: { factorId: string; code: string }) => {
      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
      if (chErr) throw chErr;
      const { error } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code });
      if (error) throw error;
    },
    onMutate: () => setError(null),
    onSuccess: () => {
      setPending(null);
      setCode("");
      qc.invalidateQueries({ queryKey: ["mfa-factors"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const unenroll = useMutation({
    mutationFn: async (factorId: string) => {
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      if (error) throw error;
    },
    onMutate: () => setError(null),
    onSuccess: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: ["mfa-factors"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const all: Factor[] = factors.data?.all ?? [];
  const verified = all.filter((f) => f.status === "verified");
  // Unverified leftovers from abandoned enrolments (Supabase keeps them around).
  const stale = all.filter((f) => f.status !== "verified" && f.id !== pending?.id);
  const busy = enroll.isPending || verify.isPending || unenroll.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {verified.length > 0 ? (
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
          ) : (
            <ShieldOff className="h-4 w-4 text-muted-foreground" />
          )}
          Two-factor authentication (TOTP)
        </CardTitle>
        <CardDescription>
          Use an authenticator app (1Password, Google Authenticator, Authy). Required for the Agency Owner.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {factors.isLoading && <Skeleton className="h-10" />}
        {factors.error && <p className="text-sm text-destructive">{(factors.error as Error).message}</p>}

        {verified.map((f) => (
          <div key={f.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
            <div className="flex items-center gap-2">
              <Badge className="bg-emerald-500/15 text-emerald-400">enabled</Badge>
              <span className="font-medium">{f.friendly_name || "Authenticator app"}</span>
              <span className="text-xs text-muted-foreground">
                added {new Date(f.created_at).toLocaleDateString()}
              </span>
            </div>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => unenroll.mutate(f.id)}>
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          </div>
        ))}

        {stale.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {stale.length} unfinished enrolment{stale.length > 1 ? "s" : ""} —{" "}
            <button type="button" className="underline" disabled={busy} onClick={() => stale.forEach((f) => unenroll.mutate(f.id))}>
              clean up
            </button>
          </p>
        )}

        {pending ? (
          <div className="space-y-3 rounded-md border p-4">
            <p className="text-sm">1. Scan this QR code with your authenticator app.</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- data URI SVG from Supabase */}
            <img src={pending.qr} alt="TOTP QR code" className="h-44 w-44 rounded bg-white p-2" />
            <p className="text-xs text-muted-foreground">
              Can&apos;t scan? Enter this key manually:{" "}
              <code className="select-all rounded bg-muted px-1 py-0.5 font-mono text-foreground">{pending.secret}</code>
            </p>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                verify.mutate({ factorId: pending.id, code: code.trim() });
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="totp-code">2. Enter the 6-digit code</Label>
                <Input
                  id="totp-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className="w-32 font-mono tracking-widest"
                />
              </div>
              <Button type="submit" size="sm" disabled={busy || code.length !== 6}>
                {verify.isPending ? "Verifying…" : "Verify & enable"}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => unenroll.mutate(pending.id)}>
                Cancel
              </Button>
            </form>
          </div>
        ) : (
          !factors.isLoading && (
            <Button size="sm" variant={verified.length ? "outline" : "default"} disabled={busy} onClick={() => enroll.mutate()}>
              {enroll.isPending ? "Starting…" : verified.length ? "Add another device" : "Enrol authenticator app"}
            </Button>
          )
        )}

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </CardContent>
    </Card>
  );
}
