"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAccessToken } from "@/lib/api";

/**
 * Downloads the client's full dataset (campaigns, ad sets, ads + creative copy,
 * Google ad groups / ads / keywords / search terms, GHL bookings, targets, latest
 * brief) as one JSON file — built to be pasted into an AI for analysis, not read.
 */
export function AiBundleButton({ slug, start, end }: { slug: string; start: string; end: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setErr(null);
    try {
      const token = await getAccessToken();
      const res = await fetch(`/api/clients/${slug}/ai-bundle?start=${start}&end=${end}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slug}-ads-data-${start}_${end}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={download}
        disabled={busy}
        title="Everything collected for this client and range (campaigns, ad sets, ads with creative copy, Google ad groups/keywords/search terms, GHL bookings) as one JSON file for AI analysis"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        AI data (JSON)
      </Button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}
