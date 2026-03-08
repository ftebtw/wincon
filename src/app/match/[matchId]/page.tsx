import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import dynamic from "next/dynamic";
import { Suspense, cache } from "react";
import { and, desc, eq } from "drizzle-orm";

import { BuildComparison } from "@/components/BuildComparison";
import { CoachingPanel } from "@/components/CoachingPanel";
import { CompTagBadge } from "@/components/CompTagBadge";
import { ContributionSection } from "@/components/ContributionSection";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorCard } from "@/components/ErrorCard";
import { WinProbabilityGraph } from "@/components/WinProbabilityGraph";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { analyzeBuildDecisions, getOptimalBuild } from "@/lib/build-analyzer";
import { getChampionIconUrl, getItems } from "@/lib/data-dragon";
import { db, schema } from "@/lib/db";
import { patchTracker } from "@/lib/patch-tracker";
import { getTopProBuildForChampion } from "@/lib/pro-insights";
import type { SimilaritySearchResult } from "@/lib/similarity-search";
import type { MatchAnalysisResponse } from "@/lib/types/match-analysis";
import { cn } from "@/lib/utils";

const PlayByPlayPanel = dynamic(
  () =>
    import("@/components/PlayByPlayPanel").then(
      (module) => module.PlayByPlayPanel,
    ),
  {
    loading: () => <PlayByPlayFallback />,
  },
);

const WhatWouldAProDo = dynamic(
  () =>
    import("@/components/WhatWouldAProDo").then(
      (module) => module.WhatWouldAProDo,
    ),
  {
    loading: () => <SimilarityFallback />,
  },
);

type MatchPageProps = {
  params: Promise<{
    matchId: string;
  }>;
  searchParams: Promise<{
    player?: string;
  }>;
};

type MatchPageState =
  | { ok: true; data: MatchAnalysisResponse }
  | { ok: false; status: number; message: string };

function getBaseUrl(headerStore: Awaited<ReturnType<typeof headers>>): string {
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const protocol = headerStore.get("x-forwarded-proto") ?? "http";
  return host ? `${protocol}://${host}` : "http://localhost:3000";
}

function queueLabel(queueId: number): string {
  if (queueId === 420) {
    return "Ranked Solo/Duo";
  }

  if (queueId === 440) {
    return "Ranked Flex";
  }

  return `Queue ${queueId}`;
}

function patchFromVersion(version: string): string {
  const parts = version.split(".");
  if (parts.length < 2) {
    return version;
  }

  return `${parts[0]}.${parts[1]}`;
}

function normalizeBuildRole(role: string): string {
  const normalized = role.toUpperCase();
  if (normalized === "MIDDLE") {
    return "MID";
  }
  if (normalized === "UTILITY") {
    return "SUPPORT";
  }
  return normalized;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

function roundToNearestFive(minute: number): number {
  return Math.max(5, Math.min(30, Math.round(minute / 5) * 5));
}

function getDefaultSimilarityMinute(data: MatchAnalysisResponse): number {
  const negativeWpaEvent = data.wpa.playerSummary.biggestNegativePlay;
  const timestampMinute = Math.floor((negativeWpaEvent?.timestamp ?? 15 * 60_000) / 60_000);
  const fallbackMinute = data.keyMoments
    .filter((moment) => moment.type === "negative")
    .sort((a, b) => a.totalDelta - b.totalDelta)[0]?.minute;

  return roundToNearestFive(fallbackMinute ?? timestampMinute ?? 15);
}

const fetchMatchData = cache(async (
  matchId: string,
  playerPuuid: string,
): Promise<MatchPageState> => {
  const headerStore = await headers();
  const baseUrl = getBaseUrl(headerStore);

  const response = await fetch(
    `${baseUrl}/api/match/${encodeURIComponent(matchId)}?player=${encodeURIComponent(playerPuuid)}`,
    { cache: "no-store" },
  );

  if (!response.ok) {
    let message = "Failed to load match analysis.";

    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Use fallback message.
    }

    return { ok: false, status: response.status, message };
  }

  const data = (await response.json()) as MatchAnalysisResponse;
  return { ok: true, data };
});

