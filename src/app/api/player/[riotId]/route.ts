import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { cachedRiotAPI } from "@/lib/cache";
import { db, schema } from "@/lib/db";
import { opggClient } from "@/lib/opgg-mcp";
import { RiotAPIError } from "@/lib/riot-api";
import type { MatchSummary, PlayerLookupResponse } from "@/lib/types/player";
import type { AccountDto, LeagueEntryDto, MatchDto, ParticipantDto, SummonerDto } from "@/lib/types/riot";

type PlayerRouteContext = {
  params: Promise<{
    riotId: string;
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

const ALL_REGIONS = ["americas", "europe", "asia", "sea"] as const;
const ALL_PLATFORMS = Object.keys(PLATFORM_TO_REGION);

function parseRiotIdSlug(riotIdSlug: string): { gameName: string; tagLine: string } | null {
  const decoded = decodeURIComponent(riotIdSlug);
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

function resolvePlatform(tagLine: string): string | undefined {
  const normalizedTag = tagLine.toLowerCase();
  return normalizedTag in PLATFORM_TO_REGION ? normalizedTag : undefined;
}

function getRegionCandidates(tagLine: string): string[] {
  const inferredPlatform = resolvePlatform(tagLine);
  const inferredRegion = inferredPlatform ? PLATFORM_TO_REGION[inferredPlatform] : undefined;

  if (!inferredRegion) {
    return [...ALL_REGIONS];
  }

  return [inferredRegion, ...ALL_REGIONS.filter((region) => region !== inferredRegion)];
}

function getPlatformCandidates(tagLine: string): string[] {
  const inferredPlatform = resolvePlatform(tagLine);

  if (!inferredPlatform) {
    return [...ALL_PLATFORMS];
  }

  return [
    inferredPlatform,
    ...ALL_PLATFORMS.filter((platform) => platform !== inferredPlatform),
  ];
}

function getRegionForPlatform(platform: string): string {
  return PLATFORM_TO_REGION[platform] ?? "americas";
}

function toOpggRegion(tagLine: string): string {
  const normalized = tagLine.trim().toUpperCase();
  const aliases: Record<string, string> = {
    KR1: "KR",
    KR: "KR",
    NA1: "NA",
    NA: "NA",
    EUW1: "EUW",
    EUW: "EUW",
    EUN1: "EUNE",
    EUNE: "EUNE",
    JP1: "JP",
    JP: "JP",
    BR1: "BR",
    BR: "BR",
    OC1: "OCE",
    OCE: "OCE",
    TR1: "TR",
    TR: "TR",
    RU: "RU",
    LA1: "LAN",
    LA2: "LAS",
  };
  return aliases[normalized] ?? "NA";
}

function toDivisionLabel(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return value || "IV";
  }
  const map: Record<number, string> = {
    1: "I",
    2: "II",
    3: "III",
    4: "IV",
  };
  return map[parsed] ?? "IV";
}

function toOpggFallbackLeagueEntry(params: {
  gameName: string;
  summonerId: string;
  tier: string;
  division: string;
  lp: number;
  wins: number;
  losses: number;
}): LeagueEntryDto {
  return {
    leagueId: `opgg-${params.summonerId}`,
    summonerId: params.summonerId,
    summonerName: params.gameName,
    queueType: "RANKED_SOLO_5x5",
    tier: params.tier,
    rank: toDivisionLabel(params.division),
    leaguePoints: params.lp,
    wins: params.wins,
    losses: params.losses,
    veteran: false,
    inactive: false,
    freshBlood: false,
    hotStreak: false,
  };
}

function extractRole(participant: ParticipantDto): string {
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

function buildMatchSummary(match: MatchDto, puuid: string): MatchSummary | null {
  const participant = match.info.participants.find((p) => p.puuid === puuid);

  if (!participant) {
    return null;
  }

  return {
    matchId: match.metadata.matchId,
    champion: participant.championName,
    championId: participant.championId,
    role: extractRole(participant),
    win: participant.win,
    kills: participant.kills,
    deaths: participant.deaths,
    assists: participant.assists,
    cs: participant.totalMinionsKilled + participant.neutralMinionsKilled,
    goldEarned: participant.goldEarned,
    visionScore: participant.visionScore,
    items: extractItems(participant),
    gameDuration: match.info.gameDuration,
    gameStartTimestamp: match.info.gameStartTimestamp,
    queueId: match.info.queueId,
  };
}

async function fetchAccountWithFallback(
  gameName: string,
  tagLine: string,
): Promise<{ account: AccountDto; region: string }> {
  for (const region of getRegionCandidates(tagLine)) {
    try {
      const account = await cachedRiotAPI.getAccountByRiotId(gameName, tagLine, region);
      return { account, region };
    } catch (error) {
      if (error instanceof RiotAPIError && error.status === 404) {
        continue;
      }

      throw error;
    }
  }

  throw new RiotAPIError({
    status: 404,
    message: "Player not found.",
    url: "/riot/account/v1/accounts/by-riot-id",
  });
}

async function fetchSummonerWithFallback(
  puuid: string,
  tagLine: string,
): Promise<{ summoner: SummonerDto; platform: string; region: string }> {
  for (const platform of getPlatformCandidates(tagLine)) {
    try {
      const summoner = await cachedRiotAPI.getSummonerByPuuid(puuid, platform);
      return { summoner, platform, region: getRegionForPlatform(platform) };
    } catch (error) {
      if (error instanceof RiotAPIError && error.status === 404) {
        continue;
      }

      throw error;
    }
  }

  throw new RiotAPIError({
    status: 404,
    message: "Summoner profile not found for this Riot account.",
    url: "/lol/summoner/v4/summoners/by-puuid",
  });
}

async function persistPlayerSnapshot(params: {
  puuid: string;
  gameName: string;
  tagLine: string;
  summoner: SummonerDto;
  rankedStats: LeagueEntryDto[];
  matches: MatchDto[];
  region: string;
}) {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const { puuid, gameName, tagLine, summoner, rankedStats, matches, region } = params;

  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.players)
        .values({
          puuid,
          gameName,
          tagLine,
          summonerId: summoner.id,
          profileIconId: summoner.profileIconId,
          summonerLevel: summoner.summonerLevel,
          region,
          lastFetched: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.players.puuid,
          set: {
            gameName,
            tagLine,
            summonerId: summoner.id,
            profileIconId: summoner.profileIconId,
            summonerLevel: summoner.summonerLevel,
            region,
            lastFetched: new Date(),
          },
        });

      await tx.delete(schema.rankedStats).where(eq(schema.rankedStats.puuid, puuid));

      if (rankedStats.length > 0) {
        await tx.insert(schema.rankedStats).values(
          rankedStats.map((entry) => ({
            puuid,
            queueType: entry.queueType,
            tier: entry.tier,
            rankDivision: entry.rank,
            leaguePoints: entry.leaguePoints,
            wins: entry.wins,
            losses: entry.losses,
            fetchedAt: new Date(),
          })),
        );
      }

      for (const match of matches) {
        const winningTeam = match.info.teams.find((team) => team.win)?.teamId ?? 100;

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

        const participantRows = match.info.participants.map((participant) => ({
          matchId: match.metadata.matchId,
          puuid: participant.puuid,
          participantId: participant.participantId,
          teamId: participant.teamId,
          championId: participant.championId,
          championName: participant.championName,
          role: extractRole(participant),
          win: participant.win,
          kills: participant.kills,
          deaths: participant.deaths,
          assists: participant.assists,
          cs: participant.totalMinionsKilled + participant.neutralMinionsKilled,
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
        }));

        await tx
          .insert(schema.matchParticipants)
          .values(participantRows)
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
      }
    });
  } catch (error) {
    console.error("[PlayerRoute] Failed to persist player snapshot:", error);
  }
}

