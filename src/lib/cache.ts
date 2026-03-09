import { RiotAPIClient, type MatchListOptions } from "@/lib/riot-api";
import {
  riotRateLimiter,
  type RateLimitPriority,
  type RiotRateLimiter,
} from "@/lib/rate-limiter";
import type {
  AccountDto,
  ChampionMasteryDto,
  CurrentGameInfoDto,
  HighEloTier,
  LeagueEntryDto,
  LeagueListDto,
  MatchDto,
  MatchTimelineDto,
  SummonerDto,
} from "@/lib/types/riot";

type CacheRecord = {
  value: unknown;
  expiresAt: number;
};

const TTL_SECONDS = {
  account: 5 * 60,
  summoner: 5 * 60,
  ranked: 15 * 60,
  leagueTier: 5 * 60,
  matchIds: 2 * 60,
  match: Number.POSITIVE_INFINITY,
  timeline: Number.POSITIVE_INFINITY,
  championMastery: 30 * 60,
} as const;

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, fieldValue]) => fieldValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries
      .map(([key, fieldValue]) => `${key}:${stableStringify(fieldValue)}`)
      .join(",")}}`;
  }

  return String(value);
}

function cacheExpiresAt(ttlSeconds: number): number {
  if (ttlSeconds === 0 || ttlSeconds === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }

  return Date.now() + ttlSeconds * 1000;
}

export class InMemoryCache {
  private store = new Map<string, CacheRecord>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt !== Number.POSITIVE_INFINITY && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: cacheExpiresAt(ttlSeconds),
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

export class CachedRiotAPI {
  private readonly client: RiotAPIClient;
  private readonly cache: InMemoryCache;
  private readonly rateLimiter: RiotRateLimiter;
  private readonly keysByPuuid = new Map<string, Set<string>>();
  private readonly puuidsBySummonerId = new Map<string, Set<string>>();

  constructor(
    client = new RiotAPIClient(),
    cache = new InMemoryCache(),
    rateLimiter = riotRateLimiter,
  ) {
    this.client = client;
    this.cache = cache;
    this.rateLimiter = rateLimiter;
  }

  private async getCached<T>(key: string): Promise<T | null> {
    const cached = await this.cache.get<T>(key);

    if (cached !== null) {
      console.log(`[Cache] HIT: ${key}`);
      return cached;
    }

    console.log(`[Cache] MISS: ${key}`);
    return null;
  }

  private async setCached<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.cache.set<T>(key, value, ttlSeconds);
  }

  private async fromCacheOrRiot<T>(params: {
    key: string;
    ttlSeconds: number;
    loader: () => Promise<T>;
    indexByPuuid?: string[];
    priority?: RateLimitPriority;
  }): Promise<T> {
    const cached = await this.getCached<T>(params.key);

    if (cached !== null) {
      return cached;
    }

    const value = await this.rateLimiter.execute<T>(params.loader, params.priority);
    await this.setCached(params.key, value, params.ttlSeconds);

    if (params.indexByPuuid) {
      for (const puuid of params.indexByPuuid) {
        this.trackKeyForPuuid(puuid, params.key);
      }
    }

    return value;
  }

  private trackKeyForPuuid(puuid: string, key: string) {
    const existing = this.keysByPuuid.get(puuid);

    if (existing) {
      existing.add(key);
      return;
    }

    this.keysByPuuid.set(puuid, new Set([key]));
  }

  private trackSummonerIdMapping(summonerId: string, puuid: string) {
    const existing = this.puuidsBySummonerId.get(summonerId);

    if (existing) {
      existing.add(puuid);
      return;
    }

    this.puuidsBySummonerId.set(summonerId, new Set([puuid]));
  }

  async getAccountByRiotId(
    gameName: string,
    tagLine: string,
    region = "americas",
    priority: RateLimitPriority = "high",
  ): Promise<AccountDto> {
    const key = `riot:account:${gameName}:${tagLine}:${region}`;

    const account = await this.fromCacheOrRiot<AccountDto>({
      key,
      ttlSeconds: TTL_SECONDS.account,
      loader: () => this.client.getAccountByRiotId(gameName, tagLine, region),
      priority,
    });

    this.trackKeyForPuuid(account.puuid, key);
    return account;
  }

  async getSummonerByPuuid(
    puuid: string,
    platform = "na1",
    priority: RateLimitPriority = "high",
  ): Promise<SummonerDto> {
    const key = `riot:summoner:${puuid}:${platform}`;

    const summoner = await this.fromCacheOrRiot<SummonerDto>({
      key,
      ttlSeconds: TTL_SECONDS.summoner,
      loader: () => this.client.getSummonerByPuuid(puuid, platform),
      indexByPuuid: [puuid],
      priority,
    });

    if (summoner.id) {
      this.trackSummonerIdMapping(summoner.id, puuid);
    }
    return summoner;
  }

  async getSummonerById(
    summonerId: string,
    platform = "na1",
    priority: RateLimitPriority = "high",
  ): Promise<SummonerDto> {
    const key = `riot:summoner-id:${summonerId}:${platform}`;

    const summoner = await this.fromCacheOrRiot<SummonerDto>({
      key,
      ttlSeconds: TTL_SECONDS.summoner,
      loader: () => this.client.getSummonerById(summonerId, platform),
      priority,
    });

    this.trackKeyForPuuid(summoner.puuid, key);
    if (summoner.id) {
      this.trackSummonerIdMapping(summoner.id, summoner.puuid);
    }
    return summoner;
  }

  async getRankedStats(
    puuid: string,
    platform = "na1",
    priority: RateLimitPriority = "high",
  ): Promise<LeagueEntryDto[]> {
    const key = `riot:ranked:${puuid}:${platform}`;

    return this.fromCacheOrRiot<LeagueEntryDto[]>({
      key,
      ttlSeconds: TTL_SECONDS.ranked,
      loader: () => this.client.getRankedStats(puuid, platform),
      indexByPuuid: [puuid],
      priority,
    });
  }

  async getLeagueByTier(
    tier: HighEloTier,
    queue = "RANKED_SOLO_5x5",
    platform = "na1",
    priority: RateLimitPriority = "high",
  ): Promise<LeagueListDto> {
    const key = `riot:league-tier:${tier}:${queue}:${platform}`;

    return this.fromCacheOrRiot<LeagueListDto>({
      key,
      ttlSeconds: TTL_SECONDS.leagueTier,
      loader: () => this.client.getLeagueByTier(tier, queue, platform),
      priority,
    });
  }

  async getMatchIds(
    puuid: string,
    options: MatchListOptions = {},
    region = "americas",
    priority: RateLimitPriority = "high",
  ): Promise<string[]> {
    const serializedOptions = stableStringify(options);
    const key = `riot:match-ids:${puuid}:${region}:${serializedOptions}`;

    return this.fromCacheOrRiot<string[]>({
      key,
      ttlSeconds: TTL_SECONDS.matchIds,
      loader: () => this.client.getMatchIds(puuid, options, region),
      indexByPuuid: [puuid],
      priority,
    });
  }

  async getMatch(
    matchId: string,
    region = "americas",
    priority: RateLimitPriority = "high",
  ): Promise<MatchDto> {
    const key = `riot:match:${matchId}:${region}`;

    const match = await this.fromCacheOrRiot<MatchDto>({
      key,
      ttlSeconds: TTL_SECONDS.match,
      loader: () => this.client.getMatch(matchId, region),
      priority,
    });

    for (const participantPuuid of match.metadata.participants) {
      this.trackKeyForPuuid(participantPuuid, key);
    }

    return match;
  }

  async getMatchTimeline(
    matchId: string,
    region = "americas",
    priority: RateLimitPriority = "high",
  ): Promise<MatchTimelineDto> {
    const key = `riot:timeline:${matchId}:${region}`;

    const timeline = await this.fromCacheOrRiot<MatchTimelineDto>({
      key,
      ttlSeconds: TTL_SECONDS.timeline,
      loader: () => this.client.getMatchTimeline(matchId, region),
      priority,
    });

    for (const participantPuuid of timeline.metadata.participants) {
      this.trackKeyForPuuid(participantPuuid, key);
    }

    return timeline;
  }

  async getActiveGame(
    puuid: string,
    platform = "na1",
    priority: RateLimitPriority = "high",
  ): Promise<CurrentGameInfoDto | null> {
    const key = `riot:active-game:${puuid}:${platform}`;

    const cached = await this.getCached<CurrentGameInfoDto | null>(key);
    if (cached !== null) {
      return cached;
    }

    const activeGame = await this.rateLimiter.execute(
      () => this.client.getActiveGame(puuid, platform),
      priority,
    );

    await this.setCached(key, activeGame, 20);
    return activeGame;
  }

  async getChampionMastery(
    puuid: string,
    platform = "na1",
    priority: RateLimitPriority = "high",
  ): Promise<ChampionMasteryDto[]> {
    const key = `riot:mastery:${puuid}:${platform}`;

    return this.fromCacheOrRiot<ChampionMasteryDto[]>({
      key,
      ttlSeconds: TTL_SECONDS.championMastery,
      loader: () => this.client.getChampionMastery(puuid, platform),
      indexByPuuid: [puuid],
      priority,
    });
  }

  async invalidatePlayer(puuid: string): Promise<void> {
    const playerKeys = this.keysByPuuid.get(puuid);

    if (!playerKeys || playerKeys.size === 0) {
      return;
    }

    const keysToDelete = Array.from(playerKeys);
    this.keysByPuuid.delete(puuid);

    await Promise.all(keysToDelete.map((key) => this.cache.delete(key)));

    for (const trackedKeys of this.keysByPuuid.values()) {
      for (const key of keysToDelete) {
        trackedKeys.delete(key);
      }
    }
  }
}

export const inMemoryCache = new InMemoryCache();
export const cachedRiotAPI = new CachedRiotAPI(
  new RiotAPIClient(),
  inMemoryCache,
  riotRateLimiter,
);
