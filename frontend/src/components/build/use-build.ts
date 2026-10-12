"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, type Build } from "@/lib/api";
import { isInFlight } from "@/lib/build";

export const buildKey = (id: string) => ["build", id] as const;
export const messagesKey = (id: string) => ["build-messages", id] as const;

/** One build, polled every 3 s while Meta objects are being created. */
export function useBuild(id: string) {
  return useQuery({
    queryKey: buildKey(id),
    queryFn: () => apiFetch<Build>(`/api/builds/${encodeURIComponent(id)}`),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s && isInFlight(s) ? 3000 : false;
    },
  });
}

/** Write a fresh Build (from a mutation or SSE `done`) straight into the cache. */
export function useSetBuild(id: string) {
  const qc = useQueryClient();
  return useCallback(
    (updater: Build | ((prev: Build) => Build)) => {
      qc.setQueryData<Build>(buildKey(id), (prev) => {
        if (typeof updater === "function") return prev ? updater(prev) : prev;
        return updater;
      });
      // Keep the list page in step too.
      qc.invalidateQueries({ queryKey: ["builds"] });
    },
    [qc, id],
  );
}
