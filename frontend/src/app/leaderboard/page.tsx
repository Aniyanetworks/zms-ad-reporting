"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict, parse } from "date-fns";
import { Crown, Trophy, Users } from "lucide-react";
import { Bar, BarChart, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  apiFetch,
  type LeaderboardResponse,
  type LeaderboardSetter,
  type LeaderboardTeam,
} from "@/lib/api";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

const REFRESH_MS = 30_000;
const STALE_AFTER_MS = 5 * 60_000;
// One hue, two lightness steps: confirmed (solid) vs still-to-happen (faded).
const BAR_COLOR = "var(--chart-4)";
const PENDING_OPACITY = 0.32;

function monthLabel(month: string): string {
  return format(parse(month, "yyyy-MM", new Date()), "MMMM yyyy");
}

/** Whole dollars; the small per-appointment commissions never need cents on the board. */
function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

function useLeaderboard(month?: string, live = false) {
  return useQuery({
    queryKey: ["setter-leaderboard", month ?? "current"],
    queryFn: () =>
      apiFetch<LeaderboardResponse>(`/api/setters/leaderboard${month ? `?month=${month}` : ""}`),
    refetchInterval: live ? REFRESH_MS : false,
    refetchIntervalInBackground: false,
    staleTime: live ? 10_000 : 60_000,
  });
}

/** Re-render every 10s so the "updated … ago" label keeps moving between polls. */
function useTicker(ms = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

// ---------------------------------------------------------------- team effort

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("text-xl font-semibold tabular-nums sm:text-2xl", accent && "text-amber-300")}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground tabular-nums">{hint}</p>}
    </div>
  );
}

