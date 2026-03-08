"use client";

import useSWR from "swr";

import type { PlayerLookupResponse } from "@/lib/types/player";

type UsePlayerResult = {
  data: PlayerLookupResponse | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

async function playerFetcher(url: string): Promise<PlayerLookupResponse> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Failed to fetch player (${response.status})`);
  }

  return (await response.json()) as PlayerLookupResponse;
}

export function usePlayer(riotId: string): UsePlayerResult {
  const { data, error, isLoading, mutate } = useSWR<PlayerLookupResponse>(
    riotId ? `/api/player/${encodeURIComponent(riotId)}` : null,
    playerFetcher,
    {
      refreshInterval: 5 * 60 * 1000,
      revalidateOnFocus: false,
    },
  );

  return {
    data: data ?? null,
    isLoading,
    error: error ? error.message : null,
    refresh: async () => {
      await mutate();
    },
  };
}
