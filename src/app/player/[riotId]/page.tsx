import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { Suspense, cache } from "react";
import { desc, eq } from "drizzle-orm";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorCard } from "@/components/ErrorCard";
import { MatchCard } from "@/components/MatchCard";
import { PatternsSection } from "@/components/PatternsSection";
import { PlayerRefreshControls } from "@/components/PlayerRefreshControls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getChampionById, getProfileIconUrl } from "@/lib/data-dragon";
import { db, schema } from "@/lib/db";
import { patchTracker } from "@/lib/patch-tracker";
import type { PBEDiffReport } from "@/lib/pbe-diff-engine";
import { progressTracker } from "@/lib/progress-tracker";
import type { PlayerLookupResponse } from "@/lib/types/player";
import type { LeagueEntryDto } from "@/lib/types/riot";
import { cn } from "@/lib/utils";

type PlayerPageProps = {
  params: Promise<{
    riotId: string;
  }>;
};

type PlayerPageState =
  | { ok: true; data: PlayerLookupResponse }
  | { ok: false; status: number; message: string };

const TIER_EMBLEM_URLS: Record<string, string> = {
  IRON: "/ranked-emblems/iron.svg",
  BRONZE: "/ranked-emblems/bronze.svg",
  SILVER: "/ranked-emblems/silver.svg",
  GOLD: "/ranked-emblems/gold.svg",
  PLATINUM: "/ranked-emblems/platinum.svg",
  EMERALD: "/ranked-emblems/emerald.svg",
  DIAMOND: "/ranked-emblems/diamond.svg",
  MASTER: "/ranked-emblems/master.svg",
  GRANDMASTER: "/ranked-emblems/grandmaster.svg",
  CHALLENGER: "/ranked-emblems/challenger.svg",
};

function formatWinRate(entry: LeagueEntryDto): number {
  const totalGames = entry.wins + entry.losses;
  if (totalGames === 0) {
    return 0;
  }

  return (entry.wins / totalGames) * 100;
}

function getTierEmblemUrl(tier: string): string {
  return TIER_EMBLEM_URLS[tier.toUpperCase()] ?? "/ranked-emblems/unranked.svg";
}

function formatElapsedGameDuration(startTimeMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startTimeMs) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function getBaseUrl(headerStore: Awaited<ReturnType<typeof headers>>): string {
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const protocol = headerStore.get("x-forwarded-proto") ?? "http";
  return host ? `${protocol}://${host}` : "http://localhost:3000";
}

function parseRiotIdSlug(riotId: string): { gameName: string; tagLine: string } | null {
  const decoded = decodeURIComponent(riotId);
  const splitIndex = decoded.lastIndexOf("-");
  if (splitIndex <= 0 || splitIndex === decoded.length - 1) {
    return null;
  }

  const gameName = decoded.slice(0, splitIndex).trim();
  const tagLine = decoded.slice(splitIndex + 1).trim();
  if (!gameName || !tagLine) {
    return null;
  }

  return { gameName, tagLine };
}

const fetchPlayerData = cache(async (riotId: string): Promise<PlayerPageState> => {
  try {
    const headerStore = await headers();
    const baseUrl = getBaseUrl(headerStore);

    const response = await fetch(
      `${baseUrl}/api/player/${encodeURIComponent(riotId)}`,
      { cache: "no-store" },
    );

    if (!response.ok) {
      let message = "Failed to load player profile.";

      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) {
          message = body.error;
        }
      } catch {
        // Ignore parse issues and keep fallback message.
      }

      return { ok: false, status: response.status, message };
    }

    const data = (await response.json()) as PlayerLookupResponse;
    return { ok: true, data };
  } catch (error) {
    console.error("[PlayerPage] Failed to fetch player data:", error);
    return {
      ok: false,
      status: 503,
      message: "Player profile is temporarily unavailable. Please try again.",
    };
  }
});

function RankCard({
  label,
  entry,
}: {
  label: string;
  entry?: LeagueEntryDto;
}) {
  if (!entry) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{label}</CardTitle>
          <CardDescription>Unranked</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const winRate = formatWinRate(entry);
  const winRateColor =
    winRate > 50 ? "text-[#10b981]" : winRate < 50 ? "text-[#ef4444]" : "text-foreground";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <div className="flex items-center gap-3">
          <Image
            src={getTierEmblemUrl(entry.tier)}
            alt={entry.tier}
            width={52}
            height={52}
            className="size-13 rounded-md border border-border/60"
          />
          <div>
            <CardTitle className="text-lg">
              {entry.tier} {entry.rank}
            </CardTitle>
            <p className="text-sm text-muted-foreground">{entry.leaguePoints} LP</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="text-sm">
        <p className="text-muted-foreground">
          {entry.wins}W {entry.losses}L
        </p>
        <p className={cn("font-semibold", winRateColor)}>{winRate.toFixed(1)}% WR</p>
      </CardContent>
    </Card>
  );
}

function PatternsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-24" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </CardContent>
    </Card>
  );
}

