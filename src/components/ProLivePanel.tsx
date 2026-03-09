"use client";

import Link from "next/link";
import useSWR from "swr";

import type { EsportsEvent, EsportsLiveGame } from "@/lib/esports-api";
import { LiveProMatch } from "@/components/LiveProMatch";
import { UpcomingMatches } from "@/components/UpcomingMatches";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type ProLiveResponse = {
  isLive: boolean;
  disabled?: boolean;
  stale?: boolean;
  error?: boolean;
  message?: string;
  lastUpdated?: string | null;
  events?: EsportsEvent[];
  games?: EsportsLiveGame[];
  upcoming?: EsportsEvent[];
};

type ProScheduleResponse = {
  disabled?: boolean;
  stale?: boolean;
  error?: boolean;
  message?: string;
  fallbackToGlobal?: boolean;
  lastUpdated?: string | null;
  results: EsportsEvent[];
  upcoming: EsportsEvent[];
  live: EsportsEvent[];
};

type ProLivePanelProps = {
  leagueSlug?: string;
};

async function fetcher<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (${response.status})`);
  }

  return (await response.json()) as T;
}

function formatDateLabel(startTime: string): string {
  if (!startTime) {
    return "TBD";
  }

  const parsed = Date.parse(startTime);
  if (!Number.isFinite(parsed)) {
    return "TBD";
  }

  return new Date(parsed).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function relativeLastUpdated(value?: string | null): string {
  if (!value) {
    return "Unknown";
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "Unknown";
  }

  const diffMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (diffMinutes < 1) {
    return "just now";
  }
  if (diffMinutes === 1) {
    return "1 minute ago";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} minutes ago`;
  }

  const hours = Math.round(diffMinutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

export function ProLivePanel({ leagueSlug }: ProLivePanelProps) {
  const scheduleKey = leagueSlug
    ? `/api/pro/schedule?league=${encodeURIComponent(leagueSlug)}`
    : "/api/pro/schedule";

  const {
    data: liveData,
    isLoading: liveLoading,
    mutate: refreshLive,
    error: liveError,
  } = useSWR<ProLiveResponse>("/api/pro/live", fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  });

  const {
    data: scheduleData,
    isLoading: scheduleLoading,
    error: scheduleError,
  } = useSWR<ProScheduleResponse>(scheduleKey, fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  });

  const liveEvents = liveData?.events ?? [];
  const liveGames = liveData?.games ?? [];
  const isLive = Boolean(liveData?.isLive && liveEvents.length > 0);
  const firstLiveEvent = liveEvents[0];
  const firstLiveGame = firstLiveEvent
    ? liveGames.find((game) => game.eventId === firstLiveEvent.id) ?? liveGames[0]
    : undefined;

  const nextMatch = liveData?.upcoming?.[0] ?? scheduleData?.upcoming?.[0];
  const liveFeatureDisabled = Boolean(liveData?.disabled || scheduleData?.disabled);

  return (
    <div className="space-y-4">
      {liveFeatureDisabled ? (
        <Card>
          <CardContent className="py-3 text-sm text-muted-foreground">
            Live esports feed is disabled. Standings and historical pro stats remain available.
          </CardContent>
        </Card>
      ) : null}

      {liveLoading && !liveData ? (
        <Card>
          <CardContent className="space-y-2 py-4">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardContent>
        </Card>
      ) : null}

      {isLive && firstLiveEvent ? (
        <LiveProMatch event={firstLiveEvent} game={firstLiveGame} onRefresh={() => void refreshLive()} />
      ) : null}

      {!isLive && !liveLoading ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No pro games currently live</CardTitle>
          </CardHeader>
          <CardContent>
            {nextMatch ? (
              <p className="text-sm text-muted-foreground">
                Next Match: {nextMatch.match?.teams?.[0]?.name ?? "TBD"} vs {nextMatch.match?.teams?.[1]?.name ?? "TBD"} - {formatDateLabel(nextMatch.startTime)}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Upcoming match schedule not available yet.</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {liveData?.stale || scheduleData?.stale ? (
        <Card className="border-[#f59e0b]/40 bg-[#f59e0b]/10">
          <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs text-[#fde68a]">
            <span>Using cached esports feed data due temporary upstream issues.</span>
            <span>
              Last updated {relativeLastUpdated(liveData?.lastUpdated ?? scheduleData?.lastUpdated)}
            </span>
          </CardContent>
        </Card>
      ) : null}

      {scheduleData?.fallbackToGlobal && scheduleData.message ? (
        <Card className="border-border/60 bg-background/40">
          <CardContent className="py-3 text-xs text-muted-foreground">
            {scheduleData.message}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <UpcomingMatches matches={scheduleData?.upcoming ?? liveData?.upcoming ?? []} />

        <Card>
          <CardHeader>
            <CardTitle>Recent Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(scheduleData?.results ?? []).slice(0, 10).map((event) => {
              const left = event.match?.teams?.[0];
              const right = event.match?.teams?.[1];
              const leftWins = left?.result?.gameWins ?? 0;
              const rightWins = right?.result?.gameWins ?? 0;

              return (
                <div
                  key={event.id}
                  className="rounded-md border border-border/60 bg-background/40 px-3 py-2 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{event.league.slug.toUpperCase()}</Badge>
                      <span>{left?.code || left?.name || "TBD"} vs {right?.code || right?.name || "TBD"}</span>
                    </div>
                    <span className="font-medium text-foreground">{leftWins} - {rightWins}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{formatDateLabel(event.startTime)}</p>
                </div>
              );
            })}

            {scheduleLoading && !scheduleData ? (
              <Skeleton className="h-24 w-full" />
            ) : null}

            {!scheduleLoading && (scheduleData?.results?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">No recent results from the live feed yet.</p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {liveError || scheduleError ? (
        <Card className="border-border/60 bg-background/40">
          <CardContent className="py-3 text-xs text-muted-foreground">
            Live data currently unstable. Core Pro stats remain available.
            <Link href="https://lolesports.com/en-US/schedule" target="_blank" rel="noreferrer" className="ml-1 text-primary hover:underline">
              Watch on lolesports.com
            </Link>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
