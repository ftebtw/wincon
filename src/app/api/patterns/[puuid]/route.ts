import { and, desc, eq, gte } from "drizzle-orm";
import { NextResponse } from "next/server";

import { aiCoach } from "@/lib/ai-coach";
import { aiRateLimiter } from "@/lib/ai-rate-limiter";
import { cachedRiotAPI } from "@/lib/cache";
import { classifyBothComps } from "@/lib/comp-classifier";
import { getItems } from "@/lib/data-dragon";
import { db, schema } from "@/lib/db";
import {
  buildRegionalCandidates,
  getRegionConfig,
  getRegionFromPlatform,
  getRegionFromRequest,
  type Region,
} from "@/lib/regions";
import {
  evaluateBuildCoverage,
  runAllDetectors,
  type GameSummary,
  type MatchWithData,
  type StatPattern,
} from "@/lib/pattern-detector";
import { RiotAPIError } from "@/lib/riot-api";
import type {
  MatchDto,
  MatchTimelineDto,
  ParticipantDto,
  TimelineChampionStatsDto,
  TimelineDamageStatsDto,
  TimelineEventDto,
  TimelineFrameDto,
} from "@/lib/types/riot";
import type { PatternAnalysisOutput } from "@/lib/types/analysis";

type PatternsRouteContext = {
  params: Promise<{
    puuid: string;
  }>;
};

