import { NextResponse } from "next/server";

import { aiCoach } from "@/lib/ai-coach";
import { aiRateLimiter } from "@/lib/ai-rate-limiter";
import { abilityDataService } from "@/lib/ability-data";
import { assetService } from "@/lib/asset-service";
import { cachedRiotAPI } from "@/lib/cache";
import { classifyBothComps } from "@/lib/comp-classifier";
import {
  contextualBuildEngine,
  getChampionClass,
} from "@/lib/contextual-build-engine";
import { cdragonService } from "@/lib/cdragon";
import { getChampions, getItems, getSummonerSpells } from "@/lib/data-dragon";
import { matchupGuideService } from "@/lib/matchup-guide";
import { opggClient } from "@/lib/opgg-mcp";
import { getProMatchupTip } from "@/lib/pro-insights";
import {
  buildPlatformCandidates,
  buildRegionalCandidates,
  getRegionConfig,
  getRegionFromPlatform,
  getRegionFromRequest,
  inferPlatformFromTagLine,
  inferRegionFromTagLine,
  type Region,
} from "@/lib/regions";
import { RiotAPIError } from "@/lib/riot-api";
import type {
  CurrentGameParticipantDto,
  LeagueEntryDto,
  MatchDto,
  MatchTimelineDto,
  ParticipantDto,
} from "@/lib/types/riot";

const ROLE_ORDER = ["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"] as const;
type Role = (typeof ROLE_ORDER)[number];

const SPELL_SMITE = 11;
const SPELL_TELEPORT = 12;
const SPELL_IGNITE = 14;
const SPELL_EXHAUST = 3;
const SPELL_HEAL = 7;

const CONSUMABLE_ITEM_IDS = new Set([2003, 2010, 2031, 2033, 2055, 2138, 2139, 2140, 3340, 3363, 3364]);

interface ChampionMeta {
  championName: string;
  championId: number;
  tags: string[];
}

interface ScoutParticipant {
  puuid: string;
  championId: number;
  championName: string;
  role: Role;
  spellIds: number[];
  spellNames: string[];
  teamId: number;
}

interface EnemyScoutingStats {
  puuid: string;
  championId: number;
  championName: string;
  role: Role;
  rank: string;
  recentRecord: string;
  avgKDA: string;
  firstItem: string;
  preferredSpells: string[];
  aggression: number;
  playstyle: string;
  keyThreat: string;
  sampleSize: number;
  csAt10?: number;
  name?: string;
}

type LiveScoutResult = Awaited<ReturnType<typeof aiCoach.scoutLiveGame>>;

type LiveScoutCacheEntry = {
  value: LiveScoutResult;
  expiresAt: number;
};

const LIVE_SCOUT_CACHE_TTL_MS = 5 * 60 * 1000;
const liveScoutCache = new Map<string, LiveScoutCacheEntry>();

type LiveGameRouteContext = {
  params: Promise<{
    riotId: string;
  }>;
};

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

function getPlatformCandidates(tagLine: string, preferredRegion: Region): string[] {
  const inferredPlatform = inferPlatformFromTagLine(tagLine);
  return buildPlatformCandidates({
    preferredRegion,
    inferredPlatform,
  });
}

function getRegionCandidates(tagLine: string, preferredRegion: Region): string[] {
  const inferredRegion = inferRegionFromTagLine(tagLine);
  const inferredRegional = inferredRegion
    ? getRegionConfig(inferredRegion).regional
    : undefined;
  return buildRegionalCandidates({
    preferredRegion,
    inferredRegional,
  });
}

