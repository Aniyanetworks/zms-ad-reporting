import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Setter Leaderboard",
  description: "Zeal Media appointment setters — this month's ranking by appointments booked",
};

export default function LeaderboardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