export async function GET(request: Request, { params }: PlayerRouteContext) {
  const { riotId } = await params;
  const url = new URL(request.url);
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const parsedRiotId = parseRiotIdSlug(riotId);

  if (!parsedRiotId) {
    return NextResponse.json(
      { error: "Invalid Riot ID format. Use /api/player/{gameName}-{tagLine}" },
      { status: 400 },
    );
  }

  const { gameName, tagLine } = parsedRiotId;

  try {
    const { account } = await fetchAccountWithFallback(gameName, tagLine);
    if (forceRefresh) {
      await cachedRiotAPI.invalidatePlayer(account.puuid);
    }

    const { summoner, platform, region } = await fetchSummonerWithFallback(
      account.puuid,
      tagLine,
    );

    const [rankedStats, matchIds, activeGame] = await Promise.all([
      cachedRiotAPI.getRankedStats(summoner.id, platform),
      cachedRiotAPI.getMatchIds(account.puuid, { count: 20, queue: 420 }, region),
      cachedRiotAPI.getActiveGame(account.puuid, platform),
    ]);

    const matchResults = await Promise.allSettled(
      matchIds.map((matchId) => cachedRiotAPI.getMatch(matchId, region)),
    );

    const loadedMatches = matchResults
      .filter((result): result is PromiseFulfilledResult<MatchDto> => result.status === "fulfilled")
      .map((result) => result.value);

    const recentMatches = loadedMatches
      .map((match) => buildMatchSummary(match, account.puuid))
      .filter((match): match is MatchSummary => match !== null)
      .sort((a, b) => b.gameStartTimestamp - a.gameStartTimestamp);

    await persistPlayerSnapshot({
      puuid: account.puuid,
      gameName: account.gameName,
      tagLine: account.tagLine,
      summoner,
      rankedStats,
      matches: loadedMatches,
      region: platform,
    });

    const playerCurrentGame = activeGame?.participants.find(
      (participant) => participant.puuid === account.puuid,
    );

    const response: PlayerLookupResponse = {
      lastUpdated: new Date().toISOString(),
      player: {
        puuid: account.puuid,
        gameName: account.gameName,
        tagLine: account.tagLine,
        profileIconId: summoner.profileIconId,
        summonerLevel: summoner.summonerLevel,
      },
      rankedStats,
      recentMatches,
      isInGame: Boolean(activeGame && playerCurrentGame),
    };

    if (activeGame && playerCurrentGame) {
      response.activeGame = {
        gameMode: activeGame.gameMode,
        gameStartTime: activeGame.gameStartTime,
        gameLength: activeGame.gameLength,
        championId: playerCurrentGame.championId,
        enemyTeam: activeGame.participants
          .filter((participant) => participant.teamId !== playerCurrentGame.teamId)
          .map((participant) => ({
            championId: participant.championId,
            puuid: participant.puuid,
          })),
      };
    }

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof RiotAPIError) {
      if (error.status === 404) {
        return NextResponse.json(
          { error: `Player ${gameName}#${tagLine} was not found.` },
          { status: 404 },
        );
      }

      if (error.status === 429) {
        try {
          const fallback = await opggClient.getSummoner(
            gameName,
            tagLine,
            toOpggRegion(tagLine),
          );
          const rankedStats =
            fallback.rank.tier && fallback.rank.tier !== "UNRANKED"
              ? [
                  toOpggFallbackLeagueEntry({
                    gameName: fallback.gameName,
                    summonerId: fallback.puuid ?? `${fallback.gameName}-${fallback.tagLine}`,
                    tier: fallback.rank.tier,
                    division: fallback.rank.division,
                    lp: fallback.rank.lp,
                    wins: fallback.wins,
                    losses: fallback.losses,
                  }),
                ]
              : [];

          const fallbackResponse: PlayerLookupResponse & {
            partial: boolean;
            dataSource: string;
            message: string;
          } = {
            lastUpdated: new Date().toISOString(),
            player: {
              puuid: fallback.puuid ?? `opgg:${fallback.gameName}-${fallback.tagLine}`,
              gameName: fallback.gameName,
              tagLine: fallback.tagLine,
              profileIconId: 0,
              summonerLevel: fallback.level,
            },
            rankedStats,
            recentMatches: [],
            isInGame: false,
            partial: true,
            dataSource: "opgg",
            message:
              "Riot API is currently rate-limited. Showing OP.GG fallback profile while Riot data catches up.",
          };

          return NextResponse.json(fallbackResponse, { status: 200 });
        } catch (fallbackError) {
          console.warn("[PlayerRoute] OP.GG fallback failed:", fallbackError);
        }

        return NextResponse.json(
          {
            error: "Riot API rate limit exceeded. Please retry shortly.",
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

      return NextResponse.json(
        { error: "Failed to fetch player data from Riot API." },
        { status: 500 },
      );
    }

    console.error("[PlayerRoute] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
