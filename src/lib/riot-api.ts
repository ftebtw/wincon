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
import {
  getRegionConfig,
  type Region,
} from "@/lib/regions";
import { logger } from "@/lib/logger";

export type MatchListOptions = {
  count?: number;
  queue?: number;
  start?: number;
  startTime?: number;
  endTime?: number;
  type?: string;
};

type RiotErrorPayload = {
  status?: {
    message?: string;
  };
  message?: string;
};

const DEFAULT_ERROR_MESSAGES: Record<number, string> = {
  400: "Bad request to Riot API.",
  401: "Unauthorized. Verify your Riot API key.",
  403: "Forbidden by Riot API.",
  404: "Requested Riot API resource was not found.",
  429: "Rate limited by Riot API.",
  500: "Riot API internal server error.",
  503: "Riot API service unavailable.",
};

export class RiotAPIError extends Error {
  readonly status: number;
  readonly retryAfter: number | null;
  readonly url: string;

  constructor(params: {
    status: number;
    message: string;
    url: string;
    retryAfter?: number | null;
  }) {
    super(params.message);
    this.name = "RiotAPIError";
    this.status = params.status;
    this.retryAfter = params.retryAfter ?? null;
    this.url = params.url;
  }
}

export class RiotAPIClient {
  private apiKey: string;
  private defaultRegion: Region;

  constructor(apiKey?: string, region: Region = "NA") {
    this.apiKey = apiKey ?? process.env.RIOT_API_KEY ?? "";
    this.defaultRegion = region;
  }

  private platformBaseUrl(platform: string): string {
    return `https://${platform}.api.riotgames.com`;
  }

  private regionalBaseUrl(region: string): string {
    return `https://${region}.api.riotgames.com`;
  }

  private async buildError(response: Response, url: string): Promise<RiotAPIError> {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfter =
      retryAfterHeader && Number.isFinite(Number(retryAfterHeader))
        ? Number(retryAfterHeader)
        : null;

    let message = DEFAULT_ERROR_MESSAGES[response.status] ?? `Riot API error (${response.status}).`;
    const payloadText = await response.text();

    if (payloadText) {
      try {
        const parsed = JSON.parse(payloadText) as RiotErrorPayload;
        const parsedMessage = parsed.status?.message ?? parsed.message;
        if (parsedMessage) {
          message = parsedMessage;
        }
      } catch {
        message = payloadText;
      }
    }

    if (response.status === 429 && retryAfter !== null) {
      message = `${message} Retry after ${retryAfter} seconds.`;
    }

    logger.warn("Riot API request failed.", {
      endpoint: "RiotAPIClient.request",
      url,
      status: response.status,
      retryAfter,
      message,
    });

    return new RiotAPIError({
      status: response.status,
      message,
      url,
      retryAfter,
    });
  }

  private async request<T>(
    url: string,
    options?: { returnNullOn404?: boolean },
  ): Promise<T | null> {
    if (!this.apiKey) {
      throw new Error("RIOT_API_KEY is not set.");
    }

    const response = await fetch(url, {
      headers: {
        "X-Riot-Token": this.apiKey,
      },
      cache: "no-store",
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    if (options?.returnNullOn404 && response.status === 404) {
      return null;
    }

    throw await this.buildError(response, url);
  }

  async getAccountByRiotId(
    gameName: string,
    tagLine: string,
    region = getRegionConfig(this.defaultRegion).regional,
  ): Promise<AccountDto> {
    const url = `${this.regionalBaseUrl(region)}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    const response = await this.request<AccountDto>(url);
    return response as AccountDto;
  }

  async getSummonerByPuuid(puuid: string, platform = "na1"): Promise<SummonerDto> {
    const url = `${this.platformBaseUrl(platform)}/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`;
    const response = await this.request<SummonerDto>(url);
    return response as SummonerDto;
  }

  async getSummonerById(summonerId: string, platform = "na1"): Promise<SummonerDto> {
    const url = `${this.platformBaseUrl(platform)}/lol/summoner/v4/summoners/${encodeURIComponent(summonerId)}`;
    const response = await this.request<SummonerDto>(url);
    return response as SummonerDto;
  }

  async getRankedStats(
    summonerId: string,
    platform = getRegionConfig(this.defaultRegion).platform,
  ): Promise<LeagueEntryDto[]> {
    const url = `${this.platformBaseUrl(platform)}/lol/league/v4/entries/by-summoner/${encodeURIComponent(summonerId)}`;
    const response = await this.request<LeagueEntryDto[]>(url);
    return response as LeagueEntryDto[];
  }

  async getLeagueByTier(
    tier: HighEloTier,
    queue = "RANKED_SOLO_5x5",
    platform = getRegionConfig(this.defaultRegion).platform,
  ): Promise<LeagueListDto> {
    const endpointByTier: Record<HighEloTier, string> = {
      CHALLENGER: "challengerleagues",
      GRANDMASTER: "grandmasterleagues",
      MASTER: "masterleagues",
    };

    const endpoint = endpointByTier[tier];
    const url = `${this.platformBaseUrl(platform)}/lol/league/v4/${endpoint}/by-queue/${encodeURIComponent(queue)}`;
    const response = await this.request<LeagueListDto>(url);
    return response as LeagueListDto;
  }

  async getMatchIds(
    puuid: string,
    options: MatchListOptions = {},
    region = getRegionConfig(this.defaultRegion).regional,
  ): Promise<string[]> {
    const params = new URLSearchParams();
    const count = Math.min(Math.max(options.count ?? 20, 1), 100);

    params.set("count", String(count));

    if (options.queue !== undefined) {
      params.set("queue", String(options.queue));
    }

    if (options.start !== undefined) {
      params.set("start", String(options.start));
    }

    if (options.startTime !== undefined) {
      params.set("startTime", String(options.startTime));
    }

    if (options.endTime !== undefined) {
      params.set("endTime", String(options.endTime));
    }

    if (options.type) {
      params.set("type", options.type);
    }

    const url = `${this.regionalBaseUrl(region)}/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?${params.toString()}`;
    const response = await this.request<string[]>(url);
    return response as string[];
  }

  async getMatch(
    matchId: string,
    region = getRegionConfig(this.defaultRegion).regional,
  ): Promise<MatchDto> {
    const url = `${this.regionalBaseUrl(region)}/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
    const response = await this.request<MatchDto>(url);
    return response as MatchDto;
  }

  async getMatchTimeline(
    matchId: string,
    region = getRegionConfig(this.defaultRegion).regional,
  ): Promise<MatchTimelineDto> {
    const url = `${this.regionalBaseUrl(region)}/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`;
    const response = await this.request<MatchTimelineDto>(url);
    return response as MatchTimelineDto;
  }

  async getActiveGame(
    puuid: string,
    platform = getRegionConfig(this.defaultRegion).platform,
  ): Promise<CurrentGameInfoDto | null> {
    const url = `${this.platformBaseUrl(platform)}/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`;
    return this.request<CurrentGameInfoDto>(url, { returnNullOn404: true });
  }

  async getChampionMastery(
    puuid: string,
    platform = getRegionConfig(this.defaultRegion).platform,
  ): Promise<ChampionMasteryDto[]> {
    const url = `${this.platformBaseUrl(platform)}/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(puuid)}`;
    const response = await this.request<ChampionMasteryDto[]>(url);
    return response as ChampionMasteryDto[];
  }
}
