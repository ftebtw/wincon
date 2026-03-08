"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";

import { ErrorCard } from "@/components/ErrorCard";
import { Button } from "@/components/ui/button";
import type { PlayerLookupResponse } from "@/lib/types/player";

type PlayerRefreshControlsProps = {
  riotId: string;
  initialLastUpdated: string;
};

type RefreshError = {
  status?: number;
  message: string;
  retryAfter?: number;
};

async function fetchLastUpdated(url: string): Promise<{ lastUpdated: string }> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to update player freshness status.");
  }

  const payload = (await response.json()) as PlayerLookupResponse;
  return {
    lastUpdated: payload.lastUpdated,
  };
}

function formatLastUpdated(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function PlayerRefreshControls({ riotId, initialLastUpdated }: PlayerRefreshControlsProps) {
  const router = useRouter();
  const [refreshError, setRefreshError] = useState<RefreshError | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { data, mutate } = useSWR<{ lastUpdated: string }>(
    `/api/player/${encodeURIComponent(riotId)}`,
    fetchLastUpdated,
    {
      refreshInterval: 5 * 60 * 1000,
      revalidateOnFocus: false,
      fallbackData: {
        lastUpdated: initialLastUpdated,
      },
    },
  );

  async function refreshPlayer() {
    setIsRefreshing(true);
    setRefreshError(null);

    try {
      const response = await fetch(`/api/player/${encodeURIComponent(riotId)}?refresh=1`, {
        cache: "no-store",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          retryAfter?: number;
        };
        setRefreshError({
          status: response.status,
          message: payload.error ?? "Unable to refresh player data right now.",
          retryAfter: payload.retryAfter,
        });
        return;
      }

      await mutate();
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to refresh player data.";
      setRefreshError({
        message,
      });
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={refreshPlayer} disabled={isRefreshing}>
          <RefreshCw className={`mr-2 size-4 ${isRefreshing ? "animate-spin" : ""}`} />
          {isRefreshing ? "Refreshing..." : "Refresh"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Last updated: {formatLastUpdated(data?.lastUpdated ?? initialLastUpdated)}
        </p>
      </div>

      {refreshError ? (
        <ErrorCard
          statusCode={refreshError.status}
          description={refreshError.message}
          retryAfterSeconds={refreshError.retryAfter}
          onRetry={refreshPlayer}
          retryLabel="Retry refresh"
        />
      ) : null}
    </div>
  );
}