function parsePBEChangedChampions(diffReport: unknown): string[] {
  if (!diffReport || typeof diffReport !== "object") {
    return [];
  }

  const report = diffReport as PBEDiffReport;
  if (!Array.isArray(report.championChanges)) {
    return [];
  }

  return Array.from(
    new Set(
      report.championChanges
        .map((change) => change.target)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    ),
  );
}

export async function generateMetadata({ params }: PlayerPageProps): Promise<Metadata> {
  const { riotId } = await params;
  const parsedRiotId = parseRiotIdSlug(riotId);

  if (!parsedRiotId) {
    return {
      title: "Player Profile",
      description: "View match analysis and AI coaching on WinCon.gg.",
    };
  }

  const fallbackTitle = `${parsedRiotId.gameName}#${parsedRiotId.tagLine}`;
  const result = await fetchPlayerData(riotId);

  if (!result.ok) {
    return {
      title: fallbackTitle,
      description: `View match analysis and AI coaching for ${parsedRiotId.gameName}.`,
    };
  }

  const { player, rankedStats } = result.data;
  const soloQueue = rankedStats.find((entry) => entry.queueType === "RANKED_SOLO_5x5");
  const rankSummary = soloQueue
    ? `${soloQueue.tier} ${soloQueue.rank} ${soloQueue.leaguePoints}LP — ${soloQueue.wins}W ${soloQueue.losses}L`
    : "Unranked";

  return {
    title: `${player.gameName}#${player.tagLine}`,
    description: `${rankSummary} — AI-powered coaching on WinCon.gg`,
    openGraph: {
      title: `${player.gameName} — WinCon.gg`,
      description: `View match analysis and AI coaching for ${player.gameName}`,
      images: [
        {
          url: getProfileIconUrl(player.profileIconId),
        },
      ],
    },
  };
}

