"use client";

import useSWR from "swr";

import type { MatchAnalysisResponse } from "@/lib/types/match-analysis";

type UseMatchResult = {
  data: MatchAnalysisResponse | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

async function matchFetcher(url: string): Promise<MatchAnalysisResponse> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Failed to fetch match (${response.status})`);
  }

  return (await response.json()) as MatchAnalysisResponse;
}

export function useMatch(matchId: string, playerPuuid: string): UseMatchResult {
  const key =
    matchId && playerPuuid
      ? `/api/match/${encodeURIComponent(matchId)}?player=${encodeURIComponent(playerPuuid)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<MatchAnalysisResponse>(key, matchFetcher, {
    revalidateOnFocus: true,
  });

  return {
    data: data ?? null,
    isLoading,
    error: error ? error.message : null,
    refresh: async () => {
      await mutate();
    },
  };
}
