import {
  and,
  desc,
  eq,
  inArray,
  like,
  ne,
  sql,
} from "drizzle-orm";

import { CachedRiotAPI, inMemoryCache } from "@/lib/cache";
import { classifyBothComps } from "@/lib/comp-classifier";
import { getLatestVersion } from "@/lib/data-dragon";
import { db, schema } from "@/lib/db";
import { gameStateEncoder } from "@/lib/game-state-encoder";
import {
  getRegionConfig,
  getRegionFromPlatform,
  type Region,
} from "@/lib/regions";
import { backgroundRiotRateLimiter } from "@/lib/rate-limiter";
import { RiotAPIClient } from "@/lib/riot-api";
import { RiotAPIError } from "@/lib/riot-api";
import type {
  HighEloTier,
  LeagueListDto,
  MatchDto,
  MatchTimelineDto,
  ParticipantDto,
} from "@/lib/types/riot";

const COLLECTION_REGIONS: Region[] = ["NA", "EUW", "KR"];
const COLLECTION_PLATFORMS = COLLECTION_REGIONS.map(
  (region) => getRegionConfig(region).platform,
) as string[];

const ROLE_NORMALIZATION: Record<string, string> = {
  TOP: "TOP",
  JUNGLE: "JUNGLE",
  MIDDLE: "MID",
  MID: "MID",
  BOTTOM: "ADC",
  ADC: "ADC",
  UTILITY: "SUPPORT",
  SUPPORT: "SUPPORT",
};

type BuildAccumulator = {
  championId: number;
  role: string;
  allyTags: string[];
  enemyTags: string[];
  itemBuildPath: number[];
  wins: number;
  sampleSize: number;
  totalDuration: number;
};

type ChampionAccumulator = {
  championId: number;
  championName: string;
  role: string;
  gamesPlayed: number;
  wins: number;
  totalKills: number;
  totalDeaths: number;
  totalAssists: number;
  totalCs: number;
  totalVision: number;
  totalCsAt10: number;
  csAt10Samples: number;
  totalGoldAt10: number;
  goldAt10Samples: number;
};

export interface CollectionReport {
  playersScanned: number;
  newMatchesFound: number;
  matchesStored: number;
  matchesFailed: number;
  rateLimitHits: number;
  duration: number;
  patch: string;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parsePatchFromGameVersion(gameVersion: string): string {
  const [major, minor] = gameVersion.split(".");
  if (!major || !minor) {
    return gameVersion;
  }

  return `${major}.${minor}`;
}

function inferRegionFromMatchId(matchId: string): string {
  const platform = matchId.split("_")[0]?.toLowerCase() ?? "";
  const region = getRegionFromPlatform(platform);
  return region ? getRegionConfig(region).regional : "americas";
}

function normalizeRole(rawRole: string): string {
  if (!rawRole) {
    return "UNKNOWN";
  }

  return ROLE_NORMALIZATION[rawRole.toUpperCase()] ?? rawRole.toUpperCase();
}

function roleFromParticipant(participant: ParticipantDto): string {
  if (participant.teamPosition) {
    return normalizeRole(participant.teamPosition);
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

function participantItems(participant: ParticipantDto): number[] {
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

function toBuildPath(items: unknown): number[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((itemId) => Number(itemId))
    .filter((itemId): itemId is number => Number.isFinite(itemId) && itemId > 0)
    .slice(0, 5);
}

function toDecimal(value: number, fractionDigits: number): string {
  if (!Number.isFinite(value)) {
    return (0).toFixed(fractionDigits);
  }

  return value.toFixed(fractionDigits);
}

export async function getCurrentPatch(): Promise<string> {
  const latestVersion = await getLatestVersion();
  const [major, minor] = latestVersion.split(".");

  if (!major || !minor) {
    return latestVersion;
  }

  return `${major}.${minor}`;
}

export class DataCollector {
  private riotAPI: CachedRiotAPI;
  private playerRegionByPuuid = new Map<string, string>();
  private minDelayMs: number;
  private rateLimitHits = 0;
  private onlyCurrentPatch = false;
  private currentPatch = "";

  constructor(riotAPI?: CachedRiotAPI, options?: { minDelayMs?: number }) {
    this.riotAPI =
      riotAPI ??
      new CachedRiotAPI(
        new RiotAPIClient(),
        inMemoryCache,
        backgroundRiotRateLimiter,
      );
    this.minDelayMs = options?.minDelayMs ?? 200;
  }

  private async backgroundDelay() {
    if (this.minDelayMs > 0) {
      await sleep(this.minDelayMs);
    }
  }

  private async withBackoff<T>(label: string, operation: () => Promise<T>): Promise<T | null> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof RiotAPIError && error.status === 429) {
          this.rateLimitHits += 1;
          const retryAfterSeconds = error.retryAfter ?? Math.min(8, 2 ** attempt);
          const waitMs = Math.max(1000, retryAfterSeconds * 1000);
          console.warn(`[Collector] Rate limited during ${label}. Backing off for ${waitMs}ms.`);
          await sleep(waitMs);
          continue;
        }

        console.error(`[Collector] ${label} failed:`, error);
        return null;
      }
    }

    return null;
  }

