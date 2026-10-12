"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_RULE_TEXT, passwordPairError } from "@/lib/password";

/** New password + confirm → supabase.auth.updateUser. Shared by /set-password and /account. */
export function PasswordForm({
  submitLabel = "Save password",
  onSaved,
}: {
  submitLabel?: string;
  onSaved?: () => void | Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    const ruleError = passwordPairError(password, confirm);
    if (ruleError) {
      setError(ruleError);
      return;
    }
    setError(null);
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setPassword("");
    setConfirm("");
    setSaved(true);
    await onSaved?.();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-password">Confirm password</Label>
        <Input
          id="confirm-password"
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">{PASSWORD_RULE_TEXT}</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && !error && <p className="text-sm text-emerald-400">Password updated.</p>}
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
