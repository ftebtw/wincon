import { and, desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { classifyBothComps } from "@/lib/comp-classifier";
import { cachedRiotAPI } from "@/lib/cache";
import {
  contextualBuildEngine,
  getChampionClass,
} from "@/lib/contextual-build-engine";
import { getItems } from "@/lib/data-dragon";
import { db, schema } from "@/lib/db";
import { playByPlayAnalyzer } from "@/lib/play-by-play";
import { rankBenchmarkService } from "@/lib/rank-benchmarks";
import { RiotAPIError } from "@/lib/riot-api";
import { wpaEngine, type WPAEvent } from "@/lib/wpa-engine";
import type {
  BuildPathItem,
  LaneStatsDisplay,
  MatchAnalysisResponse,
  ParticipantDisplay,
  TeamDisplay,
} from "@/lib/types/match-analysis";
import type { MatchDto, MatchTimelineDto, ParticipantDto } from "@/lib/types/riot";
import {
  computeMatchWinProbTimeline,
  identifyKeyMoments,
  type KeyMoment,
} from "@/lib/win-probability";

type MatchRouteContext = {
  params: Promise<{
    matchId: string;
  }>;
};

const PLATFORM_TO_REGION: Record<string, string> = {
  na1: "americas",
  br1: "americas",
  la1: "americas",
  la2: "americas",
  oc1: "americas",
  euw1: "europe",
  eun1: "europe",
  tr1: "europe",
  ru: "europe",
  kr: "asia",
  jp1: "asia",
  ph2: "sea",
  sg2: "sea",
  th2: "sea",
  tw2: "sea",
  vn2: "sea",
};

const FALLBACK_REGIONS = ["americas", "europe", "asia", "sea"];

function getRegionCandidates(matchId: string): string[] {
  const platform = matchId.split("_")[0]?.toLowerCase() ?? "";
  const inferred = PLATFORM_TO_REGION[platform];

  if (!inferred) {
    return [...FALLBACK_REGIONS];
  }

  return [inferred, ...FALLBACK_REGIONS.filter((region) => region !== inferred)];
}

function roleFromParticipant(participant: ParticipantDto): string {
  const byTeamPosition: Record<string, string> = {
    TOP: "TOP",
    JUNGLE: "JUNGLE",
    MIDDLE: "MID",
    BOTTOM: "ADC",
    UTILITY: "SUPPORT",
  };

  if (participant.teamPosition in byTeamPosition) {
    return byTeamPosition[participant.teamPosition];
  }

  if (participant.lane === "MIDDLE") {
    return "MID";
  }

  if (participant.lane === "BOTTOM" && participant.role === "DUO_SUPPORT") {
    return "SUPPORT";
  }

  if (participant.lane === "BOTTOM") {
    return "ADC";
  }

  if (participant.lane === "TOP") {
    return "TOP";
  }

  if (participant.lane === "JUNGLE") {
    return "JUNGLE";
  }

  return "UNKNOWN";
}

function calculateCs(participant: ParticipantDto): number {
  return participant.totalMinionsKilled + participant.neutralMinionsKilled;
}

function extractItems(participant: ParticipantDto): number[] {
  return [
    participant.item0,
    participant.item1,
    participant.item2,
    participant.item3,
    participant.item4,
    participant.item5,
    participant.item6,
  ];
}

function toTeamDisplay(participant: ParticipantDto): TeamDisplay {
  return {
    puuid: participant.puuid,
    gameName: participant.riotIdGameName || participant.summonerName,
    champion: participant.championName,
    championId: participant.championId,
    role: roleFromParticipant(participant),
    kills: participant.kills,
    deaths: participant.deaths,
    assists: participant.assists,
    cs: calculateCs(participant),
    items: extractItems(participant),
    win: participant.win,
  };
}

function toParticipantDisplay(participant: ParticipantDto): ParticipantDisplay {
  const kdaRatio =
    participant.deaths === 0
      ? participant.kills + participant.assists
      : (participant.kills + participant.assists) / participant.deaths;

  return {
    ...toTeamDisplay(participant),
    summonerName: participant.summonerName,
    goldEarned: participant.goldEarned,
    damageDealt: participant.totalDamageDealtToChampions,
    damageTaken: participant.totalDamageTaken,
    visionScore: participant.visionScore,
    wardsPlaced: participant.wardsPlaced,
    wardsKilled: participant.wardsKilled,
    kdaRatio,
  };
}

function findLaneOpponent(
  playerParticipant: ParticipantDto,
  enemyParticipants: ParticipantDto[],
): ParticipantDto {
  if (playerParticipant.teamPosition) {
    const byTeamPosition = enemyParticipants.find(
      (participant) => participant.teamPosition === playerParticipant.teamPosition,
    );

    if (byTeamPosition) {
      return byTeamPosition;
    }
  }

  const playerRole = roleFromParticipant(playerParticipant);
  const byRole = enemyParticipants.find(
    (participant) => roleFromParticipant(participant) === playerRole,
  );

  return byRole ?? enemyParticipants[0];
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

function buildLaneStats(
  participant: ParticipantDto,
  timeline: MatchTimelineDto,
): LaneStatsDisplay {
  const frame10 = getParticipantFrameAtMinute(timeline, participant.participantId, 10);
  const frame15 = getParticipantFrameAtMinute(timeline, participant.participantId, 15);

  const csAt10 = frame10
    ? frame10.minionsKilled + frame10.jungleMinionsKilled
    : 0;
  const csAt15 = frame15
    ? frame15.minionsKilled + frame15.jungleMinionsKilled
    : 0;

  return {
    csAt10,
    goldAt10: frame10?.totalGold ?? 0,
    xpAt10: frame10?.xp ?? 0,
    csAt15,
    goldAt15: frame15?.totalGold ?? 0,
    damageDealt: participant.totalDamageDealtToChampions,
    damageTaken: participant.totalDamageTaken,
    visionScore: participant.visionScore,
    wardsPlaced: participant.wardsPlaced,
    wardsKilled: participant.wardsKilled,
    kda: `${participant.kills}/${participant.deaths}/${participant.assists}`,
  };
}

function calculateDeathsBefore10(
  timeline: MatchTimelineDto,
  participantId: number,
): number {
  return timeline.info.frames
    .flatMap((frame) => frame.events)
    .filter(
      (event) =>
        event.type === "CHAMPION_KILL" &&
        event.victimId === participantId &&
        event.timestamp < 10 * 60_000,
    ).length;
}

function calculateDamageShare(match: MatchDto, participant: ParticipantDto): number {
  const teamTotalDamage = match.info.participants
    .filter((entry) => entry.teamId === participant.teamId)
    .reduce((sum, entry) => sum + entry.totalDamageDealtToChampions, 0);

  if (teamTotalDamage <= 0) {
    return 0;
  }

  return participant.totalDamageDealtToChampions / teamTotalDamage;
}

async function getPlayerSoloTier(puuid: string): Promise<string> {
  if (!process.env.DATABASE_URL) {
    return "EMERALD";
  }

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
}

async function fetchMatchWithRegionFallback(
  matchId: string,
): Promise<{ match: MatchDto; timeline: MatchTimelineDto; region: string }> {
  for (const region of getRegionCandidates(matchId)) {
    try {
      const [match, timeline] = await Promise.all([
        cachedRiotAPI.getMatch(matchId, region),
        cachedRiotAPI.getMatchTimeline(matchId, region),
      ]);

      return { match, timeline, region };
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

async function buildPathFromTimeline(
  timeline: MatchTimelineDto,
  participantId: number,
): Promise<BuildPathItem[]> {
  const items = await getItems();
  const purchases: BuildPathItem[] = [];

  for (const frame of timeline.info.frames) {
    for (const event of frame.events) {
      if (
        event.type === "ITEM_PURCHASED" &&
        event.participantId === participantId &&
        typeof event.itemId === "number" &&
        event.itemId > 0
      ) {
        purchases.push({
          itemId: event.itemId,
          timestamp: event.timestamp,
          itemName: items.get(event.itemId)?.name ?? `Item ${event.itemId}`,
        });
      }
    }
  }

  purchases.sort((a, b) => a.timestamp - b.timestamp);
  return purchases;
}

function enrichKeyMomentsWithContext(
  keyMoments: KeyMoment[],
  winProbTimeline: ReturnType<typeof computeMatchWinProbTimeline>,
  wpaEvents: WPAEvent[],
  playerPuuid: string,
) {
  const formatWpa = (value: number) =>
    `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}% WPA`;

  const attributionLabel = (type: string) => {
    if (type === "victim") return "your fault";
    if (type === "killer") return "your play";
    if (type === "assister") return "assist impact";
    return "objective contribution";
  };

  return keyMoments.map((moment) => {
    const point = winProbTimeline.find((entry) => entry.minute === moment.minute);
    const baseContext = point
      ? `Gold diff ${point.gameState.goldDiff >= 0 ? "+" : ""}${point.gameState.goldDiff}, Towers ${point.gameState.towerDiff >= 0 ? "+" : ""}${point.gameState.towerDiff}, Dragons ${point.gameState.dragonDiff >= 0 ? "+" : ""}${point.gameState.dragonDiff}`
      : undefined;

    const relatedWPA = wpaEvents
      .filter((event) => Math.abs(event.timestamp - moment.timestamp) <= 90_000)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    let wpaContext: string | undefined;

    if (relatedWPA) {
      const playerAttribution = relatedWPA.attributions
        .filter((entry) => entry.puuid === playerPuuid)
        .sort((a, b) => Math.abs(b.wpaValue) - Math.abs(a.wpaValue))[0];
      const topOther = relatedWPA.attributions
        .filter((entry) => entry.puuid !== playerPuuid)
        .sort((a, b) => Math.abs(b.wpaValue) - Math.abs(a.wpaValue))[0];

      if (playerAttribution) {
        const youPart = `You ${formatWpa(playerAttribution.wpaValue)} (${attributionLabel(playerAttribution.attributionType)})`;
        const otherPart = topOther
          ? `${topOther.champion} ${formatWpa(topOther.wpaValue)}`
          : undefined;
        wpaContext = [youPart, otherPart].filter(Boolean).join(" | ");
      } else if (topOther) {
        wpaContext = `${topOther.champion} ${formatWpa(topOther.wpaValue)}`;
      }
    }

    const context = [baseContext, wpaContext ? `WPA: ${wpaContext}` : undefined]
      .filter(Boolean)
      .join(" | ");

    return {
      ...moment,
      context: context || undefined,
    };
  });
}

async function persistMatchData(match: MatchDto, timeline: MatchTimelineDto) {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const winningTeam = match.info.teams.find((team) => team.win)?.teamId ?? 100;
  const puuidByParticipantId = new Map<number, string>();

  for (const participant of match.info.participants) {
    puuidByParticipantId.set(participant.participantId, participant.puuid);
  }

  await db.transaction(async (tx) => {
    await tx
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

    await tx
      .insert(schema.matchParticipants)
      .values(
        match.info.participants.map((participant) => ({
          matchId: match.metadata.matchId,
          puuid: participant.puuid,
          participantId: participant.participantId,
          teamId: participant.teamId,
          championId: participant.championId,
          championName: participant.championName,
          role: roleFromParticipant(participant),
          win: participant.win,
          kills: participant.kills,
          deaths: participant.deaths,
          assists: participant.assists,
          cs: calculateCs(participant),
          goldEarned: participant.goldEarned,
          damageDealt: participant.totalDamageDealtToChampions,
          damageTaken: participant.totalDamageTaken,
          visionScore: participant.visionScore,
          items: extractItems(participant),
          runes: participant.perks,
          summonerSpells: {
            summoner1Id: participant.summoner1Id,
            summoner2Id: participant.summoner2Id,
          },
        })),
      )
      .onConflictDoUpdate({
        target: [schema.matchParticipants.matchId, schema.matchParticipants.puuid],
        set: {
          participantId: sql`excluded.participant_id`,
          teamId: sql`excluded.team_id`,
          championId: sql`excluded.champion_id`,
          championName: sql`excluded.champion_name`,
          role: sql`excluded.role`,
          win: sql`excluded.win`,
          kills: sql`excluded.kills`,
          deaths: sql`excluded.deaths`,
          assists: sql`excluded.assists`,
          cs: sql`excluded.cs`,
          goldEarned: sql`excluded.gold_earned`,
          damageDealt: sql`excluded.damage_dealt`,
          damageTaken: sql`excluded.damage_taken`,
          visionScore: sql`excluded.vision_score`,
          items: sql`excluded.items`,
          runes: sql`excluded.runes`,
          summonerSpells: sql`excluded.summoner_spells`,
        },
      });

    await tx
      .delete(schema.matchEvents)
      .where(sql`${schema.matchEvents.matchId} = ${match.metadata.matchId}`);
    await tx
      .delete(schema.timelineFrames)
      .where(sql`${schema.timelineFrames.matchId} = ${match.metadata.matchId}`);

    const eventRows = timeline.info.frames.flatMap((frame) =>
      frame.events.map((event) => ({
        matchId: match.metadata.matchId,
        timestampMs: event.timestamp,
        eventType: event.type,
        killerPuuid:
          typeof event.killerId === "number" ? puuidByParticipantId.get(event.killerId) : null,
        victimPuuid:
          typeof event.victimId === "number" ? puuidByParticipantId.get(event.victimId) : null,
        assistingPuuids:
          event.assistingParticipantIds?.map((id) => puuidByParticipantId.get(id) ?? null) ??
          null,
        positionX: event.position?.x ?? null,
        positionY: event.position?.y ?? null,
        eventData: {
          itemId: event.itemId,
          wardType: event.wardType,
          monsterType: event.monsterType,
          monsterSubType: event.monsterSubType,
          buildingType: event.buildingType,
          towerType: event.towerType,
          laneType: event.laneType,
          bounty: event.bounty,
          shutdownBounty: event.shutdownBounty,
          skillSlot: event.skillSlot,
        },
      })),
    );

    if (eventRows.length > 0) {
      await tx.insert(schema.matchEvents).values(eventRows);
    }

    const frameRows = timeline.info.frames.flatMap((frame) => {
      const frameMinute = Math.floor(frame.timestamp / 60_000);
      return Object.values(frame.participantFrames).map((participantFrame) => ({
        matchId: match.metadata.matchId,
        frameMinute,
        puuid: puuidByParticipantId.get(participantFrame.participantId) ?? "",
        participantId: participantFrame.participantId,
        gold: participantFrame.totalGold,
        xp: participantFrame.xp,
        cs: participantFrame.minionsKilled,
        jungleCs: participantFrame.jungleMinionsKilled,
        level: participantFrame.level,
        positionX: participantFrame.position?.x ?? null,
        positionY: participantFrame.position?.y ?? null,
      }));
    });

    if (frameRows.length > 0) {
      await tx.insert(schema.timelineFrames).values(frameRows);
    }
  });
}

export async function GET(request: Request, { params }: MatchRouteContext) {
  const { matchId } = await params;
  const url = new URL(request.url);
  const playerPuuid = url.searchParams.get("player");

  if (!playerPuuid) {
    return NextResponse.json(
      { error: "Missing required query parameter: player" },
      { status: 400 },
    );
  }

  try {
    const { match, timeline } = await fetchMatchWithRegionFallback(matchId);
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
    const opponentParticipant = findLaneOpponent(playerParticipant, enemyParticipants);

    const allyChampions = match.info.participants
      .filter((participant) => participant.teamId === playerParticipant.teamId)
      .map((participant) => participant.championName);
    const enemyChampions = enemyParticipants.map(
      (participant) => participant.championName,
    );

    const compAnalysis = await classifyBothComps(allyChampions, enemyChampions);
    const winProbTimeline = computeMatchWinProbTimeline(match, timeline, playerPuuid);
    const wpaReport = wpaEngine.computeMatchWPA(
      match,
      timeline,
      winProbTimeline,
      playerPuuid,
    );
    const keyMoments = identifyKeyMoments(winProbTimeline, 6);
    const enrichedKeyMoments = enrichKeyMomentsWithContext(
      keyMoments,
      winProbTimeline,
      wpaReport.events,
      playerPuuid,
    );

    const [playerBuildPath, opponentBuildPath] = await Promise.all([
      buildPathFromTimeline(timeline, playerParticipant.participantId),
      buildPathFromTimeline(timeline, opponentParticipant.participantId),
    ]);
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
        console.warn("[MatchRoute] Contextual build unavailable:", error);
        return undefined;
      });

    const playerLaneStats = buildLaneStats(playerParticipant, timeline);
    const opponentLaneStats = buildLaneStats(opponentParticipant, timeline);
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

    const playByPlay = playByPlayAnalyzer.analyzeAllEvents(
      match,
      timeline,
      playerPuuid,
      winProbTimeline,
    );

    const playerSoloTier = await getPlayerSoloTier(playerPuuid);
    const rankBenchmarks = await rankBenchmarkService.getMultiRankBenchmarks(
      playerParticipant.championName,
      roleFromParticipant(playerParticipant),
      {
        csAt10: playerLaneStats.csAt10,
        goldAt10: playerLaneStats.goldAt10,
        visionScore: playerLaneStats.visionScore,
        deathsBefore10: playerDeathsBefore10,
        damageShare: playerDamageShare,
        kda: playerKda,
        csPerMin: calculateCs(playerParticipant) / gameDurationMinutes,
        tier: playerSoloTier,
      },
    );

    await persistMatchData(match, timeline);

    const winningTeam = match.info.teams.find((team) => team.win)?.teamId ?? 100;
    const response: MatchAnalysisResponse = {
      match: {
        matchId: match.metadata.matchId,
        gameVersion: match.info.gameVersion,
        gameDuration: match.info.gameDuration,
        gameMode: match.info.gameMode,
        queueId: match.info.queueId,
        gameStartTimestamp: match.info.gameStartTimestamp,
        winningTeam,
      },
      teams: {
        blue: match.info.participants
          .filter((participant) => participant.teamId === 100)
          .map(toTeamDisplay),
        red: match.info.participants
          .filter((participant) => participant.teamId === 200)
          .map(toTeamDisplay),
      },
      player: toParticipantDisplay(playerParticipant),
      opponent: toParticipantDisplay(opponentParticipant),
      compAnalysis,
      winProbTimeline,
      keyMoments: enrichedKeyMoments,
      buildPath: {
        player: playerBuildPath,
        opponent: opponentBuildPath,
      },
      playerStats: playerLaneStats,
      opponentStats: opponentLaneStats,
      playByPlay,
      rankBenchmarks,
      wpa: {
        playerSummary: wpaReport.playerContribution,
        allPlayers: wpaReport.playerSummaries,
        events: wpaReport.events,
        mvp: {
          champion: wpaReport.mvp.champion,
          totalWPA: wpaReport.mvp.totalWPA,
        },
      },
      contextualBuild,
    };

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof RiotAPIError) {
      if (error.status === 404) {
        return NextResponse.json({ error: "Match not found." }, { status: 404 });
      }

      if (error.status === 429) {
        return NextResponse.json(
          {
            error: "Riot API rate limited the request.",
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

    console.error("[MatchRoute] Unexpected error:", error);
    return NextResponse.json(
      { error: "Failed to load match analysis." },
      { status: 500 },
    );
  }
}