  private async filterMissingMatchIds(matchIds: string[]): Promise<string[]> {
    if (!process.env.DATABASE_URL || matchIds.length === 0) {
      return matchIds;
    }

    const existingRows = await db
      .select({ matchId: schema.matches.matchId })
      .from(schema.matches)
      .where(inArray(schema.matches.matchId, matchIds));

    const existing = new Set(existingRows.map((row) => row.matchId));
    return matchIds.filter((matchId) => !existing.has(matchId));
  }

  private async getParticipantRanks(puuids: string[]): Promise<Map<string, string>> {
    const byPuuid = new Map<string, string>();
    if (!process.env.DATABASE_URL || puuids.length === 0) {
      return byPuuid;
    }

    const rankedRows = await db
      .select({
        puuid: schema.rankedStats.puuid,
        tier: schema.rankedStats.tier,
      })
      .from(schema.rankedStats)
      .where(
        and(
          inArray(schema.rankedStats.puuid, puuids),
          eq(schema.rankedStats.queueType, "RANKED_SOLO_5x5"),
        ),
      )
      .orderBy(desc(schema.rankedStats.fetchedAt));

    for (const row of rankedRows) {
      if (byPuuid.has(row.puuid)) {
        continue;
      }
      byPuuid.set(row.puuid, row.tier || "UNKNOWN");
    }

    return byPuuid;
  }

