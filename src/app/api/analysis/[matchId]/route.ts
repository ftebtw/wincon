import { and, eq, gte } from "drizzle-orm";
import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";

import { classifyBothComps } from "@/lib/comp-classifier";
import { cachedRiotAPI } from "@/lib/cache";
import {
  contextualBuildEngine,
  getChampionClass,
} from "@/lib/contextual-build-engine";
import { db, schema } from "@/lib/db";
import { abilityDataService } from "@/lib/ability-data";
import { aiCoach } from "@/lib/ai-coach";
import { aiRateLimiter } from "@/lib/ai-rate-limiter";
import { playByPlayAnalyzer } from "@/lib/play-by-play";
import { rankBenchmarkService } from "@/lib/rank-benchmarks";
import { RiotAPIError } from "@/lib/riot-api";
import {
  similaritySearchEngine,
  type SimilarGameResult,
} from "@/lib/similarity-search";
import {
  buildRegionalCandidates,
  getRegionConfig,
  getRegionFromPlatform,
  getRegionFromRequest,
  type Region,
} from "@/lib/regions";
import { wpaEngine } from "@/lib/wpa-engine";
import { compactMatchForLLM, formatForPrompt } from "@/lib/match-compactor";
import type { MatchAnalysisOutput } from "@/lib/types/analysis";
import type { MatchDto, MatchTimelineDto } from "@/lib/types/riot";
import { computeMatchWinProbTimeline, identifyKeyMoments } from "@/lib/win-probability";

type AnalysisRouteContext = {
  params: Promise<{
    matchId: string;
  }>;
};

// Option A timeout handling for serverless AI calls.
// TODO: migrate to streaming responses for better UX.
export const maxDuration = 60;

function parsePatchFromGameVersion(gameVersion: string): string {
  const [major, minor] = gameVersion.split(".");
  if (!major || !minor) {
    return gameVersion;
  }

  return `${major}.${minor}`;
}

function getRegionCandidates(matchId: string, preferredRegion: Region): string[] {
  const platform = matchId.split("_")[0]?.toLowerCase() ?? "";
  const inferredRegion = getRegionFromPlatform(platform);
  const inferred = inferredRegion ? getRegionConfig(inferredRegion).regional : undefined;

  return buildRegionalCandidates({
    preferredRegion,
    inferredRegional: inferred,
  });
}