type PatternsApiResponse = {
  statisticalPatterns: StatPattern[];
  aiAnalysis: PatternAnalysisOutput;
  recentGames: GameSummary[];
  generatedAt: string;
  cached: boolean;
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roleFromParticipant(participant: ParticipantDto): string {
  if (participant.teamPosition === "TOP") {
    return "TOP";
  }
  if (participant.teamPosition === "JUNGLE") {
    return "JUNGLE";
  }
  if (participant.teamPosition === "MIDDLE") {
    return "MID";
  }
  if (participant.teamPosition === "BOTTOM") {
    return "ADC";
  }
  if (participant.teamPosition === "UTILITY") {
    return "SUPPORT";
  }

  if (participant.lane === "TOP") {
    return "TOP";
  }
  if (participant.lane === "JUNGLE") {
    return "JUNGLE";
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
  return "UNKNOWN";
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatTimestamp(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function positionLabel(position: { x: number; y: number } | undefined): string {
  if (!position) {
    return "unknown";
  }

  if (Math.abs(position.x - position.y) <= 1500) {
    return "mid";
  }
  if (position.y > position.x + 2200) {
    return "top_side";
  }
  if (position.x > position.y + 2200) {
    return "bot_side";
  }
  return "jungle";
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

function defaultChampionStats(): TimelineChampionStatsDto {
  return {
    abilityPower: 0,
    armor: 0,
    attackDamage: 0,
    attackSpeed: 0,
    health: 0,
    healthMax: 0,
    healthRegen: 0,
    magicResist: 0,
    movementSpeed: 0,
    power: 0,
    powerMax: 0,
    powerRegen: 0,
  };
}

function defaultDamageStats(): TimelineDamageStatsDto {
  return {
    magicDamageDone: 0,
    magicDamageDoneToChampions: 0,
    magicDamageTaken: 0,
    physicalDamageDone: 0,
    physicalDamageDoneToChampions: 0,
    physicalDamageTaken: 0,
    totalDamageDone: 0,
    totalDamageDoneToChampions: 0,
    totalDamageTaken: 0,
    trueDamageDone: 0,
    trueDamageDoneToChampions: 0,
    trueDamageTaken: 0,
  };
}

function toEvent(
  eventRow: {
    eventType: string;
    timestampMs: number;
    killerPuuid: string | null;
    victimPuuid: string | null;
    assistingPuuids: unknown;
    positionX: number | null;
    positionY: number | null;
    eventData: unknown;
  },
  participantIdByPuuid: Map<string, number>,
): TimelineEventDto {
  const eventData = isRecord(eventRow.eventData) ? eventRow.eventData : {};
  const assistingIds = Array.isArray(eventRow.assistingPuuids)
    ? eventRow.assistingPuuids
        .map((puuid) =>
          typeof puuid === "string" ? participantIdByPuuid.get(puuid) : undefined,
        )
        .filter((id): id is number => typeof id === "number")
    : undefined;

  return {
    type: eventRow.eventType,
    timestamp: eventRow.timestampMs,
    killerId:
      eventRow.killerPuuid !== null
        ? participantIdByPuuid.get(eventRow.killerPuuid)
        : undefined,
    victimId:
      eventRow.victimPuuid !== null
        ? participantIdByPuuid.get(eventRow.victimPuuid)
        : undefined,
    assistingParticipantIds: assistingIds,
    position:
      eventRow.positionX !== null && eventRow.positionY !== null
        ? { x: eventRow.positionX, y: eventRow.positionY }
        : undefined,
    itemId: typeof eventData.itemId === "number" ? eventData.itemId : undefined,
    wardType: typeof eventData.wardType === "string" ? eventData.wardType : undefined,
    monsterType: typeof eventData.monsterType === "string" ? eventData.monsterType : undefined,
    monsterSubType:
      typeof eventData.monsterSubType === "string" ? eventData.monsterSubType : undefined,
    buildingType:
      typeof eventData.buildingType === "string" ? eventData.buildingType : undefined,
    towerType: typeof eventData.towerType === "string" ? eventData.towerType : undefined,
    laneType: typeof eventData.laneType === "string" ? eventData.laneType : undefined,
    teamId: typeof eventData.teamId === "number" ? eventData.teamId : undefined,
    bounty: typeof eventData.bounty === "number" ? eventData.bounty : undefined,
    shutdownBounty:
      typeof eventData.shutdownBounty === "number" ? eventData.shutdownBounty : undefined,
    skillSlot: typeof eventData.skillSlot === "number" ? eventData.skillSlot : undefined,
    levelUpType:
      typeof eventData.levelUpType === "string" ? eventData.levelUpType : undefined,
    creatorId: typeof eventData.creatorId === "number" ? eventData.creatorId : undefined,
    participantId:
      typeof eventData.participantId === "number" ? eventData.participantId : undefined,
  };
}

async function loadMatchWithTimelineFromDb(matchId: string): Promise<{ match: MatchDto; timeline: MatchTimelineDto } | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  const matchRows = await db
    .select({
      rawData: schema.matches.rawData,
    })
    .from(schema.matches)
    .where(eq(schema.matches.matchId, matchId))
    .limit(1);

  if (matchRows.length === 0) {
    return null;
  }

  const match = matchRows[0].rawData as MatchDto;
  const [frameRows, eventRows] = await Promise.all([
    db
      .select({
        frameMinute: schema.timelineFrames.frameMinute,
        participantId: schema.timelineFrames.participantId,
        gold: schema.timelineFrames.gold,
        xp: schema.timelineFrames.xp,
        cs: schema.timelineFrames.cs,
        jungleCs: schema.timelineFrames.jungleCs,
        level: schema.timelineFrames.level,
        positionX: schema.timelineFrames.positionX,
        positionY: schema.timelineFrames.positionY,
      })
      .from(schema.timelineFrames)
      .where(eq(schema.timelineFrames.matchId, matchId))
      .orderBy(schema.timelineFrames.frameMinute, schema.timelineFrames.participantId),
    db
      .select({
        eventType: schema.matchEvents.eventType,
        timestampMs: schema.matchEvents.timestampMs,
        killerPuuid: schema.matchEvents.killerPuuid,
        victimPuuid: schema.matchEvents.victimPuuid,
        assistingPuuids: schema.matchEvents.assistingPuuids,
        positionX: schema.matchEvents.positionX,
        positionY: schema.matchEvents.positionY,
        eventData: schema.matchEvents.eventData,
      })
      .from(schema.matchEvents)
      .where(eq(schema.matchEvents.matchId, matchId))
      .orderBy(schema.matchEvents.timestampMs),
  ]);

  if (frameRows.length === 0) {
    return null;
  }

  const participantIdByPuuid = new Map<string, number>();
  for (const participant of match.info.participants) {
    participantIdByPuuid.set(participant.puuid, participant.participantId);
  }

  const framesByMinute = new Map<number, TimelineFrameDto>();

  for (const row of frameRows) {
    const frameMinute = row.frameMinute;
    const existing = framesByMinute.get(frameMinute);
    const frame = existing ?? {
      timestamp: frameMinute * 60_000,
      participantFrames: {},
      events: [],
    };

    frame.participantFrames[String(row.participantId)] = {
      participantId: row.participantId,
      position: {
        x: row.positionX ?? 0,
        y: row.positionY ?? 0,
      },
      currentGold: row.gold,
      totalGold: row.gold,
      xp: row.xp,
      minionsKilled: row.cs,
      jungleMinionsKilled: row.jungleCs,
      level: row.level,
      championStats: defaultChampionStats(),
      damageStats: defaultDamageStats(),
    };

    framesByMinute.set(frameMinute, frame);
  }

  for (const row of eventRows) {
    const frameMinute = Math.floor(row.timestampMs / 60_000);
    const existing = framesByMinute.get(frameMinute);
    const frame = existing ?? {
      timestamp: frameMinute * 60_000,
      participantFrames: {},
      events: [],
    };

    frame.events.push(toEvent(row, participantIdByPuuid));
    framesByMinute.set(frameMinute, frame);
  }

  const frames = [...framesByMinute.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, frame]) => ({
      ...frame,
      events: [...frame.events].sort((a, b) => a.timestamp - b.timestamp),
    }));

  const timeline: MatchTimelineDto = {
    metadata: {
      matchId: match.metadata.matchId,
      participants: match.metadata.participants,
    },
    info: {
      frameInterval: 60_000,
      frames,
      participants: match.info.participants.map((participant) => ({
        participantId: participant.participantId,
        puuid: participant.puuid,
      })),
    },
  };

  return { match, timeline };
}

async function fetchMatchWithTimelineFromRiot(
  matchId: string,
  selectedRegion: Region,
  preferredRegion?: string,
): Promise<{ match: MatchDto; timeline: MatchTimelineDto }> {
  const orderedRegions = preferredRegion
    ? [
        preferredRegion,
        ...getRegionCandidates(matchId, selectedRegion).filter(
          (region) => region !== preferredRegion,
        ),
      ]
    : getRegionCandidates(matchId, selectedRegion);

  for (const region of orderedRegions) {
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

async function persistMatchAndTimeline(match: MatchDto, timeline: MatchTimelineDto): Promise<void> {
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

    await tx.delete(schema.matchEvents).where(eq(schema.matchEvents.matchId, match.metadata.matchId));
    await tx.delete(schema.timelineFrames).where(eq(schema.timelineFrames.matchId, match.metadata.matchId));

    const eventRows = timeline.info.frames.flatMap((frame) =>
      frame.events.map((event) => ({
        matchId: match.metadata.matchId,
        timestampMs: event.timestamp,
        eventType: event.type,
        killerPuuid:
          typeof event.killerId === "number" ? puuidByParticipantId.get(event.killerId) ?? null : null,
        victimPuuid:
          typeof event.victimId === "number" ? puuidByParticipantId.get(event.victimId) ?? null : null,
        assistingPuuids: Array.isArray(event.assistingParticipantIds)
          ? event.assistingParticipantIds
              .map((id) => puuidByParticipantId.get(id) ?? null)
              .filter((puuid): puuid is string => puuid !== null)
          : null,
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
          teamId: event.teamId,
          bounty: event.bounty,
          shutdownBounty: event.shutdownBounty,
          skillSlot: event.skillSlot,
          levelUpType: event.levelUpType,
          creatorId: typeof event.creatorId === "number" ? event.creatorId : undefined,
          participantId:
            typeof event.participantId === "number" ? event.participantId : undefined,
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

async function getRecentMatchIds(
  puuid: string,
  count = 15,
  selectedRegion: Region,
): Promise<{ matchIds: string[]; regionHint?: string }> {
  const fallbackRegions = buildRegionalCandidates({ preferredRegion: selectedRegion });
  let fallback: string[] = [];

  for (const region of fallbackRegions) {
    try {
      const matchIds = await cachedRiotAPI.getMatchIds(puuid, { count, queue: 420 }, region);
      if (matchIds.length > 0) {
        return { matchIds, regionHint: region };
      }

      if (fallback.length === 0) {
        fallback = matchIds;
      }
    } catch (error) {
      if (error instanceof RiotAPIError && error.status === 404) {
        continue;
      }

      throw error;
    }
  }

  return { matchIds: fallback };
}

async function getPlayerIdentity(puuid: string): Promise<{
  gameName: string;
  tagLine: string;
  tier: string;
  division: string;
}> {
  if (!process.env.DATABASE_URL) {
    return {
      gameName: "Unknown",
      tagLine: "NA1",
      tier: "Unknown",
      division: "Unknown",
    };
  }

  const [playerRow, rankRow] = await Promise.all([
    db
      .select({
        gameName: schema.players.gameName,
        tagLine: schema.players.tagLine,
      })
      .from(schema.players)
      .where(eq(schema.players.puuid, puuid))
      .limit(1),
    db
      .select({
        tier: schema.rankedStats.tier,
        rankDivision: schema.rankedStats.rankDivision,
      })
      .from(schema.rankedStats)
      .where(and(eq(schema.rankedStats.puuid, puuid), eq(schema.rankedStats.queueType, "RANKED_SOLO_5x5")))
      .orderBy(desc(schema.rankedStats.fetchedAt))
      .limit(1),
  ]);

  return {
    gameName: playerRow[0]?.gameName ?? "Unknown",
    tagLine: playerRow[0]?.tagLine ?? "NA1",
    tier: rankRow[0]?.tier ?? "Unknown",
    division: rankRow[0]?.rankDivision ?? "Unknown",
  };
}

async function getCachedPatternBundle(puuid: string): Promise<PatternsApiResponse | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  const cutoff = new Date(Date.now() - CACHE_TTL_MS);
  const rows = await db
    .select({
      details: schema.playerPatterns.details,
    })
    .from(schema.playerPatterns)
    .where(
      and(
        eq(schema.playerPatterns.puuid, puuid),
        eq(schema.playerPatterns.patternType, "analysis_bundle"),
        gte(schema.playerPatterns.lastComputed, cutoff),
      ),
    )
    .orderBy(desc(schema.playerPatterns.lastComputed))
    .limit(1);

  if (rows.length === 0 || !isRecord(rows[0].details)) {
    return null;
  }

  const details = rows[0].details;
  if (
    !Array.isArray(details.statisticalPatterns) ||
    !Array.isArray(details.recentGames) ||
    !isRecord(details.aiAnalysis) ||
    typeof details.generatedAt !== "string"
  ) {
    return null;
  }

  return {
    statisticalPatterns: details.statisticalPatterns as StatPattern[],
    recentGames: details.recentGames as GameSummary[],
    aiAnalysis: details.aiAnalysis as unknown as PatternAnalysisOutput,
    generatedAt: details.generatedAt,
    cached: true,
  };
}

async function savePatternBundle(puuid: string, bundle: Omit<PatternsApiResponse, "cached">): Promise<void> {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const matchIds = bundle.recentGames.map((game) => game.matchId);

  await db.insert(schema.playerPatterns).values([
    {
      puuid,
      patternType: "analysis_bundle",
      frequency: "0.0000",
      matchIds,
      details: bundle,
      lastComputed: new Date(),
    },
    ...bundle.statisticalPatterns.map((pattern) => ({
      puuid,
      patternType: `stat:${pattern.type}`,
      frequency: pattern.frequency.toFixed(4),
      matchIds: pattern.matchIds,
      details: pattern,
      lastComputed: new Date(),
    })),
  ]);
}

async function buildGameSummary(
  entry: MatchWithData,
  itemNames: Map<number, string>,
): Promise<GameSummary | null> {
  const player = entry.match.info.participants.find((participant) => participant.puuid === entry.playerPuuid);
  if (!player) {
    return null;
  }

  const earlyDeaths = entry.timeline.info.frames.flatMap((frame) =>
    frame.events.filter(
      (event) =>
        event.type === "CHAMPION_KILL" &&
        event.victimId === player.participantId &&
        event.timestamp < 10 * 60_000,
    ),
  );

  const deathPositions = Array.from(
    new Set(earlyDeaths.map((death) => positionLabel(death.position))),
  ).join(", ");

  const firstItemEvent = entry.timeline.info.frames
    .flatMap((frame) => frame.events)
    .filter(
      (event) =>
        event.type === "ITEM_PURCHASED" &&
        typeof event.participantId === "number" &&
        event.participantId === player.participantId &&
        typeof event.itemId === "number",
    )
    .sort((a, b) => a.timestamp - b.timestamp)[0];

  const itemIds = [player.item0, player.item1, player.item2, player.item3, player.item4, player.item5, player.item6]
    .filter((itemId) => itemId > 0);
  const itemText = itemIds
    .map((itemId) => itemNames.get(itemId) ?? `Item ${itemId}`)
    .join(", ");

  const allies = entry.match.info.participants
    .filter((participant) => participant.teamId === player.teamId)
    .map((participant) => participant.championName);
  const enemies = entry.match.info.participants
    .filter((participant) => participant.teamId !== player.teamId)
    .map((participant) => participant.championName);
  const compAnalysis = await classifyBothComps(allies, enemies);

  const buildCoverage = evaluateBuildCoverage(entry.match, entry.playerPuuid);
  const visionPerMinute = player.visionScore / Math.max(1, entry.match.info.gameDuration / 60);

  const biggestMistake = earlyDeaths.length > 0
    ? `Early deaths (${earlyDeaths.length})`
    : buildCoverage && !buildCoverage.isAppropriate
      ? "Build did not adapt to enemy comp"
      : visionPerMinute < 0.8
        ? "Low vision contribution"
        : "No major repeated issue in this game";

  return {
    matchId: entry.match.metadata.matchId,
    champion: player.championName,
    role: roleFromParticipant(player),
    result: player.win ? "WIN" : "LOSS",
    kda: `${player.kills}/${player.deaths}/${player.assists}`,
    cs: player.totalMinionsKilled + player.neutralMinionsKilled,
    duration: formatDuration(entry.match.info.gameDuration),
    earlyDeaths: earlyDeaths.length,
    deathPositions: deathPositions || "none",
    visionScore: player.visionScore,
    wardsPlaced: player.wardsPlaced,
    firstItemTime: firstItemEvent ? formatTimestamp(firstItemEvent.timestamp) : "N/A",
    items: itemText || "No completed items",
    biggestMistake,
    allyCompTags: compAnalysis.ally.tags.join(", "),
    enemyCompTags: compAnalysis.enemy.tags.join(", "),
    buildAppropriate: buildCoverage?.isAppropriate ?? true,
  };
}

export async function GET(_request: Request, { params }: PatternsRouteContext) {
  const selectedRegion = getRegionFromRequest(_request);
  const { puuid } = await params;

  const rateLimit = aiRateLimiter.consume(_request, { userId: puuid });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: rateLimit.message,
        resetAt: rateLimit.resetAt,
      },
      { status: 429 },
    );
  }

  try {
    const cached = await getCachedPatternBundle(puuid);
    if (cached) {
      return NextResponse.json(cached);
    }

    const { matchIds, regionHint } = await getRecentMatchIds(
      puuid,
      15,
      selectedRegion,
    );
    if (matchIds.length === 0) {
      return NextResponse.json(
        { error: "No recent ranked matches found for this player." },
        { status: 404 },
      );
    }

    const loadedMatches = await Promise.allSettled(
      matchIds.map(async (matchId) => {
        const cachedMatch = await loadMatchWithTimelineFromDb(matchId);
        if (cachedMatch) {
          return {
            ...cachedMatch,
            playerPuuid: puuid,
          } satisfies MatchWithData;
        }

        const fetched = await fetchMatchWithTimelineFromRiot(
          matchId,
          selectedRegion,
          regionHint,
        );
        await persistMatchAndTimeline(fetched.match, fetched.timeline);

        return {
          ...fetched,
          playerPuuid: puuid,
        } satisfies MatchWithData;
      }),
    );

    const matchesWithData = loadedMatches
      .filter((result): result is PromiseFulfilledResult<MatchWithData> => result.status === "fulfilled")
      .map((result) => result.value);

    if (matchesWithData.length === 0) {
      return NextResponse.json(
        { error: "Unable to load enough match data for pattern analysis." },
        { status: 502 },
      );
    }

    const statisticalPatterns = runAllDetectors(matchesWithData);
    const itemData = await getItems();
    const itemNames = new Map<number, string>();
    for (const [itemId, item] of itemData.entries()) {
      itemNames.set(itemId, item.name);
    }

    const recentGames = (
      await Promise.all(matchesWithData.map((entry) => buildGameSummary(entry, itemNames)))
    ).filter((summary): summary is GameSummary => summary !== null);

    const identity = await getPlayerIdentity(puuid);
    const aiAnalysis = await aiCoach.detectPatterns({
      playerPuuid: puuid,
      playerInfo: {
        gameName: identity.gameName,
        tagLine: identity.tagLine,
        tier: identity.tier,
        division: identity.division,
      },
      recentGames,
      detectedPatterns: statisticalPatterns,
    });

    const responseBody: Omit<PatternsApiResponse, "cached"> = {
      statisticalPatterns,
      aiAnalysis,
      recentGames,
      generatedAt: new Date().toISOString(),
    };

    await savePatternBundle(puuid, responseBody);

    return NextResponse.json({
      ...responseBody,
      cached: false,
    } satisfies PatternsApiResponse);
  } catch (error) {
    if (error instanceof RiotAPIError) {
      if (error.status === 429) {
        return NextResponse.json(
          {
            error: "Riot API rate limit exceeded during pattern analysis.",
            retryAfter: error.retryAfter,
          },
          { status: 429 },
        );
      }

      if (error.status === 404) {
        return NextResponse.json(
          { error: "Unable to find match data for this player." },
          { status: 404 },
        );
      }

      if (error.status === 503 || error.status === 500) {
        return NextResponse.json(
          { error: "Riot API service is temporarily unavailable." },
          { status: 503 },
        );
      }
    }

    console.error("[PatternsRoute] Unexpected error:", error);
    return NextResponse.json(
      { error: "Failed to analyze player patterns." },
      { status: 500 },
    );
  }
}
