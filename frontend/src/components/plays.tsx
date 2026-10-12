"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ClientStatus, PlayIssue, PlaySeverity } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The shared "plays" vocabulary — the same icons and labels the 5 AM Slack report uses,
 * so the dashboard and the post read the same way.
 */

export const STATUS_DOT: Record<ClientStatus, string> = {
  red: "bg-red-500",
  yellow: "bg-amber-500",
  green: "bg-emerald-500",
  grey: "bg-muted-foreground/40",
};
export const STATUS_LABEL: Record<ClientStatus, string> = {
  red: "Needs action",
  yellow: "Watch",
  green: "On target",
  grey: "Not graded",
};
export const STATUS_PILL: Record<ClientStatus, string> = {
  red: "bg-red-500/15 text-red-400 border-red-500/30",
  yellow: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  green: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  grey: "bg-muted text-muted-foreground border-border",
};
const SEV_CHIP: Record<PlaySeverity, string> = {
  red: "bg-red-500/15 text-red-300 border-red-500/30",
  yellow: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  green: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  info: "bg-muted text-muted-foreground border-border",
};

export function StatusPill({ status }: { status: ClientStatus }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_PILL[status])}>
      <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[status])} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function PlayChip({ issue }: { issue: Pick<PlayIssue, "icon" | "label" | "sev"> }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium", SEV_CHIP[issue.sev])}>
      <span aria-hidden>{issue.icon}</span>
      {issue.label}
    </span>
  );
}

function PlayRow({ issue }: { issue: PlayIssue }) {
  return (
    <li className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:items-start sm:gap-2">
      <PlayChip issue={issue} />
      <div className="min-w-0 text-sm">
        {issue.where && issue.where_type === "ad" && <span className="font-medium">{issue.where}: </span>}
        <span>{issue.text}</span>
        {issue.next && issue.play !== "over_target" && <div className="text-xs text-muted-foreground">→ {issue.next}</div>}
      </div>
    </li>
  );
}

/** Account-level issues first, then one group per campaign (bold name, its plays underneath). */
export function PlayList({ issues, max, showInfo = true }: { issues: PlayIssue[]; max?: number; showInfo?: boolean }) {
  const [all, setAll] = useState(false);
  const visible = issues.filter((i) => showInfo || i.sev !== "info");
  const list = all || !max ? visible : visible.slice(0, max);
  if (visible.length === 0) return <p className="text-sm text-muted-foreground">✅ Nothing to change.</p>;
  const account = list.filter((i) => !i.campaign);
  const groups: [string, PlayIssue[]][] = [];
  for (const i of list) {
    if (!i.campaign) continue;
    const g = groups.find(([c]) => c === i.campaign);
    if (g) g[1].push(i);
    else groups.push([i.campaign, [i]]);
  }
  return (
    <div className="space-y-2">
      {account.length > 0 && <ul className="divide-y divide-border/50">{account.map((i, n) => <PlayRow key={`a${n}`} issue={i} />)}</ul>}
      {groups.map(([camp, items]) => (
        <div key={camp} className="rounded-md border border-border/60 bg-muted/20 px-3 py-1.5">
          <div className="text-sm font-semibold">{camp}</div>
          <ul className="divide-y divide-border/40">{items.map((i, n) => <PlayRow key={n} issue={i} />)}</ul>
        </div>
      ))}
      {max && visible.length > max && (
        <button type="button" onClick={() => setAll((v) => !v)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          {all ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {all ? "Show fewer" : `Show ${visible.length - max} more`}
        </button>
      )}
    </div>
  );
}

const LEGEND: [string, string, string][] = [
  ["⛔", "Kill", "0 bookings after 3× the target spend — pause on approval, relaunch a new angle"],
  ["🛠", "Fix tracking", "broken page, missing UTMs or tracking — fix before judging results"],
  ["🐢", "Fix landing page", "clicks don't load the page, or visitors don't convert"],
  ["📝", "Fix form / offer", "good CTR but few clickers submit the form"],
  ["🎣", "New hook", "video hook rate under 20% — new first 3 seconds"],
  ["🎬", "Promise sooner", "good hook, hold under 20% — deliver the offer earlier"],
  ["💡", "New angle", "CTR under 1% or lead-death pattern — a different promise, not a tweak"],
  ["🔁", "Fresh test", "frequency and cost per 1,000 reached rising while results fall"],
  ["🎨", "New concept", "one concept with copy variations isn't diversity"],
  ["✂️", "Too many ads", "more than ~1 ad per $10/day"],
  ["🧱", "Consolidate", "budget can't buy a lead a day"],
  ["📞", "Fix follow-up", "leads aren't becoming appointments"],
  ["🚀", "Scale", "10+ bookings at or under target — +20% after approval"],
];

export function PlayLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border/60 px-3 py-2 text-xs">
      <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        What the plays mean
      </button>
      {open && (
        <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {LEGEND.map(([icon, label, desc]) => (
            <div key={label} className="flex gap-2">
              <dt className="shrink-0">{icon} <span className="font-medium">{label}</span></dt>
              <dd className="text-muted-foreground">{desc}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