  private async persistMatch(match: MatchDto, timeline: MatchTimelineDto): Promise<void> {
    if (!process.env.DATABASE_URL) {
      return;
    }

    const winningTeam = match.info.teams.find((team) => team.win)?.teamId ?? 100;
    const puuidByParticipantId = new Map<number, string>();
    const rankByPuuid = await this.getParticipantRanks(
      match.info.participants.map((participant) => participant.puuid),
    );
    const patch = parsePatchFromGameVersion(match.info.gameVersion);

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
            cs: participant.totalMinionsKilled + participant.neutralMinionsKilled,
            goldEarned: participant.goldEarned,
            damageDealt: participant.totalDamageDealtToChampions,
            damageTaken: participant.totalDamageTaken,
            visionScore: participant.visionScore,
            items: participantItems(participant),
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
        .where(eq(schema.matchEvents.matchId, match.metadata.matchId));
      await tx
        .delete(schema.timelineFrames)
        .where(eq(schema.timelineFrames.matchId, match.metadata.matchId));

      const eventRows = timeline.info.frames.flatMap((frame) =>
        frame.events.map((event) => ({
          matchId: match.metadata.matchId,
          timestampMs: event.timestamp,
          eventType: event.type,
          killerPuuid:
            typeof event.killerId === "number"
              ? puuidByParticipantId.get(event.killerId) ?? null
              : null,
          victimPuuid:
            typeof event.victimId === "number"
              ? puuidByParticipantId.get(event.victimId) ?? null
              : null,
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

      await tx
        .delete(schema.gameStateVectors)
        .where(eq(schema.gameStateVectors.matchId, match.metadata.matchId));

      const vectorRows = match.info.participants.flatMap((participant) => {
        const vectors = gameStateEncoder.encodeAllKeyMoments(
          match,
          timeline,
          participant.puuid,
        );

        return vectors.map((vector) => ({
          matchId: match.metadata.matchId,
          minute: vector.metadata.minute,
          playerPuuid: participant.puuid,
          championId: participant.championId,
          championName: participant.championName,
          role: vector.metadata.playerRole,
          rank: rankByPuuid.get(participant.puuid) ?? "UNKNOWN",
          isProGame: false,
          playerName: participant.riotIdGameName ?? participant.summonerName,
          teamName: null,
          patch,
          features: vector.features,
          outcome: vector.outcome,
        }));
      });

      if (vectorRows.length > 0) {
        await tx.insert(schema.gameStateVectors).values(vectorRows);
      }
    });
  }

  async getHighEloPlayers(
    tier: HighEloTier,
    queue = "RANKED_SOLO_5x5",
  ): Promise<string[]> {
    const puuids = new Set<string>();

    for (const platform of COLLECTION_PLATFORMS) {
      const league = await this.withBackoff<LeagueListDto>(
        `fetch ${tier} league (${platform})`,
        () => this.riotAPI.getLeagueByTier(tier, queue, platform, "low"),
      );

      if (!league) {
        continue;
      }

      for (const entry of league.entries) {
        const region = getRegionFromPlatform(platform);
        const regionalRouting = region ? getRegionConfig(region).regional : "americas";

        if (entry.puuid) {
          puuids.add(entry.puuid);
          this.playerRegionByPuuid.set(entry.puuid, regionalRouting);
          await this.backgroundDelay();
          continue;
        }

        const summonerId = entry.summonerId;
        if (!summonerId) {
          continue;
        }

        const summoner = await this.withBackoff(
          `resolve summoner ${summonerId} (${platform})`,
          () => this.riotAPI.getSummonerById(summonerId, platform, "low"),
        );

        if (summoner?.puuid) {
          puuids.add(summoner.puuid);
          this.playerRegionByPuuid.set(summoner.puuid, regionalRouting);
        }

        await this.backgroundDelay();
      }
    }

    return Array.from(puuids);
  }

  async crawlPlayerMatches(
    puuid: string,
    options: {
      count?: number;
      startTime?: number;
      queue?: number;
    },
  ): Promise<string[]> {
    const region = this.playerRegionByPuuid.get(puuid) ?? "americas";
    const count = Math.min(Math.max(options.count ?? 20, 1), 100);

    const matchIds = await this.withBackoff<string[]>(
      `crawl matches for ${puuid}`,
      () =>
        this.riotAPI.getMatchIds(
          puuid,
          {
            count,
            queue: options.queue ?? 420,
            startTime: options.startTime,
          },
          region,
          "low",
        ),
    );

    if (!matchIds) {
      return [];
    }

    await this.backgroundDelay();
    return this.filterMissingMatchIds(matchIds);
  }

  async fetchAndStoreMatch(matchId: string): Promise<boolean> {
    const region = inferRegionFromMatchId(matchId);
    const payload = await this.withBackoff(
      `fetch match ${matchId}`,
      async () => {
        const [match, timeline] = await Promise.all([
          this.riotAPI.getMatch(matchId, region, "low"),
          this.riotAPI.getMatchTimeline(matchId, region, "low"),
        ]);

        return { match, timeline };
      },
    );

    if (!payload) {
      return false;
    }

    if (this.onlyCurrentPatch && this.currentPatch) {
      const matchPatch = parsePatchFromGameVersion(payload.match.info.gameVersion);
      if (matchPatch !== this.currentPatch) {
        return false;
      }
    }

    try {
      await this.persistMatch(payload.match, payload.timeline);
      await this.backgroundDelay();
      return true;
    } catch (error) {
      console.error(`[Collector] Failed to persist match ${matchId}:`, error);
      return false;
    }
  }

  async recomputeBuildStats(patch: string): Promise<void> {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for recomputeBuildStats.");
    }

    await db.update(schema.buildStats).set({ isStale: true }).where(ne(schema.buildStats.patch, patch));
    await db.delete(schema.buildStats).where(eq(schema.buildStats.patch, patch));

    const patchMatches = await db
      .select({
        matchId: schema.matches.matchId,
        gameDuration: schema.matches.gameDuration,
      })
      .from(schema.matches)
      .where(and(like(schema.matches.gameVersion, `${patch}.%`), eq(schema.matches.queueId, 420)));

    if (patchMatches.length === 0) {
      return;
    }

    const matchIds = patchMatches.map((match) => match.matchId);
    const matchDurationById = new Map(
      patchMatches.map((match) => [match.matchId, match.gameDuration]),
    );

    const participants = await db
      .select({
        matchId: schema.matchParticipants.matchId,
        championId: schema.matchParticipants.championId,
        championName: schema.matchParticipants.championName,
        role: schema.matchParticipants.role,
        teamId: schema.matchParticipants.teamId,
        win: schema.matchParticipants.win,
        items: schema.matchParticipants.items,
      })
      .from(schema.matchParticipants)
      .where(inArray(schema.matchParticipants.matchId, matchIds));

    const byMatch = new Map<string, typeof participants>();
    for (const participant of participants) {
      const existing = byMatch.get(participant.matchId) ?? [];
      existing.push(participant);
      byMatch.set(participant.matchId, existing);
    }

    const aggregates = new Map<string, BuildAccumulator>();

    for (const [matchId, rows] of byMatch) {
      const blueChampions = rows
        .filter((row) => row.teamId === 100)
        .map((row) => row.championName);
      const redChampions = rows
        .filter((row) => row.teamId === 200)
        .map((row) => row.championName);

      if (blueChampions.length === 0 || redChampions.length === 0) {
        continue;
      }

      const comp = await classifyBothComps(blueChampions, redChampions);
      const duration = matchDurationById.get(matchId) ?? 0;

      for (const row of rows) {
        const role = normalizeRole(row.role);
        if (!["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"].includes(role)) {
          continue;
        }

        const allyTags = row.teamId === 100 ? comp.ally.tags : comp.enemy.tags;
        const enemyTags = row.teamId === 100 ? comp.enemy.tags : comp.ally.tags;
        const buildPath = toBuildPath(row.items);

        if (buildPath.length === 0) {
          continue;
        }

        const sortedAlly = [...allyTags].sort();
        const sortedEnemy = [...enemyTags].sort();
        const key = `${row.championId}|${role}|${sortedAlly.join(",")}|${sortedEnemy.join(",")}|${buildPath.join("-")}`;

        const existing = aggregates.get(key);
        if (existing) {
          existing.sampleSize += 1;
          existing.wins += row.win ? 1 : 0;
          existing.totalDuration += duration;
          continue;
        }

        aggregates.set(key, {
          championId: row.championId,
          role,
          allyTags: sortedAlly,
          enemyTags: sortedEnemy,
          itemBuildPath: buildPath,
          wins: row.win ? 1 : 0,
          sampleSize: 1,
          totalDuration: duration,
        });
      }
    }

    if (aggregates.size === 0) {
      return;
    }

    const rows: Array<typeof schema.buildStats.$inferInsert> = Array.from(aggregates.values())
      .map((aggregate) => ({
        championId: aggregate.championId,
        role: aggregate.role,
        allyCompTags: aggregate.allyTags,
        enemyCompTags: aggregate.enemyTags,
        itemBuildPath: aggregate.itemBuildPath,
        sampleSize: aggregate.sampleSize,
        winRate: toDecimal(aggregate.wins / Math.max(1, aggregate.sampleSize), 4),
        avgGameLength: Math.round(aggregate.totalDuration / Math.max(1, aggregate.sampleSize)),
        patch,
        isStale: false,
        computedAt: new Date(),
      }))
      .sort((a, b) => (Number(b.sampleSize) - Number(a.sampleSize)));

    const chunkSize = 200;
    for (let index = 0; index < rows.length; index += chunkSize) {
      await db.insert(schema.buildStats).values(rows.slice(index, index + chunkSize));
    }
  }

  async recomputeChampionStats(patch: string): Promise<void> {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for recomputeChampionStats.");
    }

    await db
      .update(schema.championStats)
      .set({ isStale: true })
      .where(ne(schema.championStats.patch, patch));
    await db.delete(schema.championStats).where(eq(schema.championStats.patch, patch));

    const patchMatches = await db
      .select({
        matchId: schema.matches.matchId,
        rawData: schema.matches.rawData,
      })
      .from(schema.matches)
      .where(and(like(schema.matches.gameVersion, `${patch}.%`), eq(schema.matches.queueId, 420)));

    if (patchMatches.length === 0) {
      return;
    }

    const matchIds = patchMatches.map((match) => match.matchId);

    const participants = await db
      .select({
        matchId: schema.matchParticipants.matchId,
        puuid: schema.matchParticipants.puuid,
        championId: schema.matchParticipants.championId,
        championName: schema.matchParticipants.championName,
        role: schema.matchParticipants.role,
        win: schema.matchParticipants.win,
        kills: schema.matchParticipants.kills,
        deaths: schema.matchParticipants.deaths,
        assists: schema.matchParticipants.assists,
        cs: schema.matchParticipants.cs,
        visionScore: schema.matchParticipants.visionScore,
      })
      .from(schema.matchParticipants)
      .where(inArray(schema.matchParticipants.matchId, matchIds));

    const frame10Rows = await db
      .select({
        matchId: schema.timelineFrames.matchId,
        puuid: schema.timelineFrames.puuid,
        cs: schema.timelineFrames.cs,
        jungleCs: schema.timelineFrames.jungleCs,
        gold: schema.timelineFrames.gold,
      })
      .from(schema.timelineFrames)
      .where(
        and(
          inArray(schema.timelineFrames.matchId, matchIds),
          eq(schema.timelineFrames.frameMinute, 10),
        ),
      );

    const frame10ByKey = new Map<string, { csAt10: number; goldAt10: number }>();
    for (const frame of frame10Rows) {
      frame10ByKey.set(`${frame.matchId}:${frame.puuid}`, {
        csAt10: frame.cs + frame.jungleCs,
        goldAt10: frame.gold,
      });
    }

    const totalByRole = new Map<string, number>();
    for (const participant of participants) {
      const role = normalizeRole(participant.role);
      totalByRole.set(role, (totalByRole.get(role) ?? 0) + 1);
    }

    const banCounts = new Map<number, number>();
    for (const match of patchMatches) {
      const rawMatch = match.rawData as MatchDto;
      for (const team of rawMatch.info.teams) {
        for (const ban of team.bans) {
          if (!ban.championId || ban.championId <= 0) {
            continue;
          }
          banCounts.set(ban.championId, (banCounts.get(ban.championId) ?? 0) + 1);
        }
      }
    }

    const aggregates = new Map<string, ChampionAccumulator>();

    for (const participant of participants) {
      const role = normalizeRole(participant.role);
      if (!["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"].includes(role)) {
        continue;
      }

      const key = `${participant.championId}|${participant.championName}|${role}`;
      const frame = frame10ByKey.get(`${participant.matchId}:${participant.puuid}`);
      const existing = aggregates.get(key);

      if (existing) {
        existing.gamesPlayed += 1;
        existing.wins += participant.win ? 1 : 0;
        existing.totalKills += participant.kills;
        existing.totalDeaths += participant.deaths;
        existing.totalAssists += participant.assists;
        existing.totalCs += participant.cs;
        existing.totalVision += participant.visionScore;
        if (frame) {
          existing.totalCsAt10 += frame.csAt10;
          existing.csAt10Samples += 1;
          existing.totalGoldAt10 += frame.goldAt10;
          existing.goldAt10Samples += 1;
        }
        continue;
      }

      aggregates.set(key, {
        championId: participant.championId,
        championName: participant.championName,
        role,
        gamesPlayed: 1,
        wins: participant.win ? 1 : 0,
        totalKills: participant.kills,
        totalDeaths: participant.deaths,
        totalAssists: participant.assists,
        totalCs: participant.cs,
        totalVision: participant.visionScore,
        totalCsAt10: frame?.csAt10 ?? 0,
        csAt10Samples: frame ? 1 : 0,
        totalGoldAt10: frame?.goldAt10 ?? 0,
        goldAt10Samples: frame ? 1 : 0,
      });
    }

    if (aggregates.size === 0) {
      return;
    }

    const totalMatches = patchMatches.length;
    const rows: Array<typeof schema.championStats.$inferInsert> = Array.from(aggregates.values())
      .map((aggregate) => {
        const roleTotal = totalByRole.get(aggregate.role) ?? aggregate.gamesPlayed;
        const banRate = (banCounts.get(aggregate.championId) ?? 0) / Math.max(1, totalMatches);

        return {
          championId: aggregate.championId,
          championName: aggregate.championName,
          role: aggregate.role,
          patch,
          tier: "ALL",
          gamesPlayed: aggregate.gamesPlayed,
          wins: aggregate.wins,
          winRate: toDecimal(aggregate.wins / Math.max(1, aggregate.gamesPlayed), 4),
          pickRate: toDecimal(aggregate.gamesPlayed / Math.max(1, roleTotal), 4),
          banRate: toDecimal(banRate, 4),
          avgKills: toDecimal(aggregate.totalKills / Math.max(1, aggregate.gamesPlayed), 1),
          avgDeaths: toDecimal(aggregate.totalDeaths / Math.max(1, aggregate.gamesPlayed), 1),
          avgAssists: toDecimal(aggregate.totalAssists / Math.max(1, aggregate.gamesPlayed), 1),
          avgCs: toDecimal(aggregate.totalCs / Math.max(1, aggregate.gamesPlayed), 1),
          avgCsAt10: toDecimal(
            aggregate.totalCsAt10 / Math.max(1, aggregate.csAt10Samples),
            1,
          ),
          avgGoldAt10: toDecimal(
            aggregate.totalGoldAt10 / Math.max(1, aggregate.goldAt10Samples),
            0,
          ),
          avgVisionScore: toDecimal(
            aggregate.totalVision / Math.max(1, aggregate.gamesPlayed),
            1,
          ),
          isStale: false,
          computedAt: new Date(),
        };
      })
      .sort((a, b) => (Number(b.gamesPlayed) - Number(a.gamesPlayed)));

    const chunkSize = 200;
    for (let index = 0; index < rows.length; index += chunkSize) {
      await db.insert(schema.championStats).values(rows.slice(index, index + chunkSize));
    }
  }

