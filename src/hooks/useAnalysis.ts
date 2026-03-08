"use client";

import useSWR from "swr";

import type { MatchAnalysisOutput } from "@/lib/types/analysis";

type UseAnalysisResult = {
  data: MatchAnalysisOutput | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

async function analysisFetcher(url: string): Promise<MatchAnalysisOutput> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Failed to fetch analysis (${response.status})`);
  }

  return (await response.json()) as MatchAnalysisOutput;
}

export function useAnalysis(matchId: string, playerPuuid: string): UseAnalysisResult {
  const key =
    matchId && playerPuuid
      ? `/api/analysis/${encodeURIComponent(matchId)}?player=${encodeURIComponent(playerPuuid)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<MatchAnalysisOutput>(key, analysisFetcher, {
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