function TeamCard({
  team,
  month,
  isCurrent,
  bookedAvailable,
  fee,
}: {
  team: LeaderboardTeam;
  month: string;
  isCurrent: boolean;
  bookedAvailable: boolean;
  fee: LeaderboardResponse["fee"];
}) {
  const hasGoal = team.goal > 0;
  const progress = Math.min(1, team.goal_progress ?? 0);
  const pct = Math.round(progress * 100);
  const pace = Math.min(1, team.month_elapsed);
  const onPace = !isCurrent || (team.goal_progress ?? 0) >= pace;
  const remaining = Math.max(0, team.goal - team.revenue);
  const feesMissing = fee.rows_using_default > 0 && fee.default === 0;

  return (
    <section className="rounded-2xl bg-card p-5 ring-1 ring-foreground/10 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
            <Users className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Team effort</h2>
            <p className="text-sm text-muted-foreground">
              Money made for Zeal Media Solutions in {monthLabel(month)}
            </p>
          </div>
        </div>
        {bookedAvailable && hasGoal && (
          <span
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium",
              progress >= 1
                ? "bg-emerald-500/15 text-emerald-400"
                : onPace
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-amber-500/15 text-amber-400",
            )}
          >
            {progress >= 1 ? "Goal hit" : onPace ? "On pace" : `${money(remaining)} to go`}
          </span>
        )}
      </div>

      {bookedAvailable ? (
        <>
          <div className="mt-5 flex flex-wrap items-end justify-between gap-2">
            <p className="text-5xl font-bold leading-none tabular-nums sm:text-6xl">{money(team.revenue)}</p>
            <p className="text-sm text-muted-foreground tabular-nums">
              {hasGoal ? (
                <>
                  of <span className="font-medium text-foreground">{money(team.goal)}</span> monthly goal · {pct}%
                </>
              ) : (
                `from ${fmtNum(team.booked - team.cancelled)} booked appointments · no monthly goal set yet`
              )}
            </p>
          </div>
          {hasGoal && (
          <div className="relative mt-3 h-4 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={cn("h-full rounded-full transition-all duration-700", progress >= 1 ? "bg-emerald-400" : "bg-primary")}
              style={{ width: `${Math.max(progress * 100, progress > 0 ? 1.5 : 0)}%` }}
            />
            {isCurrent && pace < 1 && (
              <div
                className="absolute inset-y-0 w-0.5 bg-foreground/60"
                style={{ left: `${pace * 100}%` }}
                title={`${Math.round(pace * 100)}% of the month gone`}
              />
            )}
          </div>
          )}
          {hasGoal && isCurrent && pace < 1 && (
            <p className="mt-1 text-xs text-muted-foreground">
              The marker is where the month is — {Math.round(pace * 100)}% gone. Stay ahead of it.
            </p>
          )}
        </>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          No bookings logged in the commission tracker for this month.
        </p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Booked" value={bookedAvailable ? fmtNum(team.booked) : "—"} hint={bookedAvailable ? `${team.pending} still to happen` : undefined} />
        <Stat label="Confirmed" value={bookedAvailable ? fmtNum(team.shows) : "—"} hint={bookedAvailable ? `${money(team.revenue_confirmed)} for Zeal` : undefined} />
        <Stat label="Show-up rate" value={bookedAvailable ? fmtPct(team.show_up_rate, 0) : "—"} hint={bookedAvailable ? `${team.no_shows} no-show` : undefined} />
        <Stat label="Booking ratio" value={fmtPct(team.booking_ratio, 0)} hint={`${fmtNum(team.appts_set)} set / ${fmtNum(team.new_leads)} leads`} />
        <Stat label="Team earned" value={bookedAvailable ? money(team.earned) : "—"} hint="commission this month" accent />
        <Stat label="Cancelled" value={bookedAvailable ? fmtNum(team.cancelled) : "—"} hint="not counted" />
      </div>

      {bookedAvailable && fee.rows_using_default > 0 && (
        <p className={cn("mt-4 text-xs", feesMissing ? "text-amber-400" : "text-muted-foreground")}>
          {feesMissing
            ? `${fee.rows_using_default} of ${fee.rows_total} booked appointments count as $0 — their client has no "Zeal revenue per setter-booked appt" set in Settings yet.`
            : `${fee.rows_using_default} of ${fee.rows_total} booked appointments use the default ${money(fee.default)} per appointment because their client has no fee set in Settings.`}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- individual effort

interface ChartRow {
  name: string;
  shows: number;
  pending: number;
  booked: number;
  earned: number;
  rank: number;
  label: string;
}

function ChartTip({ active, payload }: { active?: boolean; payload?: { payload: ChartRow }[] }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="font-semibold">{r.name}</p>
      <p className="tabular-nums">{r.booked} booked · {r.shows} confirmed · {r.pending} to happen</p>
      <p className="tabular-nums text-amber-300">{money(r.earned)} earned</p>
    </div>
  );
}

function NameTick({ x, y, payload, rows }: { x?: number; y?: number; payload?: { value: string }; rows: ChartRow[] }) {
  const row = rows.find((d) => d.name === payload?.value);
  const isLeader = row?.rank === 1 && (row?.booked ?? 0) > 0;
  return (
    <g transform={`translate(${x ?? 0},${y ?? 0})`}>
      {isLeader && <Crown x={-98} y={-9} width={16} height={16} className="fill-none stroke-amber-400" strokeWidth={2.25} />}
      <text x={-4} y={0} dy={5} textAnchor="end" fill={isLeader ? "#fcd34d" : "var(--foreground)"} fontSize={15} fontWeight={600}>
        {payload?.value}
      </text>
    </g>
  );
}

function SetterBars({ setters, bookedAvailable }: { setters: LeaderboardSetter[]; bookedAvailable: boolean }) {
  const data: ChartRow[] = setters.map((s) => ({
    name: s.name,
    shows: bookedAvailable ? s.shows : 0,
    pending: bookedAvailable ? s.pending : s.appts_set,
    booked: bookedAvailable ? s.booked : s.appts_set,
    earned: s.earned,
    rank: s.rank,
    label: bookedAvailable ? `${s.booked} booked · ${money(s.earned)}` : `${s.appts_set} set`,
  }));
  const height = Math.max(120, data.length * 58 + 12);

  return (
    <div className="h-full w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 170, bottom: 4, left: 4 }} barCategoryGap={12}>
          <XAxis type="number" hide allowDecimals={false} />
          <YAxis
            type="category"
            dataKey="name"
            width={100}
            axisLine={false}
            tickLine={false}
            tick={<NameTick rows={data} />}
          />
          <Tooltip cursor={{ fill: "var(--muted)", fillOpacity: 0.35 }} content={<ChartTip />} />
          <Bar dataKey="shows" stackId="a" name="Confirmed" fill={BAR_COLOR} stroke="var(--card)" strokeWidth={2} radius={[4, 0, 0, 4]} isAnimationActive={false} />
          <Bar dataKey="pending" stackId="a" name="Still to happen" fill={BAR_COLOR} fillOpacity={PENDING_OPACITY} stroke="var(--card)" strokeWidth={2} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            <LabelList dataKey="label" position="right" fill="var(--foreground)" fontSize={13} className="tabular-nums" />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BAR_COLOR }} /> Confirmed (showed)
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BAR_COLOR, opacity: PENDING_OPACITY }} /> Still to happen
      </span>
    </div>
  );
}