function extractPlayerRank(rawMatch: MatchDto, playerPuuid: string): string | undefined {
  const player = rawMatch.info.participants.find((participant) => participant.puuid === playerPuuid);
  if (!player) {
    return undefined;
  }

  // Riot match-v5 does not include rank; keep placeholder for prompt context.
  return "Unknown";
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function roleFromParticipant(participant: MatchDto["info"]["participants"][number]): string {
  const byTeamPosition: Record<string, string> = {
    TOP: "TOP",
    JUNGLE: "JUNGLE",
    MIDDLE: "MID",
    BOTTOM: "ADC",
    UTILITY: "SUPPORT",
  };

  if (participant.teamPosition && participant.teamPosition in byTeamPosition) {
    return byTeamPosition[participant.teamPosition];
  }
  if (participant.lane === "MIDDLE") return "MID";
  if (participant.lane === "JUNGLE") return "JUNGLE";
  if (participant.lane === "TOP") return "TOP";
  if (participant.lane === "BOTTOM" && participant.role === "DUO_SUPPORT") return "SUPPORT";
  if (participant.lane === "BOTTOM") return "ADC";
  return "UNKNOWN";
}

function findLaneOpponent(
  player: MatchDto["info"]["participants"][number],
  enemies: MatchDto["info"]["participants"][number][],
): MatchDto["info"]["participants"][number] {
  if (player.teamPosition) {
    const byTeamPosition = enemies.find(
      (candidate) => candidate.teamPosition === player.teamPosition,
    );
    if (byTeamPosition) {
      return byTeamPosition;
    }
  }

  const playerRole = roleFromParticipant(player);
  const byRole = enemies.find((candidate) => roleFromParticipant(candidate) === playerRole);

  return byRole ?? enemies[0];
}

function calculateCs(participant: MatchDto["info"]["participants"][number]): number {
  return participant.totalMinionsKilled + participant.neutralMinionsKilled;
}

function getParticipantFrameAtMinute(
  timeline: MatchTimelineDto,
  participantId: number,
  minute: number,
) {
  const targetTimestamp = minute * 60_000;
  const candidateFrames = timeline.info.frames
    .filter((frame) => frame.timestamp <= targetTimestamp)
    .sort((a, b) => b.timestamp - a.timestamp);
  const frame = candidateFrames[0] ?? timeline.info.frames[0];
  return frame?.participantFrames[String(participantId)];
}

function buildAbilityContextForDeaths(params: {
  match: MatchDto;
  timeline: MatchTimelineDto;
  playerParticipant: MatchDto["info"]["participants"][number];
  laneOpponent: MatchDto["info"]["participants"][number];
}): string[] {
  const { timeline, playerParticipant, laneOpponent } = params;
  const deathEvents = timeline.info.frames
    .flatMap((frame) => frame.events)
    .filter(
      (event) =>
        event.type === "CHAMPION_KILL" &&
        event.victimId === playerParticipant.participantId,
    )
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, 3);

  if (deathEvents.length === 0) {
    const defaultContext = abilityDataService.formatForPrompt(
      playerParticipant.championName,
      laneOpponent.championName,
      6,
    );
    return [`No player deaths detected. Matchup baseline: ${defaultContext}`];
  }

  return deathEvents.map((event) => {
    const minute = Math.floor(event.timestamp / 60_000);
    const playerFrame = getParticipantFrameAtMinute(
      timeline,
      playerParticipant.participantId,
      minute,
    );
    const opponentFrame = getParticipantFrameAtMinute(
      timeline,
      laneOpponent.participantId,
      minute,
    );
    const playerLevel = Math.max(1, playerFrame?.level ?? playerParticipant.champLevel ?? 1);
    const opponentLevel = Math.max(
      1,
      opponentFrame?.level ?? laneOpponent.champLevel ?? playerLevel,
    );
    const referenceLevel = Math.max(
      1,
      Math.min(18, Math.round((playerLevel + opponentLevel) / 2)),
    );
    const killerName = event.killerId
      ? params.match.info.participants.find(
          (participant) => participant.participantId === event.killerId,
        )?.championName ?? "Unknown"
      : "Unknown";
    const abilityContext = abilityDataService.formatForPrompt(
      playerParticipant.championName,
      laneOpponent.championName,
      referenceLevel,
    );
    return `Death at ${formatTimestamp(event.timestamp)} (lvl ${playerLevel} vs ${opponentLevel}, killed by ${killerName}): ${abilityContext}`;
  });
}

function calculateDeathsBefore10(timeline: MatchTimelineDto, participantId: number): number {
  return timeline.info.frames
    .flatMap((frame) => frame.events)
    .filter(
      (event) =>
        event.type === "CHAMPION_KILL" &&
        event.victimId === participantId &&
        event.timestamp < 10 * 60_000,
    ).length;
}

function calculateDamageShare(
  match: MatchDto,
  participant: MatchDto["info"]["participants"][number],
): number {
  const teamTotalDamage = match.info.participants
    .filter((entry) => entry.teamId === participant.teamId)
    .reduce((sum, entry) => sum + entry.totalDamageDealtToChampions, 0);
  if (teamTotalDamage <= 0) {
    return 0;
  }
  return participant.totalDamageDealtToChampions / teamTotalDamage;
}

function toSimilarityMinute(timestamp: number): number {
  const rawMinute = Math.floor(Math.max(0, timestamp) / 60_000);
  const rounded = Math.round(rawMinute / 5) * 5;
  return Math.max(5, Math.min(30, rounded));
}