export default async function PlayerPage({ params }: PlayerPageProps) {
  const { riotId } = await params;
  const result = await fetchPlayerData(riotId);

  if (!result.ok) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-10">
        <ErrorCard
          statusCode={result.status}
          title={result.status === 404 ? "We couldn't find that summoner." : undefined}
          description={
            result.status === 404
              ? "Double-check the Riot ID and region."
              : result.status === 503
                ? "Riot's servers are having issues. Please try again in a few minutes."
                : result.message
          }
        />
        <Card className="mt-4">
          <CardContent>
            <p className="pt-6 text-sm text-muted-foreground">
              Try searching with the full Riot ID format, for example <span className="font-medium text-foreground">Faker#KR1</span>.
            </p>
            <Button asChild className="mt-4">
              <Link href="/">Back to Search</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { player, rankedStats, recentMatches, isInGame } = result.data;
  const soloQueue = rankedStats.find((entry) => entry.queueType === "RANKED_SOLO_5x5");
  const flexQueue = rankedStats.find((entry) => entry.queueType === "RANKED_FLEX_SR");
  const liveGame = result.data.activeGame;
  let liveChampion:
    | Awaited<ReturnType<typeof getChampionById>>
    | undefined;
  if (liveGame) {
    try {
      liveChampion = await getChampionById(liveGame.championId);
    } catch (error) {
      console.error("[PlayerPage] Failed to load live champion metadata:", error);
      liveChampion = undefined;
    }
  }
  const liveGameDuration = liveGame
    ? formatElapsedGameDuration(liveGame.gameStartTime)
    : null;

  let weeklyProgressSummary:
    | {
        wins: number;
        losses: number;
        winRate: number;
        visionDirection: "up" | "down" | "flat";
        visionDelta: string;
        deathsDirection: "up" | "down" | "flat";
        deathsDelta: string;
      }
    | null = null;

  if (process.env.DATABASE_URL) {
    try {
      const weeklyReport = await progressTracker.generateReport(player.puuid, "week");
      const visionTrend = weeklyReport.trends.find((trend) => trend.metric === "vision_score");
      const deathsTrend = weeklyReport.trends.find((trend) => trend.metric === "deaths_before_10");

      weeklyProgressSummary = {
        wins: weeklyReport.current.wins,
        losses: weeklyReport.current.losses,
        winRate: weeklyReport.current.winRate * 100,
        visionDirection:
          visionTrend?.direction === "improved"
            ? "up"
            : visionTrend?.direction === "declined"
              ? "down"
              : "flat",
        visionDelta: visionTrend ? `${Math.abs(visionTrend.changePercent).toFixed(1)}%` : "n/a",
        deathsDirection:
          deathsTrend?.direction === "improved"
            ? "down"
            : deathsTrend?.direction === "declined"
              ? "up"
              : "flat",
        deathsDelta: deathsTrend ? `${Math.abs(deathsTrend.changePercent).toFixed(1)}%` : "n/a",
      };
    } catch (error) {
      console.error("[PlayerPage] Failed to load weekly progress summary:", error);
    }
  }

  let championStatsStaleWarning: string | null = null;
  let pbeAffectedChampions: string[] = [];
  if (process.env.DATABASE_URL) {
    try {
      const patchStateRows = await db
        .select()
        .from(schema.patchState)
        .orderBy(desc(schema.patchState.detectedAt))
        .limit(1);

      const latestPatchState = patchStateRows[0];
      if (latestPatchState?.championStatsStale) {
        const currentPatch = await patchTracker.getCurrentPatch();
        championStatsStaleWarning = `Champion stats are being recalculated for patch ${currentPatch}.`;
      }

      const pbeRows = await db
        .select({ diffReport: schema.pbeDiffs.diffReport })
        .from(schema.pbeDiffs)
        .where(eq(schema.pbeDiffs.isLatest, true))
        .limit(1);

      const changedChampions = parsePBEChangedChampions(pbeRows[0]?.diffReport);
      if (changedChampions.length > 0) {
        const recentChampionSet = new Set(
          recentMatches.map((match) => match.champion.toLowerCase()),
        );
        pbeAffectedChampions = changedChampions.filter((champion) =>
          recentChampionSet.has(champion.toLowerCase()),
        );
      }
    } catch (error) {
      console.error("[PlayerPage] Failed to load patch/pbe metadata:", error);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <Image
              src={getProfileIconUrl(player.profileIconId)}
              alt={`${player.gameName} profile icon`}
              width={80}
              height={80}
              className="size-20 rounded-full border-2 border-primary/60"
            />
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold text-foreground">
                {player.gameName} <span className="text-muted-foreground">#{player.tagLine}</span>
              </h1>
              <Badge variant="secondary">Level {player.summonerLevel}</Badge>
              <PlayerRefreshControls riotId={riotId} initialLastUpdated={result.data.lastUpdated} />
            </div>
          </div>

          {isInGame ? (
            <div className="w-full max-w-sm rounded-lg border border-[#10b981]/40 bg-[#10b981]/10 p-3 md:w-auto">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="size-2.5 animate-pulse rounded-full bg-[#10b981]" />
                  <p className="text-sm font-semibold text-[#10b981]">Currently In Game</p>
                </div>
                {liveGameDuration ? (
                  <Badge variant="outline">{liveGameDuration}</Badge>
                ) : null}
              </div>

              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {liveChampion ? (
                    <Image
                      src={liveChampion.iconUrl}
                      alt={liveChampion.name}
                      width={30}
                      height={30}
                      className="size-8 rounded-md border border-border/60"
                    />
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {liveChampion ? liveChampion.name : "Champion loading..."}
                  </p>
                </div>

                <Button asChild size="sm">
                  <Link href={`/livegame/${encodeURIComponent(riotId)}`}>
                    View Loading Screen Scout -&gt;
                  </Link>
                </Button>
              </div>
            </div>
          ) : (
            <Badge variant="outline">Offline</Badge>
          )}
        </CardContent>
      </Card>

      {championStatsStaleWarning ? (
        <Card className="border-[#f59e0b]/50 bg-[#f59e0b]/10">
          <CardContent className="py-3 text-sm text-[#fde68a]">
            {championStatsStaleWarning}
          </CardContent>
        </Card>
      ) : null}

      {pbeAffectedChampions.length > 0 ? (
        <Card className="border-[#3b82f6]/40 bg-[#3b82f6]/10">
          <CardContent className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-foreground">
              {pbeAffectedChampions.join(", ")} have PBE changes detected.
            </p>
            <Button asChild size="sm" variant="outline">
              <Link href={`/pbe?puuid=${encodeURIComponent(player.puuid)}`}>
                View PBE Preview
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {weeklyProgressSummary ? (
        <Card className="border-primary/40 bg-primary/10">
          <CardContent className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-foreground">
              This week: {weeklyProgressSummary.wins}W {weeklyProgressSummary.losses}L (
              {weeklyProgressSummary.winRate.toFixed(1)}%) - Vision {weeklyProgressSummary.visionDirection}{" "}
              {weeklyProgressSummary.visionDelta}, Deaths {weeklyProgressSummary.deathsDirection}{" "}
              {weeklyProgressSummary.deathsDelta}
            </p>
            <Button asChild size="sm" variant="outline">
              <Link href={`/player/${encodeURIComponent(riotId)}/progress`}>
                View Full Progress -&gt;
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2">
        <RankCard label="Solo/Duo" entry={soloQueue} />
        <RankCard label="Flex" entry={flexQueue} />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Recent Ranked Solo Matches</h2>
          <Button asChild variant="outline" size="sm">
            <Link href={`/player/${encodeURIComponent(riotId)}/progress`}>Progress</Link>
          </Button>
        </div>
        {recentMatches.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              No recent ranked solo matches found.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {recentMatches.map((match) => (
              <MatchCard key={match.matchId} match={match} playerPuuid={player.puuid} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <ErrorBoundary
          title="Pattern Detection Unavailable"
          description="Something went wrong while rendering patterns. Please retry."
        >
          <Suspense fallback={<PatternsSkeleton />}>
            <PatternsSection puuid={player.puuid} />
          </Suspense>
        </ErrorBoundary>
      </section>
    </div>
  );
}