function SetterTable({ setters, bookedAvailable }: { setters: LeaderboardSetter[]; bookedAvailable: boolean }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">#</TableHead>
            <TableHead>Setter</TableHead>
            <TableHead className="text-right">Booked</TableHead>
            <TableHead className="text-right">Confirmed</TableHead>
            <TableHead className="text-right">Show-up</TableHead>
            <TableHead className="text-right">Booking ratio</TableHead>
            <TableHead className="text-right">Earned</TableHead>
            <TableHead className="text-right">Made for Zeal</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {setters.map((s) => {
            const leader = s.rank === 1 && s.booked > 0;
            return (
              <TableRow key={s.name} className={cn(leader && "bg-amber-400/5")}>
                <TableCell className="font-semibold tabular-nums">
                  {leader ? <Crown className="h-4 w-4 text-amber-400" /> : s.rank}
                </TableCell>
                <TableCell className={cn("font-medium", leader && "text-amber-300")}>
                  {s.name}
                  {!s.active && <span className="ml-2 text-xs text-muted-foreground">former</span>}
                </TableCell>
                <TableCell className="text-right text-base font-semibold tabular-nums">
                  {bookedAvailable ? fmtNum(s.booked) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">{bookedAvailable ? fmtNum(s.shows) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{bookedAvailable ? fmtPct(s.show_up_rate, 0) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmtPct(s.booking_ratio, 0)}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {fmtNum(s.appts_set)}/{fmtNum(s.new_leads)}
                  </span>
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums text-amber-300">
                  {bookedAvailable ? money(s.earned) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {bookedAvailable ? money(s.revenue) : "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------- prior months

function PriorMonths({ months }: { months: string[] }) {
  const [month, setMonth] = useState<string | undefined>(months[0]);
  useEffect(() => {
    if (!month && months[0]) setMonth(months[0]);
  }, [month, months]);
  const { data, isLoading } = useLeaderboard(month, false);

  if (months.length === 0) {
    return <p className="text-sm text-muted-foreground">No prior months yet — history starts filling in next month.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {months.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMonth(m)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm transition-colors",
              m === month
                ? "border-primary bg-primary/15 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {monthLabel(m)}
          </button>
        ))}
      </div>
      {isLoading || !data ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : (
        <>
          {data.booked_available && (
            <div className="flex flex-wrap gap-x-8 gap-y-2 rounded-lg border px-4 py-3 text-sm">
              <span>
                Made for Zeal <span className="font-semibold tabular-nums">{money(data.team.revenue)}</span>
                {data.team.goal > 0 && (
                  <span className="text-muted-foreground"> of {money(data.team.goal)} ({Math.round((data.team.goal_progress ?? 0) * 100)}%)</span>
                )}
              </span>
              <span>
                Booked <span className="font-semibold tabular-nums">{fmtNum(data.team.booked)}</span>
              </span>
              <span>
                Confirmed <span className="font-semibold tabular-nums">{fmtNum(data.team.shows)}</span>
              </span>
              <span>
                Team earned <span className="font-semibold tabular-nums text-amber-300">{money(data.team.earned)}</span>
              </span>
            </div>
          )}
          <SetterTable setters={data.setters} bookedAvailable={data.booked_available} />
          {!data.booked_available && (
            <p className="text-xs text-muted-foreground">
              Appointment bookings, show-up rates and earnings are tracked from September 2026 onward; earlier
              months show booking ratio only.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function LeaderboardPage() {
  const now = useTicker();
  const { data, isLoading, error } = useLeaderboard(undefined, true);

  const updatedAt = data?.last_updated ? new Date(data.last_updated) : null;
  const stale = !updatedAt || now - updatedAt.getTime() > STALE_AFTER_MS;
  const priorMonths = useMemo(() => (data?.months ?? []).filter((m) => m !== data?.month), [data]);
  const leader = data?.setters.find((s) => s.rank === 1 && s.booked > 0);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-sidebar/95">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-400/15">
              <Trophy className="h-5 w-5 text-amber-400" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Setter Leaderboard</h1>
              <p className="text-sm text-muted-foreground">
                {data ? monthLabel(data.month) : "This month"} ·{" "}
                {data && !data.booked_available
                  ? "ranked by appointments set (commission tracker not connected yet)"
                  : "ranked by appointments booked"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span
              className={cn("inline-block h-2 w-2 rounded-full", stale ? "bg-amber-400" : "bg-emerald-400 animate-pulse")}
              aria-hidden
            />
            {updatedAt
              ? `Updated ${formatDistanceToNowStrict(updatedAt, { addSuffix: true })}`
              : isLoading
                ? "Loading…"
                : "Waiting for first sync"}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-6 sm:px-6 sm:py-8">
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Couldn&apos;t load the leaderboard: {(error as Error).message}
          </p>
        )}

        {isLoading || !data ? (
          <>
            <Skeleton className="h-64 rounded-2xl" />
            <Skeleton className="h-80 rounded-2xl" />
          </>
        ) : (
          <>
            <TeamCard
              team={data.team}
              month={data.month}
              isCurrent={data.is_current}
              bookedAvailable={data.booked_available}
              fee={data.fee}
            />

            <section className="rounded-2xl bg-card p-5 ring-1 ring-foreground/10 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">Individual effort</h2>
                  <p className="text-sm text-muted-foreground">
                    {leader
                      ? `${leader.name} leads with ${leader.booked} booked. $3 per confirmed appointment.`
                      : "Appointments booked this month. $3 per confirmed appointment."}
                  </p>
                </div>
                {data.booked_available && <Legend />}
              </div>
              <div className="mt-4">
                <SetterBars setters={data.setters} bookedAvailable={data.booked_available} />
              </div>
              <div className="mt-4">
                <SetterTable setters={data.setters} bookedAvailable={data.booked_available} />
              </div>
            </section>

            <section className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Prior Months</h2>
                <p className="text-sm text-muted-foreground">Read-only snapshots, same numbers.</p>
              </div>
              <PriorMonths months={priorMonths} />
            </section>
          </>
        )}

        <footer className="border-t pt-4 text-xs text-muted-foreground">
          Booked, confirmed, show-up and earnings come from the commission tracker (by date booked; show-up = shows
          ÷ shows + no-shows; earnings are the sheet&apos;s own Commission column). Booking ratio = appointments set ÷
          new leads from the daily tracking sheet. Made for Zeal = what Zeal earns per appointment for that client ×
          booked appointments that weren&apos;t cancelled. Refreshes every minute. View only — update the sheets to change
          the numbers.
        </footer>
      </main>
    </div>
  );
}
