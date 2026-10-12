"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch, type Me } from "@/lib/api";

/** The signed-in user's profile + role from GET /api/me (cached 5 min). */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<Me>("/api/me"),
    staleTime: 5 * 60_000,
  });
}
