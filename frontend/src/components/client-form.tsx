"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Client } from "@/lib/api";

export interface ClientFormValues {
  name: string;
  slug: string;
  meta_ad_account_id: string | null;
  meta_pixel_id?: string | null;
  google_ads_customer_id: string | null;
  google_lsa_customer_id: string | null;
  ghl_location_id: string | null;
  ghl_token: string | null;
  cpl_target_green: number;
  avg_job_value: number | null;
  close_rate: number | null;
  gross_margin_pct: number | null;
  max_ad_cost_share: number | null;
  setter_fee_per_appt: number | null;
  cpl_target_red: number;
  is_active: boolean;
}

export function ClientFormDialog({
  client,
  trigger,
  onSubmit,
}: {
  client?: Client;
  trigger: React.ReactNode;
  onSubmit: (values: ClientFormValues) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const values: ClientFormValues = {
      name: String(fd.get("name") ?? "").trim(),
      slug: String(fd.get("slug") ?? "").trim().toLowerCase(),
      meta_ad_account_id: String(fd.get("meta_ad_account_id") ?? "").trim() || null,
      meta_pixel_id: String(fd.get("meta_pixel_id") ?? "").replace(/\D/g, "") || null,
      google_ads_customer_id: String(fd.get("google_ads_customer_id") ?? "").trim() || null,
      google_lsa_customer_id: String(fd.get("google_lsa_customer_id") ?? "").trim() || null,
      ghl_location_id: String(fd.get("ghl_location_id") ?? "").trim() || null,
      ghl_token: String(fd.get("ghl_token") ?? "").trim() || null,
      cpl_target_green: Number(fd.get("cpl_target_green") ?? 75),
      avg_job_value: String(fd.get("avg_job_value") ?? "").trim() === "" ? null : Number(fd.get("avg_job_value")),
      close_rate: String(fd.get("close_rate") ?? "").trim() === "" ? null : Number(fd.get("close_rate")) / 100,
      gross_margin_pct: String(fd.get("gross_margin_pct") ?? "").trim() === "" ? null : Number(fd.get("gross_margin_pct")) / 100,
      max_ad_cost_share: String(fd.get("max_ad_cost_share") ?? "").trim() === "" ? null : Number(fd.get("max_ad_cost_share")) / 100,
      setter_fee_per_appt: String(fd.get("setter_fee_per_appt") ?? "").trim() === "" ? null : Number(fd.get("setter_fee_per_appt")),
      cpl_target_red: Number(fd.get("cpl_target_red") ?? 150),
      is_active: fd.get("is_active") === "on",
    };
    setSaving(true);
    setError(null);
    try {
      await onSubmit(values);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{client ? `Edit ${client.name}` : "Add client"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" required defaultValue={client?.name ?? ""} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="slug">Slug</Label>
            <Input
              id="slug"
              name="slug"
              required
              pattern="[a-z0-9-]+"
              placeholder="acme-plumbing"
              defaultValue={client?.slug ?? ""}
              disabled={!!client}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meta_ad_account_id">Meta Ad Account ID</Label>
            <Input
              id="meta_ad_account_id"
              name="meta_ad_account_id"
              placeholder="act_1234567890"
              defaultValue={client?.meta_ad_account_id ?? ""}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meta_pixel_id">Meta Pixel / Dataset ID</Label>
            <Input
              id="meta_pixel_id"
              name="meta_pixel_id"
              placeholder="26857381320598571"
              inputMode="numeric"
              defaultValue={client?.meta_pixel_id ?? ""}
            />
            <p className="text-[11px] text-muted-foreground">
              The live pixel when the account has several. Used by the Campaign Builder and the CAPI setup steps.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="google_ads_customer_id">Google Ads Customer ID</Label>
            <Input
              id="google_ads_customer_id"
              name="google_ads_customer_id"
              placeholder="123-456-7890"
              defaultValue={client?.google_ads_customer_id ?? ""}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="google_lsa_customer_id">Local Services Ads Customer ID (separate LSA account, optional)</Label>
            <Input
              id="google_lsa_customer_id"
              name="google_lsa_customer_id"
              placeholder="123-456-7890"
              defaultValue={client?.google_lsa_customer_id ?? ""}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ghl_location_id">GHL Location ID</Label>
            <Input
              id="ghl_location_id"
              name="ghl_location_id"
              defaultValue={client?.ghl_location_id ?? ""}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ghl_token">
              GHL Private Integration Token{" "}
              {client?.has_ghl_token && (
                <span className="text-xs text-muted-foreground">(set — leave blank to keep)</span>
              )}
            </Label>
            <Input
              id="ghl_token"
              name="ghl_token"
              type="password"
              placeholder={client?.has_ghl_token ? "••••••••" : "pit-…"}
              autoComplete="off"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cpl_target_green">CPL green below ($)</Label>
              <Input
                id="cpl_target_green"
                name="cpl_target_green"
                type="number"
                step="1"
                min="0"
                defaultValue={client?.cpl_target_green ?? 75}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="avg_job_value">Avg job value ($) — unlocks the CPBA ceiling</Label>
              <Input
                id="avg_job_value"
                name="avg_job_value"
                type="number"
                step="100"
                min="0"
                defaultValue={client?.avg_job_value ?? ""}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="setter_fee_per_appt">Zeal revenue per setter-booked appt ($) — setter leaderboard goal</Label>
              <Input
                id="setter_fee_per_appt"
                name="setter_fee_per_appt"
                type="number"
                step="1"
                min="0"
                defaultValue={client?.setter_fee_per_appt ?? ""}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="close_rate">Close rate (% of booked appts that become jobs)</Label>
              <Input
                id="close_rate"
                name="close_rate"
                type="number"
                step="1"
                min="0"
                defaultValue={client?.close_rate != null ? Math.round(client.close_rate * 100) : 25}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gross_margin_pct">Gross margin (%)</Label>
              <Input
                id="gross_margin_pct"
                name="gross_margin_pct"
                type="number"
                step="1"
                min="0"
                defaultValue={client?.gross_margin_pct != null ? Math.round(client.gross_margin_pct * 100) : 35}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="max_ad_cost_share">Max ad share of gross profit (%)</Label>
              <Input
                id="max_ad_cost_share"
                name="max_ad_cost_share"
                type="number"
                step="1"
                min="0"
                defaultValue={client?.max_ad_cost_share != null ? Math.round(client.max_ad_cost_share * 100) : 30}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cpl_target_red">CPL red above ($)</Label>
              <Input
                id="cpl_target_red"
                name="cpl_target_red"
                type="number"
                step="1"
                min="0"
                defaultValue={client?.cpl_target_red ?? 150}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="is_active"
              defaultChecked={client?.is_active ?? true}
              className="h-4 w-4 accent-[var(--primary)]"
            />
            Active (included in daily syncs)
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