  async runCollection(options: {
    tiers: readonly HighEloTier[];
    matchesPerPlayer: number;
    maxTotalMatches: number;
    onlyCurrentPatch: boolean;
    lookbackDays: number;
  }): Promise<CollectionReport> {
    const startedAt = Date.now();
    this.rateLimitHits = 0;
    this.onlyCurrentPatch = options.onlyCurrentPatch;
    this.currentPatch = await getCurrentPatch();

    if (process.env.DATABASE_URL) {
      await Promise.all([
        db
          .update(schema.buildStats)
          .set({ isStale: true })
          .where(ne(schema.buildStats.patch, this.currentPatch)),
        db
          .update(schema.championStats)
          .set({ isStale: true })
          .where(ne(schema.championStats.patch, this.currentPatch)),
      ]);
    }

    const lookbackStartTime = Math.floor(
      (Date.now() - options.lookbackDays * 24 * 60 * 60 * 1000) / 1000,
    );

    const playerSet = new Set<string>();
    for (const tier of options.tiers) {
      const players = await this.getHighEloPlayers(tier);
      for (const puuid of players) {
        playerSet.add(puuid);
      }
    }

    const players = Array.from(playerSet);
    const queuedMatches = new Set<string>();

    let matchesStored = 0;
    let matchesFailed = 0;
    let playersScanned = 0;

    for (const puuid of players) {
      if (queuedMatches.size >= options.maxTotalMatches) {
        break;
      }

      const availableSlots = options.maxTotalMatches - queuedMatches.size;
      if (availableSlots <= 0) {
        break;
      }

      const matchIds = await this.crawlPlayerMatches(puuid, {
        count: Math.min(options.matchesPerPlayer, availableSlots),
        startTime: lookbackStartTime,
        queue: 420,
      });

      for (const matchId of matchIds) {
        if (queuedMatches.size >= options.maxTotalMatches) {
          break;
        }

        queuedMatches.add(matchId);
      }

      playersScanned += 1;
      await this.backgroundDelay();
    }

    for (const matchId of queuedMatches) {
      const success = await this.fetchAndStoreMatch(matchId);
      if (success) {
        matchesStored += 1;
      } else {
        matchesFailed += 1;
      }
    }

    return {
      playersScanned,
      newMatchesFound: queuedMatches.size,
      matchesStored,
      matchesFailed,
      rateLimitHits: this.rateLimitHits,
      duration: Date.now() - startedAt,
      patch: this.currentPatch,
    };
  }
}