function formatSimilarReference(
  result: SimilarGameResult,
  index: number,
): string {
  const source = result.gameState.metadata.isProGame
    ? [result.gameState.metadata.teamName, result.gameState.metadata.playerName]
        .filter(Boolean)
        .join(" - ") || "Pro reference"
    : [result.gameState.metadata.rank, result.gameState.metadata.region]
        .filter(Boolean)
        .join(" - ") || "High-elo reference";

  const matchResult = result.gameState.outcome.wonGame ? "WIN" : "LOSS";
  const goldSwing = result.gameState.outcome.goldDiffChange5Min;

  return `Reference ${index + 1} (${Math.round(result.similarity * 100)}%): ${source}, min ${result.gameState.metadata.minute}, ${result.highlightReason}. Action/result: ${result.gameState.outcome.next5MinEvents} (${matchResult}, gold swing ${goldSwing >= 0 ? "+" : ""}${Math.round(goldSwing)}).`;
}

async function getPlayerSoloTier(puuid: string): Promise<string> {
  if (!process.env.DATABASE_URL) {
    return "EMERALD";
  }

  try {
    const rows = await db
      .select({
        tier: schema.rankedStats.tier,
      })
      .from(schema.rankedStats)
      .where(
        and(
          eq(schema.rankedStats.puuid, puuid),
          eq(schema.rankedStats.queueType, "RANKED_SOLO_5x5"),
        ),
      )
      .orderBy(desc(schema.rankedStats.fetchedAt))
      .limit(1);
    return rows[0]?.tier ?? "EMERALD";
  } catch (error) {
    console.warn("[AnalysisRoute] Failed to read ranked tier for benchmarking:", error);
    return "EMERALD";
  }
}

async function fetchMatchWithRegionFallback(
  matchId: string,
  preferredRegion: Region,
): Promise<{ match: MatchDto; timeline: MatchTimelineDto }> {
  for (const region of getRegionCandidates(matchId, preferredRegion)) {
    try {
      const [match, timeline] = await Promise.all([
        cachedRiotAPI.getMatch(matchId, region),
        cachedRiotAPI.getMatchTimeline(matchId, region),
      ]);

      return { match, timeline };
    } catch (error) {
      if (error instanceof RiotAPIError && error.status === 404) {
        continue;
      }

      throw error;
    }
  }

  throw new RiotAPIError({
    status: 404,
    message: "Match not found.",
    url: `/lol/match/v5/matches/${matchId}`,
  });
}

async function getCachedAnalysis(matchId: string, playerPuuid: string): Promise<MatchAnalysisOutput | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const cached = await db
      .select({
        analysisJson: schema.aiAnalyses.analysisJson,
      })
      .from(schema.aiAnalyses)
      .where(
        and(
          eq(schema.aiAnalyses.matchId, matchId),
          eq(schema.aiAnalyses.puuid, playerPuuid),
          eq(schema.aiAnalyses.analysisType, "match_review"),
          gte(schema.aiAnalyses.createdAt, cutoff),
        ),
      )
      .limit(1);

    if (cached.length === 0) {
      return null;
    }

    return cached[0].analysisJson as MatchAnalysisOutput;
  } catch (error) {
    console.error("[AnalysisRoute] Failed to read cached analysis:", error);
    return null;
  }
}

async function ensureMatchExists(match: MatchDto): Promise<void> {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const winningTeam = match.info.teams.find((team) => team.win)?.teamId ?? 100;

  try {
    await db
      .insert(schema.matches)
      .values({
        matchId: match.metadata.matchId,
        gameVersion: match.info.gameVersion,
        gameMode: match.info.gameMode,
        gameDuration: match.info.gameDuration,
        queueId: match.info.queueId,
        mapId: match.info.mapId,
        gameStartTs: match.info.gameStartTimestamp,
        winningTeam,
        rawData: match,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.matches.matchId,
        set: {
          gameVersion: match.info.gameVersion,
          gameMode: match.info.gameMode,
          gameDuration: match.info.gameDuration,
          queueId: match.info.queueId,
          mapId: match.info.mapId,
          gameStartTs: match.info.gameStartTimestamp,
          winningTeam,
          rawData: match,
          fetchedAt: new Date(),
        },
      });
  } catch (error) {
    console.error("[AnalysisRoute] Failed to upsert match row:", error);
  }
}

