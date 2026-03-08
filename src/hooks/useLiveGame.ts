"use client";

import useSWR from "swr";

type LiveGameResponse = {
  inGame: boolean;
  checkedAt: string;
};

type UseLiveGameResult = {
  data: LiveGameResponse | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

async function liveGameFetcher(url: string): Promise<LiveGameResponse> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Failed to fetch live game (${response.status})`);
  }

  return (await response.json()) as LiveGameResponse;
}

export function useLiveGame(riotId: string): UseLiveGameResult {
  const { data, error, isLoading, mutate } = useSWR<LiveGameResponse>(
    riotId ? `/api/livegame/${encodeURIComponent(riotId)}` : null,
    liveGameFetcher,
    {
      refreshInterval: 15_000,
      revalidateOnFocus: true,
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