async function fetchAccountWithFallback(
  gameName: string,
  tagLine: string,
  preferredRegion: Region,
) {
  for (const region of getRegionCandidates(tagLine, preferredRegion)) {
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
  preferredRegion: Region,
) {
  for (const platform of getPlatformCandidates(tagLine, preferredRegion)) {
    try {
      const summoner = await cachedRiotAPI.getSummonerByPuuid(puuid, platform);
      const region = getRegionFromPlatform(platform) ?? preferredRegion;
      return {
        summoner,
        platform,
        region: getRegionConfig(region).regional,
      };
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

function rankLabelFromEntries(entries: LeagueEntryDto[]): string {
  const solo = entries.find((entry) => entry.queueType === "RANKED_SOLO_5x5");
  if (!solo) {
    return "Unranked";
  }

  return `${solo.tier} ${solo.rank}`;
}

function roleShort(role: Role): string {
  if (role === "JUNGLE") {
    return "JG";
  }
  if (role === "SUPPORT") {
    return "SUP";
  }
  return role;
}

function inferTeamRoles(
  participants: Array<CurrentGameParticipantDto & ChampionMeta>,
): Map<string, Role> {
  const rolesByPuuid = new Map<string, Role>();
  const remaining = [...participants];

  function assignRole(role: Role, candidate: (CurrentGameParticipantDto & ChampionMeta) | undefined) {
    if (!candidate) {
      return;
    }

    rolesByPuuid.set(candidate.puuid, role);
    const index = remaining.findIndex((entry) => entry.puuid === candidate.puuid);
    if (index >= 0) {
      remaining.splice(index, 1);
    }
  }

  const jungler = remaining.find(
    (participant) => participant.spell1Id === SPELL_SMITE || participant.spell2Id === SPELL_SMITE,
  );
  assignRole("JUNGLE", jungler);

  const supportCandidate = [...remaining]
    .map((participant) => {
      let score = 0;
      if (participant.tags.includes("Support")) {
        score += 4;
      }
      if (!participant.tags.includes("Marksman")) {
        score += 1;
      }
      if (participant.spell1Id === SPELL_EXHAUST || participant.spell2Id === SPELL_EXHAUST) {
        score += 1;
      }
      if (participant.spell1Id === SPELL_IGNITE || participant.spell2Id === SPELL_IGNITE) {
        score += 1;
      }
      return { participant, score };
    })
    .sort((a, b) => b.score - a.score)[0];
  assignRole("SUPPORT", supportCandidate?.score > 0 ? supportCandidate.participant : undefined);

  const adcCandidate = [...remaining]
    .map((participant) => {
      let score = 0;
      if (participant.tags.includes("Marksman")) {
        score += 4;
      }
      if (participant.spell1Id === SPELL_HEAL || participant.spell2Id === SPELL_HEAL) {
        score += 1;
      }
      if (!participant.tags.includes("Support")) {
        score += 1;
      }
      return { participant, score };
    })
    .sort((a, b) => b.score - a.score)[0];
  assignRole("ADC", adcCandidate?.score > 0 ? adcCandidate.participant : remaining[0]);

  const midCandidate = [...remaining]
    .map((participant) => {
      let score = 0;
      if (participant.tags.includes("Mage")) {
        score += 3;
      }
      if (participant.tags.includes("Assassin")) {
        score += 2;
      }
      if (participant.spell1Id === SPELL_IGNITE || participant.spell2Id === SPELL_IGNITE) {
        score += 1;
      }
      if (participant.spell1Id === SPELL_TELEPORT || participant.spell2Id === SPELL_TELEPORT) {
        score -= 1;
      }
      return { participant, score };
    })
    .sort((a, b) => b.score - a.score)[0];

  assignRole("MID", midCandidate?.participant ?? remaining[0]);

  assignRole("TOP", remaining[0]);

  for (const role of ROLE_ORDER) {
    if (rolesByPuuid.size >= participants.length) {
      break;
    }

    const unassigned = participants.find((participant) => !rolesByPuuid.has(participant.puuid));
    if (unassigned) {
      rolesByPuuid.set(unassigned.puuid, role);
    }
  }

  return rolesByPuuid;
}

function formatTeamForAi(participants: ScoutParticipant[]): string {
  return participants
    .map((participant) => `${participant.championName} ${roleShort(participant.role)}`)
    .join(", ");
}

function findLaneOpponent(ourRole: Role, enemies: ScoutParticipant[]): ScoutParticipant {
  return enemies.find((participant) => participant.role === ourRole) ?? enemies[0];
}

function getParticipantFrameAtMinute(
  timeline: MatchTimelineDto,
  participantId: number,
  minute: number,
) {
  const targetTimestamp = minute * 60_000;
  const frame = [...timeline.info.frames]
    .filter((candidate) => candidate.timestamp <= targetTimestamp)
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  return frame?.participantFrames[String(participantId)];
}

function aggressionLabel(aggressionScore: number): string {
  if (aggressionScore >= 1) {
    return "aggressive";
  }

  if (aggressionScore >= 0.45) {
    return "balanced";
  }

  return "passive";
}

function threatLabel(params: { winRate: number; aggression: number }): string {
  if (params.winRate >= 0.6 || params.aggression >= 1) {
    return "High";
  }

  if (params.winRate >= 0.5 || params.aggression >= 0.45) {
    return "Medium";
  }

  return "Low";
}

function firstItemFromTimeline(
  timeline: MatchTimelineDto,
  participantId: number,
  itemNameById: Map<number, string>,
): string | null {
  for (const frame of timeline.info.frames) {
    const events = [...frame.events].sort((a, b) => a.timestamp - b.timestamp);
    for (const event of events) {
      if (
        event.type === "ITEM_PURCHASED" &&
        event.participantId === participantId &&
        typeof event.itemId === "number" &&
        event.itemId > 0 &&
        !CONSUMABLE_ITEM_IDS.has(event.itemId)
      ) {
        return itemNameById.get(event.itemId) ?? `Item ${event.itemId}`;
      }
    }
  }

  return null;
}

function inferFirstItemFromEndState(
  participant: ParticipantDto,
  itemNameById: Map<number, string>,
): string | null {
  const itemIds = [
    participant.item0,
    participant.item1,
    participant.item2,
    participant.item3,
    participant.item4,
    participant.item5,
  ].filter((itemId) => itemId > 0 && !CONSUMABLE_ITEM_IDS.has(itemId));

  if (itemIds.length === 0) {
    return null;
  }

  return itemNameById.get(itemIds[0]) ?? `Item ${itemIds[0]}`;
}

function mostFrequentString(values: string[]): string | null {
  if (values.length === 0) {
    return null;
  }

  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function normalizeItemName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeChampionName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveItemIdByName(itemName: string, itemNameLookup: Array<{ id: number; normalized: string }>): number | undefined {
  const normalized = normalizeItemName(itemName);

  const exact = itemNameLookup.find((item) => item.normalized === normalized);
  if (exact) {
    return exact.id;
  }

  const partial = itemNameLookup.find(
    (item) => item.normalized.includes(normalized) || normalized.includes(item.normalized),
  );

  return partial?.id;
}

async function fetchEnemyStats(params: {
  enemy: ScoutParticipant;
  region: string;
  platform: string;
  includeTimeline: boolean;
  maxChampionGames: number;
  itemNameById: Map<number, string>;
  spellNameById: Map<number, string>;
}): Promise<EnemyScoutingStats> {
  const { enemy, region, platform, includeTimeline, maxChampionGames, itemNameById, spellNameById } = params;

  const [summonerResult, matchIds] = await Promise.all([
    cachedRiotAPI.getSummonerByPuuid(enemy.puuid, platform).catch(() => null),
    cachedRiotAPI.getMatchIds(enemy.puuid, { count: 20, queue: 420 }, region),
  ]);

  const rankedEntries = summonerResult
    ? await cachedRiotAPI.getRankedStats(summonerResult.puuid, platform).catch(() => [])
    : [];
  const rank = rankLabelFromEntries(rankedEntries);

  const selectedMatchIds = matchIds.slice(0, 12);
  const fetchedMatches = await Promise.allSettled(
    selectedMatchIds.map((matchId) => cachedRiotAPI.getMatch(matchId, region)),
  );

  const matches = fetchedMatches
    .filter((result): result is PromiseFulfilledResult<MatchDto> => result.status === "fulfilled")
    .map((result) => result.value);

  const championGames: Array<{ match: MatchDto; participant: ParticipantDto }> = [];

  for (const match of matches) {
    const participant = match.info.participants.find((entry) => entry.puuid === enemy.puuid);
    if (!participant) {
      continue;
    }

    if (participant.championName === enemy.championName) {
      championGames.push({ match, participant });
    }

    if (championGames.length >= maxChampionGames) {
      break;
    }
  }

  const sampleGames = championGames.length > 0 ? championGames : matches
    .map((match) => {
      const participant = match.info.participants.find((entry) => entry.puuid === enemy.puuid);
      return participant ? { match, participant } : null;
    })
    .filter((entry): entry is { match: MatchDto; participant: ParticipantDto } => entry !== null)
    .slice(0, Math.max(3, Math.min(maxChampionGames, 5)));

  const wins = sampleGames.filter((entry) => entry.participant.win).length;
  const losses = Math.max(0, sampleGames.length - wins);

  const totalKills = sampleGames.reduce((sum, entry) => sum + entry.participant.kills, 0);
  const totalDeaths = sampleGames.reduce((sum, entry) => sum + entry.participant.deaths, 0);
  const totalAssists = sampleGames.reduce((sum, entry) => sum + entry.participant.assists, 0);

  const avgKdaValue =
    totalDeaths === 0
      ? totalKills + totalAssists
      : Number(((totalKills + totalAssists) / totalDeaths).toFixed(2));

  const spellPairCounts = new Map<string, number>();
  for (const game of sampleGames) {
    const spellNames = [
      spellNameById.get(game.participant.summoner1Id) ?? `Spell ${game.participant.summoner1Id}`,
      spellNameById.get(game.participant.summoner2Id) ?? `Spell ${game.participant.summoner2Id}`,
    ].sort();

    const key = spellNames.join(" + ");
    spellPairCounts.set(key, (spellPairCounts.get(key) ?? 0) + 1);
  }

  const preferredSpellPair = [...spellPairCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const preferredSpells = preferredSpellPair ? preferredSpellPair.split(" + ") : enemy.spellNames;

  const firstItemCandidates: string[] = [];
  const csAt10Values: number[] = [];
  let earlyKillCount = 0;

  if (includeTimeline && sampleGames.length > 0) {
    for (const game of sampleGames.slice(0, 6)) {
      try {
        const timeline = await cachedRiotAPI.getMatchTimeline(game.match.metadata.matchId, region);

        const firstItem = firstItemFromTimeline(
          timeline,
          game.participant.participantId,
          itemNameById,
        );
        if (firstItem) {
          firstItemCandidates.push(firstItem);
        }

        const frameAt10 = getParticipantFrameAtMinute(timeline, game.participant.participantId, 10);
        if (frameAt10) {
          csAt10Values.push(frameAt10.minionsKilled + frameAt10.jungleMinionsKilled);
        }

        const killsBefore10 = timeline.info.frames
          .flatMap((frame) => frame.events)
          .filter(
            (event) =>
              event.type === "CHAMPION_KILL" &&
              event.killerId === game.participant.participantId &&
              event.timestamp < 10 * 60_000,
          ).length;

        earlyKillCount += killsBefore10;
      } catch (error) {
        if (error instanceof RiotAPIError && error.status === 429) {
          throw error;
        }
      }
    }
  }

  if (firstItemCandidates.length === 0) {
    for (const game of sampleGames) {
      const inferred = inferFirstItemFromEndState(game.participant, itemNameById);
      if (inferred) {
        firstItemCandidates.push(inferred);
      }
    }
  }

  if (!includeTimeline) {
    earlyKillCount = sampleGames.filter((entry) => entry.participant.firstBloodKill).length;
  }

  const firstItem = mostFrequentString(firstItemCandidates) ?? "Unknown";
  const aggression = sampleGames.length > 0 ? Number((earlyKillCount / sampleGames.length).toFixed(2)) : 0;

  const winRate = sampleGames.length > 0 ? wins / sampleGames.length : 0;
  const keyThreat = threatLabel({ winRate, aggression });

  return {
    puuid: enemy.puuid,
    championId: enemy.championId,
    championName: enemy.championName,
    role: enemy.role,
    rank,
    recentRecord: `${wins}W-${losses}L`,
    avgKDA: avgKdaValue.toFixed(2),
    firstItem,
    preferredSpells,
    aggression,
    playstyle: aggressionLabel(aggression),
    keyThreat,
    sampleSize: sampleGames.length,
    csAt10:
      csAt10Values.length > 0
        ? Number((csAt10Values.reduce((sum, value) => sum + value, 0) / csAt10Values.length).toFixed(1))
        : undefined,
  };
}

function buildPartialEnemyStats(enemy: ScoutParticipant): EnemyScoutingStats {
  return {
    puuid: enemy.puuid,
    championId: enemy.championId,
    championName: enemy.championName,
    role: enemy.role,
    rank: "Unknown",
    recentRecord: "N/A",
    avgKDA: "N/A",
    firstItem: "Unknown",
    preferredSpells: enemy.spellNames,
    aggression: 0,
    playstyle: "unknown",
    keyThreat: "Medium",
    sampleSize: 0,
  };
}

type AbilityIconSet = Record<"P" | "Q" | "W" | "E" | "R", string | null>;

function buildAbilityIconSet(alias: string | undefined): AbilityIconSet {
  if (!alias) {
    return { P: null, Q: null, W: null, E: null, R: null };
  }

  return {
    P: assetService.getAbilityIcon(alias, "P"),
    Q: assetService.getAbilityIcon(alias, "Q"),
    W: assetService.getAbilityIcon(alias, "W"),
    E: assetService.getAbilityIcon(alias, "E"),
    R: assetService.getAbilityIcon(alias, "R"),
  };
}

function parseAbilitySlot(text: string): "Q" | "W" | "E" | "R" | null {
  const match = text.match(/\b([QWER])\b/i);
  if (!match) {
    return null;
  }
  const slot = match[1].toUpperCase();
  if (slot === "Q" || slot === "W" || slot === "E" || slot === "R") {
    return slot;
  }
  return null;
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized.toLowerCase())) {
      continue;
    }
    seen.add(normalized.toLowerCase());
    result.push(normalized);
  }
  return result;
}

function formatCounterList(
  values: Array<{ championName: string; winRate: number }>,
  max = 3,
): string {
  return values
    .slice(0, max)
    .map((entry) => `${entry.championName} (${Math.round(entry.winRate * 100)}%)`)
    .join(", ");
}

function getCachedLiveScout(cacheKey: string): LiveScoutResult | null {
  const cached = liveScoutCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    liveScoutCache.delete(cacheKey);
    return null;
  }

  return cached.value;
}

function setCachedLiveScout(cacheKey: string, value: LiveScoutResult): void {
  liveScoutCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + LIVE_SCOUT_CACHE_TTL_MS,
  });
}