export async function GET(request: Request, { params }: AnalysisRouteContext) {
  const { matchId } = await params;
  const url = new URL(request.url);
  const selectedRegion = getRegionFromRequest(request);
  const playerPuuid = url.searchParams.get("player");

  if (!playerPuuid) {
    return NextResponse.json(
      { error: "Missing required query parameter: player" },
      { status: 400 },
    );
  }

  try {
    const cached = await getCachedAnalysis(matchId, playerPuuid);
    if (cached) {
      return NextResponse.json(cached);
    }

    const rateLimit = aiRateLimiter.consume(request, { userId: playerPuuid });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: rateLimit.message,
          resetAt: rateLimit.resetAt,
        },
        { status: 429 },
      );
    }

    const { match, timeline } = await fetchMatchWithRegionFallback(matchId, selectedRegion);
    const playerParticipant = match.info.participants.find(
      (participant) => participant.puuid === playerPuuid,
    );

    if (!playerParticipant) {
      return NextResponse.json(
        { error: "Player is not present in this match." },
        { status: 404 },
      );
    }

    const enemyParticipants = match.info.participants.filter(
      (participant) => participant.teamId !== playerParticipant.teamId,
    );
    const laneOpponent = findLaneOpponent(playerParticipant, enemyParticipants);

    let abilityContextLines: string[] = [];
    try {
      await abilityDataService.fetchAllChampions();
      abilityContextLines = buildAbilityContextForDeaths({
        match,
        timeline,
        playerParticipant,
        laneOpponent,
      });
    } catch (error) {
      console.warn("[AnalysisRoute] Ability context unavailable:", error);
      abilityContextLines = ["Ability context unavailable for key deaths in this match."];
    }

    const allyChampions = match.info.participants
      .filter((participant) => participant.teamId === playerParticipant.teamId)
      .map((participant) => participant.championName);
    const enemyChampions = enemyParticipants.map(
      (participant) => participant.championName,
    );

    const compAnalysis = await classifyBothComps(allyChampions, enemyChampions);
    const contextualBuild = await contextualBuildEngine
      .generateBuild({
        playerChampion: playerParticipant.championName,
        playerRole: roleFromParticipant(playerParticipant),
        playerClass: await getChampionClass(playerParticipant.championName),
        allies: match.info.participants
          .filter((participant) => participant.teamId === playerParticipant.teamId)
          .filter((participant) => participant.puuid !== playerParticipant.puuid)
          .map((participant) => participant.championName),
        enemies: enemyParticipants.map((participant) => participant.championName),
      })
      .catch((error) => {
        console.warn("[AnalysisRoute] Contextual build unavailable:", error);
        return null;
      });
    const winProbTimeline = computeMatchWinProbTimeline(match, timeline, playerPuuid);
    const keyMoments = identifyKeyMoments(winProbTimeline, 6);
    const wpaReport = wpaEngine.computeMatchWPA(
      match,
      timeline,
      winProbTimeline,
      playerPuuid,
    );
    let similarGameReferences: string[] = [];
    try {
      const similarityMinute = toSimilarityMinute(
        wpaReport.playerContribution.biggestNegativePlay.timestamp,
      );
      const similarityResult = await similaritySearchEngine.search(
        match,
        timeline,
        playerPuuid,
        similarityMinute,
        {
          k: 3,
          sameChampion: true,
          sameRole: true,
          minRank: "DIAMOND",
          patchFilter: parsePatchFromGameVersion(match.info.gameVersion),
        },
      );

      similarGameReferences = similarityResult.results.map((entry, index) =>
        formatSimilarReference(entry, index),
      );
      if (similarityResult.aiInsight) {
        similarGameReferences.push(`Insight: ${similarityResult.aiInsight}`);
      }
    } catch (error) {
      console.warn("[AnalysisRoute] Similarity reference unavailable:", error);
    }

    if (similarGameReferences.length === 0) {
      similarGameReferences.push(
        "No close high-elo/pro references were available for this exact state.",
      );
    }

    const contextualBuildSummary = contextualBuild
      ? [
          `Generic OP.GG: ${contextualBuild.genericBuild.join(" -> ") || "N/A"}`,
          `Contextual boots: ${contextualBuild.build.boots.item} (${contextualBuild.build.boots.reason})`,
          ...contextualBuild.build.items.map(
            (item) =>
              `Slot ${item.slot}: ${item.item}${item.isContextual ? " [contextual]" : ""} - ${item.reason}`,
          ),
          ...contextualBuild.deviations.map(
            (deviation) =>
              `Swap: ${deviation.genericItem} -> ${deviation.contextualItem} (${deviation.reason})`,
          ),
        ]
      : ["Contextual build recommendation unavailable for this match."];

    const playByPlay = playByPlayAnalyzer.analyzeAllEvents(
      match,
      timeline,
      playerPuuid,
      winProbTimeline,
    );
    const frame10 = getParticipantFrameAtMinute(
      timeline,
      playerParticipant.participantId,
      10,
    );
    const playerDeathsBefore10 = calculateDeathsBefore10(
      timeline,
      playerParticipant.participantId,
    );
    const playerDamageShare = calculateDamageShare(match, playerParticipant);
    const playerKda =
      playerParticipant.deaths === 0
        ? playerParticipant.kills + playerParticipant.assists
        : (playerParticipant.kills + playerParticipant.assists) / playerParticipant.deaths;
    const gameDurationMinutes = Math.max(1, match.info.gameDuration / 60);
    const playerSoloTier = await getPlayerSoloTier(playerPuuid);
    const rankBenchmarks = await rankBenchmarkService.getMultiRankBenchmarks(
      playerParticipant.championName,
      roleFromParticipant(playerParticipant),
      {
        csAt10: frame10
          ? frame10.minionsKilled + frame10.jungleMinionsKilled
          : 0,
        goldAt10: frame10?.totalGold ?? 0,
        visionScore: playerParticipant.visionScore,
        deathsBefore10: playerDeathsBefore10,
        damageShare: playerDamageShare,
        kda: playerKda,
        csPerMin: calculateCs(playerParticipant) / gameDurationMinutes,
        tier: playerSoloTier,
      },
    );
    const compactedData = compactMatchForLLM(
      match,
      timeline,
      playerPuuid,
      winProbTimeline,
      keyMoments,
      compAnalysis,
      extractPlayerRank(match, playerPuuid),
      {
        teamfights: playByPlay.teamfights,
        recalls: playByPlay.recalls,
        goldEfficiency: playByPlay.goldEfficiency,
        aiRelevantEvents: playByPlay.aiRelevantEvents,
        rankBenchmarks: rankBenchmarks.playerTier,
        abilityContext: abilityContextLines,
        wpa: {
          playerSummary: wpaReport.playerContribution,
          allPlayers: wpaReport.playerSummaries,
        },
        similarGameReferences,
        contextualBuildSummary,
      },
    );

    await ensureMatchExists(match);

    const analysis = await aiCoach.analyzeMatch({
      compactedData,
      formatForPrompt,
      matchId: match.metadata.matchId,
      playerPuuid,
      playerChampion: playerParticipant.championName,
      playerItems: [
        playerParticipant.item0,
        playerParticipant.item1,
        playerParticipant.item2,
        playerParticipant.item3,
        playerParticipant.item4,
        playerParticipant.item5,
        playerParticipant.item6,
      ].filter((itemId) => itemId > 0),
      matchPatch: parsePatchFromGameVersion(match.info.gameVersion),
      abilityContext: abilityContextLines.join("\n"),
    });

    return NextResponse.json(analysis);
  } catch (error) {
    if (error instanceof RiotAPIError) {
      if (error.status === 404) {
        return NextResponse.json({ error: "Match not found." }, { status: 404 });
      }

      if (error.status === 429) {
        return NextResponse.json(
          {
            error: "Riot API rate limit exceeded while preparing analysis.",
            retryAfter: error.retryAfter,
          },
          { status: 429 },
        );
      }

      if (error.status === 503 || error.status === 500) {
        return NextResponse.json(
          { error: "Riot API service is temporarily unavailable." },
          { status: 503 },
        );
      }
    }

    console.error("[AnalysisRoute] Unexpected error:", error);
    return NextResponse.json(
      { error: "Failed to generate AI analysis." },
      { status: 500 },
    );
  }
}