const fetchSimilarityData = cache(async (
  matchId: string,
  playerPuuid: string,
  minute: number,
): Promise<SimilaritySearchResult | null> => {
  const headerStore = await headers();
  const baseUrl = getBaseUrl(headerStore);

  try {
    const response = await fetch(`${baseUrl}/api/similar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        matchId,
        playerPuuid,
        minute,
        options: {
          k: 3,
          sameChampion: true,
          sameRole: true,
        },
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as SimilaritySearchResult;
  } catch (error) {
    console.warn("[MatchPage] Similarity fetch failed:", error);
    return null;
  }
});

function CoachingFallback() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-7 w-40" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-24 w-full" />
      </CardContent>
    </Card>
  );
}

function BuildFallback() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-7 w-44" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </CardContent>
    </Card>
  );
}

function PlayByPlayFallback() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-7 w-48" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-[320px] w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </CardContent>
    </Card>
  );
}

function SimilarityFallback() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-7 w-44" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </CardContent>
    </Card>
  );
}

function TeamRow({
  title,
  players,
  winner,
}: {
  title: string;
  players: MatchAnalysisResponse["teams"]["blue"];
  winner: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/70 p-3",
        winner ? "bg-[#10b981]/10" : "bg-[#ef4444]/10",
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge variant={winner ? "default" : "destructive"}>
          {winner ? "Winner" : "Defeat"}
        </Badge>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {players.map((player) => (
          <div
            key={`${title}-${player.puuid}`}
            className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-2"
          >
            <Image
              src={getChampionIconUrl(player.champion)}
              alt={player.champion}
              width={40}
              height={40}
              className="size-10 rounded-md border border-border/60"
            />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-foreground">{player.gameName}</p>
              <p className="text-[11px] text-muted-foreground">
                {player.kills}/{player.deaths}/{player.assists}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function MatchPage({ params, searchParams }: MatchPageProps) {
  const { matchId } = await params;
  const { player } = await searchParams;

  if (!player) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Player Query Missing</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              This page needs a player context. Open a match from a player profile.
            </p>
            <Button asChild className="mt-4">
              <Link href="/">Back to Search</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const result = await fetchMatchData(matchId, player);

  if (!result.ok) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-10">
        <ErrorCard
          statusCode={result.status}
          title={result.status === 503 ? "Riot's servers are having issues." : "Match Analysis Unavailable"}
          description={
            result.status === 503
              ? "Please try again in a few minutes."
              : result.status === 429
                ? result.message
                : result.message
          }
        />
        <Button asChild className="mt-4">
          <Link href="/">Back to Search</Link>
        </Button>
      </div>
    );
  }

  const { data } = result;
  const playerOnBlue = data.teams.blue.some((entry) => entry.puuid === data.player.puuid);
  const blueTags = playerOnBlue ? data.compAnalysis.ally.tags : data.compAnalysis.enemy.tags;
  const redTags = playerOnBlue ? data.compAnalysis.enemy.tags : data.compAnalysis.ally.tags;
  const allyTags = playerOnBlue ? data.compAnalysis.ally.tags : data.compAnalysis.enemy.tags;
  const enemyTags = playerOnBlue ? data.compAnalysis.enemy.tags : data.compAnalysis.ally.tags;
  const defaultSimilarityMinute = getDefaultSimilarityMinute(data);
  const initialSimilarityResult = await fetchSimilarityData(
    data.match.matchId,
    data.player.puuid,
    defaultSimilarityMinute,
  );

  const buildRecommendation = await getOptimalBuild({
    championName: data.player.champion,
    role: data.player.role,
    allyCompTags: allyTags,
    enemyCompTags: enemyTags,
    patch: patchFromVersion(data.match.gameVersion),
  });

  const buildDecisionAnalysis = analyzeBuildDecisions({
    playerItems: data.player.items,
    optimalBuild: buildRecommendation,
    allyCompTags: allyTags,
    enemyCompTags: enemyTags,
  });

  const topProBuild = await getTopProBuildForChampion({
    champion: data.player.champion,
    role: data.player.role,
    patch: patchFromVersion(data.match.gameVersion),
    recentGames: 300,
  });

  let proReference: { text: string; href: string } | null = null;
  if (topProBuild) {
    const itemMap = await getItems();
    const itemNames = topProBuild.buildPath
      .slice(0, 3)
      .map((itemId) => itemMap.get(itemId)?.name ?? `Item ${itemId}`)
      .join(" -> ");

    proReference = {
      text: `Pro Reference: Pros build ${itemNames} on ${data.player.champion} (${Math.round(topProBuild.winRate * 100)}% WR across ${topProBuild.games} games).`,
      href: `/pro/builds?champion=${encodeURIComponent(data.player.champion)}&role=${encodeURIComponent(data.player.role)}`,
    };
  }

  let buildDataWarning: { dataPatch: string; currentPatch: string } | null = null;
  if (process.env.DATABASE_URL && data.player.championId > 0) {
    const currentPatch = await patchTracker.getCurrentPatch();
    const buildRows = await db
      .select({
        patch: schema.buildStats.patch,
        isStale: schema.buildStats.isStale,
      })
      .from(schema.buildStats)
      .where(
        and(
          eq(schema.buildStats.championId, data.player.championId),
          eq(schema.buildStats.role, normalizeBuildRole(data.player.role)),
        ),
      )
      .orderBy(desc(schema.buildStats.computedAt))
      .limit(1);

    const latestBuildRow = buildRows[0];
    if (
      latestBuildRow &&
      (latestBuildRow.isStale || latestBuildRow.patch !== currentPatch)
    ) {
      buildDataWarning = {
        dataPatch: latestBuildRow.patch,
        currentPatch,
      };
    }
  }

  return (
    <ErrorBoundary
      fallback={
        <div className="mx-auto w-full max-w-5xl px-4 py-10">
          <ErrorCard
            title="Match Analysis Unavailable"
            description="Something went wrong while rendering this analysis. Please try refreshing."
          />
        </div>
      }
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
        <Card>
          <CardHeader className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="secondary">{queueLabel(data.match.queueId)}</Badge>
              <Badge variant="outline">Patch {patchFromVersion(data.match.gameVersion)}</Badge>
              <Badge variant="outline">{formatDuration(data.match.gameDuration)}</Badge>
            </div>
            <CardTitle className="text-2xl">Match {data.match.matchId}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <TeamRow
              title="Blue Team"
              players={data.teams.blue}
              winner={data.match.winningTeam === 100}
            />
            <div className="flex flex-wrap gap-2">
              {blueTags.map((tag) => (
                <CompTagBadge key={`blue-${tag}`} tag={tag} />
              ))}
            </div>

            <TeamRow
              title="Red Team"
              players={data.teams.red}
              winner={data.match.winningTeam === 200}
            />
            <div className="flex flex-wrap gap-2">
              {redTags.map((tag) => (
                <CompTagBadge key={`red-${tag}`} tag={tag} />
              ))}
            </div>
          </CardContent>
        </Card>

        <WinProbabilityGraph
          timeline={data.winProbTimeline}
          keyMoments={data.keyMoments}
        />

        <ContributionSection
          winProbTimeline={data.winProbTimeline}
          wpa={data.wpa}
          playerPuuid={data.player.puuid}
          keyMoments={data.keyMoments}
        />

        {initialSimilarityResult ? (
          <WhatWouldAProDo
            result={initialSimilarityResult}
            matchId={data.match.matchId}
            playerPuuid={data.player.puuid}
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">What Would a Pro Do?</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Similar game-state references are not available yet for this match.
              </p>
            </CardContent>
          </Card>
        )}

        <PlayByPlayPanel
          keyMoments={data.keyMoments}
          playByPlay={data.playByPlay}
          rankBenchmarks={data.rankBenchmarks}
          playerChampion={data.player.champion}
        />

        <ErrorBoundary
          title="AI Coaching Temporarily Unavailable"
          description="AI coaching is temporarily unavailable. You can still review stats and graphs."
        >
          <Suspense fallback={<CoachingFallback />}>
            <CoachingPanel
              matchId={data.match.matchId}
              playerPuuid={data.player.puuid}
              keyMoments={data.keyMoments}
            />
          </Suspense>
        </ErrorBoundary>

        <Suspense fallback={<BuildFallback />}>
          <BuildComparison
            playerItems={data.player.items}
            recommendation={buildRecommendation}
            analysis={buildDecisionAnalysis}
            allyCompTags={allyTags}
            enemyCompTags={enemyTags}
            matchId={data.match.matchId}
            playerPuuid={data.player.puuid}
            proReference={proReference}
            contextualBuild={data.contextualBuild}
            staleWarning={buildDataWarning}
          />
        </Suspense>
      </div>
    </ErrorBoundary>
  );
}

export async function generateMetadata({
  params,
  searchParams,
}: MatchPageProps): Promise<Metadata> {
  const { matchId } = await params;
  const { player } = await searchParams;

  if (!player) {
    return {
      title: `Match ${matchId}`,
      description: "AI coaching analysis on WinCon.gg.",
    };
  }

  const result = await fetchMatchData(matchId, player);
  if (!result.ok) {
    return {
      title: `Match ${matchId}`,
      description: "AI coaching analysis on WinCon.gg.",
    };
  }

  const { data } = result;
  const resultLabel = data.player.win ? "WIN" : "LOSS";

  return {
    title: `${data.player.champion} ${resultLabel} - ${data.player.gameName}`,
    description: `${data.player.champion} ${data.player.kills}/${data.player.deaths}/${data.player.assists} - AI coaching analysis on WinCon.gg`,
  };
}