export async function GET(_request: Request, { params }: LiveGameRouteContext) {
  const selectedRegion = getRegionFromRequest(_request);
  const { riotId } = await params;
  const parsedRiotId = parseRiotIdSlug(riotId);

  if (!parsedRiotId) {
    return NextResponse.json(
      { error: "Invalid Riot ID format. Use /livegame/{gameName}-{tagLine}." },
      { status: 400 },
    );
  }

  const { gameName, tagLine } = parsedRiotId;

  try {
    const { account } = await fetchAccountWithFallback(
      gameName,
      tagLine,
      selectedRegion,
    );
    const { platform, region } = await fetchSummonerWithFallback(
      account.puuid,
      tagLine,
      selectedRegion,
    );

    const [activeGame, ourRankedStats, championsById, spellsMap, itemsMap] = await Promise.all([
      cachedRiotAPI.getActiveGame(account.puuid, platform),
      cachedRiotAPI.getRankedStats(account.puuid, platform).catch(() => []),
      getChampions(),
      getSummonerSpells(),
      getItems(),
    ]);

    if (!activeGame) {
      return NextResponse.json({
        inGame: false,
        checkedAt: new Date().toISOString(),
      });
    }

    const participantsMeta: Array<CurrentGameParticipantDto & ChampionMeta> = activeGame.participants.map(
      (participant) => {
        const champion = championsById.get(String(participant.championId));
        return {
          ...participant,
          championName: champion?.name ?? `Champion ${participant.championId}`,
          tags: champion?.tags ?? [],
        };
      },
    );

    const team100 = participantsMeta.filter((participant) => participant.teamId === 100);
    const team200 = participantsMeta.filter((participant) => participant.teamId === 200);

    const rolesTeam100 = inferTeamRoles(team100);
    const rolesTeam200 = inferTeamRoles(team200);

    const spellNameById = new Map<number, string>();
    for (const spell of spellsMap.values()) {
      const spellId = Number(spell.key);
      if (Number.isFinite(spellId)) {
        spellNameById.set(spellId, spell.name);
      }
    }

    const itemNameById = new Map<number, string>();
    const itemNameLookup: Array<{ id: number; normalized: string }> = [];
    for (const [itemId, item] of itemsMap.entries()) {
      itemNameById.set(itemId, item.name);
      itemNameLookup.push({
        id: itemId,
        normalized: normalizeItemName(item.name),
      });
    }

    const allParticipants: ScoutParticipant[] = participantsMeta.map((participant) => {
      const roleMap = participant.teamId === 100 ? rolesTeam100 : rolesTeam200;
      const role = roleMap.get(participant.puuid) ?? "MID";

      return {
        puuid: participant.puuid,
        championId: participant.championId,
        championName: participant.championName,
        role,
        spellIds: [participant.spell1Id, participant.spell2Id],
        spellNames: [participant.spell1Id, participant.spell2Id].map(
          (spellId) => spellNameById.get(spellId) ?? `Spell ${spellId}`,
        ),
        teamId: participant.teamId,
      };
    });

    const ourParticipant = allParticipants.find((participant) => participant.puuid === account.puuid);

    if (!ourParticipant) {
      return NextResponse.json(
        { error: "Unable to map player in active game." },
        { status: 500 },
      );
    }

    const allyParticipants = allParticipants.filter((participant) => participant.teamId === ourParticipant.teamId);
    const enemyParticipants = allParticipants.filter((participant) => participant.teamId !== ourParticipant.teamId);

    const laneOpponent = findLaneOpponent(ourParticipant.role, enemyParticipants);

    const compAnalysis = await classifyBothComps(
      allyParticipants.map((participant) => participant.championName),
      enemyParticipants.map((participant) => participant.championName),
    );
    const contextualBuild = await contextualBuildEngine
      .generateBuild({
        playerChampion: ourParticipant.championName,
        playerRole: ourParticipant.role,
        playerClass: await getChampionClass(ourParticipant.championName),
        allies: allyParticipants
          .filter((participant) => participant.puuid !== ourParticipant.puuid)
          .map((participant) => participant.championName),
        enemies: enemyParticipants.map((participant) => participant.championName),
      })
      .catch((error) => {
        console.warn("[LiveGameRoute] Contextual build unavailable:", error);
        return null;
      });

    const ourRank = rankLabelFromEntries(ourRankedStats);
    let abilityMatchupContext: string | null = null;
    let opggCounterContext: string | null = null;
    let matchupGuide:
      | Awaited<ReturnType<typeof matchupGuideService.getGuide>>
      | null = null;

    try {
      await abilityDataService.fetchAllChampions();
      abilityMatchupContext = abilityDataService.formatForPrompt(
        ourParticipant.championName,
        laneOpponent.championName,
        6,
      );
    } catch (error) {
      console.warn("[LiveGameRoute] Ability matchup context unavailable:", error);
    }

    try {
      matchupGuide = await matchupGuideService.getGuide(
        ourParticipant.championName,
        ourParticipant.role,
        laneOpponent.championName,
        laneOpponent.role,
      );
    } catch (error) {
      console.warn("[LiveGameRoute] Matchup guide unavailable:", error);
    }

    try {
      const [ourMeta, enemyMeta] = await Promise.all([
        opggClient.getChampionMeta(ourParticipant.championName, ourParticipant.role),
        opggClient.getChampionMeta(laneOpponent.championName, laneOpponent.role),
      ]);

      opggCounterContext = [
        `${ourMeta.championName} ${ourMeta.role}: ${Math.round(ourMeta.winRate * 100)}% WR (${ourMeta.sampleSize} games).`,
        `${laneOpponent.championName} ${enemyMeta.role}: ${Math.round(enemyMeta.winRate * 100)}% WR (${enemyMeta.sampleSize} games).`,
        `${ourMeta.championName} weak into: ${formatCounterList(ourMeta.counters.weakAgainst) || "N/A"}.`,
        `${laneOpponent.championName} weak into: ${formatCounterList(enemyMeta.counters.weakAgainst) || "N/A"}.`,
      ].join(" ");
    } catch (error) {
      console.warn("[LiveGameRoute] OP.GG counter context unavailable:", error);
      opggCounterContext = null;
    }

    let loadingMoreData = false;

    const enemyStats = new Map<string, EnemyScoutingStats>();

    try {
      const laneStats = await fetchEnemyStats({
        enemy: laneOpponent,
        platform,
        region,
        includeTimeline: true,
        maxChampionGames: 6,
        itemNameById,
        spellNameById,
      });

      enemyStats.set(laneOpponent.puuid, laneStats);
    } catch (error) {
      if (error instanceof RiotAPIError && error.status === 429) {
        loadingMoreData = true;
      } else {
        console.error("[LiveGameRoute] Failed lane opponent deep dive:", error);
      }
    }

    const secondaryEnemies = enemyParticipants.filter((participant) => participant.puuid !== laneOpponent.puuid);

    if (!loadingMoreData) {
      for (const enemy of secondaryEnemies.slice(0, 2)) {
        try {
          const stats = await fetchEnemyStats({
            enemy,
            platform,
            region,
            includeTimeline: false,
            maxChampionGames: 4,
            itemNameById,
            spellNameById,
          });
          enemyStats.set(enemy.puuid, stats);
        } catch (error) {
          if (error instanceof RiotAPIError && error.status === 429) {
            loadingMoreData = true;
            break;
          }

          console.error("[LiveGameRoute] Failed secondary enemy stat fetch:", error);
        }
      }
    }

    for (const enemy of enemyParticipants) {
      if (!enemyStats.has(enemy.puuid)) {
        enemyStats.set(enemy.puuid, buildPartialEnemyStats(enemy));
      }
    }

    const laneOpponentStats = enemyStats.get(laneOpponent.puuid) ?? buildPartialEnemyStats(laneOpponent);

    const allEnemyStats = enemyParticipants.map((enemy) => enemyStats.get(enemy.puuid) ?? buildPartialEnemyStats(enemy));

    const allyTeamForAi = formatTeamForAi(allyParticipants);
    const enemyTeamForAi = formatTeamForAi(enemyParticipants);

    const scoutCacheKey = `${account.puuid}:${activeGame.gameId}`;
    const cachedScout = getCachedLiveScout(scoutCacheKey);
    let aiRateLimited = false;
    let aiScout: LiveScoutResult;

    if (cachedScout) {
      aiScout = cachedScout;
    } else {
      const scoutRateLimit = aiRateLimiter.consume(_request, { userId: account.puuid });
      if (scoutRateLimit.allowed) {
        aiScout = await aiCoach.scoutLiveGame({
          playerPuuid: account.puuid,
          ourChampion: ourParticipant.championName,
          ourRole: roleShort(ourParticipant.role),
          ourRank,
          allyTeam: allyTeamForAi,
          enemyTeam: enemyTeamForAi,
          allyCompTags: compAnalysis.ally.tags.join(", "),
          enemyCompTags: compAnalysis.enemy.tags.join(", "),
          abilityMatchupContext: abilityMatchupContext ?? undefined,
          matchupGuideSummary: matchupGuide?.summary,
          matchupGuideTips: matchupGuide?.tips ?? [],
          opggCounterContext: opggCounterContext ?? undefined,
          enemyLaner: {
            name: laneOpponentStats.name,
            champion: laneOpponentStats.championName,
            role: laneOpponentStats.role,
            rank: laneOpponentStats.rank,
            games: laneOpponentStats.sampleSize,
            winRate:
              laneOpponentStats.sampleSize > 0
                ? Number(
                    (
                      Number(laneOpponentStats.recentRecord.split("W-")[0]) /
                      laneOpponentStats.sampleSize
                    ).toFixed(2),
                  )
                : 0,
            kda: Number(laneOpponentStats.avgKDA) || 0,
            recentRecord: laneOpponentStats.recentRecord,
            avgKDA: laneOpponentStats.avgKDA,
            firstItem: laneOpponentStats.firstItem,
            spells: laneOpponentStats.preferredSpells,
            aggression: laneOpponentStats.aggression,
            keyThreat: laneOpponentStats.keyThreat,
            laneStyle: laneOpponentStats.playstyle,
          },
          allEnemies: allEnemyStats.map((enemy) => ({
            name: enemy.name,
            champion: enemy.championName,
            role: roleShort(enemy.role),
            rank: enemy.rank,
            recentRecord: enemy.recentRecord,
            keyThreat: enemy.keyThreat,
            winRate:
              enemy.sampleSize > 0
                ? Number(enemy.recentRecord.split("W-")[0]) / enemy.sampleSize
                : undefined,
            avgKDA: enemy.avgKDA,
          })),
        });
        setCachedLiveScout(scoutCacheKey, aiScout);
      } else {
        aiRateLimited = true;
        aiScout = {
          lane_matchup: {
            difficulty: "medium",
            their_win_condition:
              matchupGuide?.earlyGame?.tradingPattern ??
              `${laneOpponent.championName} can punish if you overextend early.`,
            your_win_condition:
              matchupGuide?.earlyGame?.levels1to3 ??
              `Play around ${ourParticipant.championName} spikes and trade on cooldown windows.`,
            power_spikes:
              matchupGuide?.levelSixSpike ??
              "Play around level 6 and first-item timing for your role.",
            key_ability_to_watch:
              matchupGuide?.abilityTradeWindows?.dangerAbility ??
              `${laneOpponent.championName}'s key engage cooldown.`,
          },
          enemy_player_tendencies: {
            playstyle: laneOpponentStats.playstyle,
            exploitable_weaknesses: [],
            danger_zones: [],
          },
          team_fight_plan: {
            their_comp_identity: compAnalysis.enemy.teamIdentity,
            our_comp_identity: compAnalysis.ally.teamIdentity,
            how_to_win_fights: `Play to ${compAnalysis.ally.teamIdentity}. Deny ${compAnalysis.enemy.teamIdentity} win condition by tracking key cooldowns and fighting on your spike timings.`,
          },
          recommended_build_path: {
            core_items:
              contextualBuild?.build.items.slice(0, 3).map((item) => item.item) ?? [],
            reasoning:
              "Using data-only fallback because today's AI scout limit was reached.",
          },
          three_things_to_remember: [
            "AI scout daily cap reached; using data-driven fallback.",
            `Their comp: ${compAnalysis.enemy.teamIdentity}.`,
            `Your comp: ${compAnalysis.ally.teamIdentity}.`,
          ],
        };
      }
    }

    const mergedThreeThings = uniqueLines([
      ...(matchupGuide?.tips?.slice(0, 2) ?? []),
      ...aiScout.three_things_to_remember,
    ]).slice(0, 3);
    const hydratedScout = {
      ...aiScout,
      lane_matchup: {
        ...aiScout.lane_matchup,
        key_ability_to_watch:
          aiScout.lane_matchup.key_ability_to_watch === "Unavailable" &&
          matchupGuide?.abilityTradeWindows?.dangerAbility
            ? matchupGuide.abilityTradeWindows.dangerAbility
            : aiScout.lane_matchup.key_ability_to_watch,
      },
      three_things_to_remember:
        mergedThreeThings.length > 0 ? mergedThreeThings : aiScout.three_things_to_remember,
    };

    const proMatchupTip = await getProMatchupTip({
      ourChampion: ourParticipant.championName,
      enemyChampion: laneOpponent.championName,
      role: ourParticipant.role,
    });

    const cdragonChampions = await cdragonService
      .getChampionList("latest")
      .catch(() => []);
    const aliasByChampionName = new Map(
      cdragonChampions.map((champion) => [
        normalizeChampionName(champion.name),
        champion.alias,
      ]),
    );
    const ourAlias = aliasByChampionName.get(
      normalizeChampionName(ourParticipant.championName),
    );
    const enemyAlias = aliasByChampionName.get(
      normalizeChampionName(laneOpponent.championName),
    );
    const abilityIcons = {
      our: buildAbilityIconSet(ourAlias),
      enemy: buildAbilityIconSet(enemyAlias),
    };
    const keyAbilitySlot = parseAbilitySlot(
      hydratedScout.lane_matchup.key_ability_to_watch,
    );
    const keyAbilityIcon =
      keyAbilitySlot && abilityIcons.enemy[keyAbilitySlot]
        ? abilityIcons.enemy[keyAbilitySlot]
        : null;
    const ourChampionIcon = await assetService.getChampionIcon(ourParticipant.championId);
    const enemyChampionIcon = await assetService.getChampionIcon(laneOpponent.championId);

    const recommendedItems = aiScout.recommended_build_path.core_items.slice(0, 3).map((itemName) => ({
      itemName,
      itemId: resolveItemIdByName(itemName, itemNameLookup),
    }));
    const contextualTopItems =
      contextualBuild?.build.items.slice(0, 3).map((item) => ({
        itemName: item.item,
        itemId: item.itemId,
      })) ?? [];
    const contextualReasoning = contextualBuild
      ? [
          contextualBuild.buildOrder[0]?.instruction,
          ...contextualBuild.deviations.slice(0, 2).map(
            (deviation) =>
              `Swapped ${deviation.genericItem} -> ${deviation.contextualItem}: ${deviation.reason}`,
          ),
        ]
          .filter((line): line is string => Boolean(line))
          .join(" ")
      : "";

    return NextResponse.json({
      inGame: true,
      aiRateLimited,
      loadingMoreData,
      checkedAt: new Date().toISOString(),
      game: {
        gameId: activeGame.gameId,
        gameMode: activeGame.gameMode,
        gameType: activeGame.gameType,
        gameStartTime: activeGame.gameStartTime,
        gameLength: activeGame.gameLength,
      },
      player: {
        puuid: account.puuid,
        championId: ourParticipant.championId,
        championName: ourParticipant.championName,
        role: ourParticipant.role,
        rank: ourRank,
        teamId: ourParticipant.teamId,
      },
      teams: {
        ally: allyParticipants,
        enemy: enemyParticipants,
      },
      compAnalysis,
      laneOpponent: laneOpponentStats,
      allEnemies: allEnemyStats,
      aiScout: hydratedScout,
      abilityIcons,
      keyAbilityIcon,
      laneMatchupIcons: {
        ourChampionIcon,
        enemyChampionIcon,
      },
      matchupGuide: matchupGuide
        ? {
            id: matchupGuide.id,
            summary: matchupGuide.summary,
            tips: matchupGuide.tips,
            difficulty: matchupGuide.difficulty,
            winRate: matchupGuide.winRate,
          }
        : null,
      abilityMatchupContext,
      recommendedBuild: {
        items: contextualTopItems.length > 0 ? contextualTopItems : recommendedItems,
        reasoning:
          contextualReasoning.length > 0
            ? contextualReasoning
            : hydratedScout.recommended_build_path.reasoning,
      },
      contextualBuild: contextualBuild ?? undefined,
      teamFightPlan: hydratedScout.team_fight_plan,
      proMatchupTip: proMatchupTip?.summary ?? null,
    });
  } catch (error) {
    if (error instanceof RiotAPIError) {
      if (error.status === 404) {
        return NextResponse.json({ error: "Player not found." }, { status: 404 });
      }

      if (error.status === 429) {
        return NextResponse.json(
          {
            error: "Riot API rate limit exceeded. Live scout is partially unavailable.",
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

    console.error("[LiveGameRoute] Unexpected error:", error);
    return NextResponse.json({ error: "Failed to load live game scout." }, { status: 500 });
  }
}
