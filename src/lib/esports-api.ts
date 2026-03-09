const ESPORTS_BASE_URL = "https://esports-api.lolesports.com/persisted/gw";
const ESPORTS_LIVESTATS_BASE_URL = "https://feed.lolesports.com/livestats/v1";
const ESPORTS_API_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z";

const CACHE_TTL_MS = {
  leagues: 24 * 60 * 60 * 1000,
  schedule: 15 * 60 * 1000,
  standings: 60 * 60 * 1000,
  completedEvents: 60 * 60 * 1000,
  eventDetails: 15 * 60 * 1000,
} as const;

export const ESPORTS_CACHE_KEYS = {
  leagues: "esports:leagues",
  live: "esports:live",
  scheduleAll: "esports:schedule:all",
  scheduleByLeague: "esports:schedule:league:",
  standingsByTournament: "esports:standings:",
  completedByTournament: "esports:completed:",
  eventDetails: "esports:event:",
} as const;

export interface EsportsLeague {
  id: string;
  slug: string;
  name: string;
  region: string;
  image: string;
  priority: number;
}

export interface EsportsEvent {
  id: string;
  startTime: string;
  state: "unstarted" | "inProgress" | "completed";
  type: "match" | "show";
  blockName: string;
  league: { name: string; slug: string };
  match?: {
    id: string;
    teams: {
      name: string;
      code: string;
      image: string;
      result?: { outcome: "win" | "loss" | null; gameWins: number };
    }[];
    strategy: { type: string; count: number };
    games?: {
      id: string;
      number: number;
      state: string;
    }[];
  };
}

export interface EsportsSchedule {
  events: EsportsEvent[];
}

export interface EsportsStanding {
  teamId: string;
  teamName: string;
  teamCode: string;
  teamImage: string;
  wins: number;
  losses: number;
  rank: number;
}

export interface EsportsLiveGame {
  id: string;
  eventId?: string;
  state: "inProgress" | "paused";
  number: number;
  teams: {
    name: string;
    code: string;
    kills: number;
    gold: number;
    towers: number;
    dragons: string[];
    barons: number;
    inhibitors: number;
  }[];
  clock: {
    totalSeconds: number;
    isRunning: boolean;
  };
}

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  updatedAt: number;
};

type LiveStatsFrame = {
  rfc460Timestamp?: string;
  gameState?: string;
  blueTeam?: {
    totalGold?: number;
    inhibitors?: number;
    towers?: number;
    barons?: number;
    totalKills?: number;
    dragons?: string[];
  };
  redTeam?: {
    totalGold?: number;
    inhibitors?: number;
    towers?: number;
    barons?: number;
    totalKills?: number;
    dragons?: string[];
  };
};

type LiveStatsWindow = {
  esportsGameId?: string;
  frames?: LiveStatsFrame[];
};

const methodCache = new Map<string, CacheEntry<unknown>>();
const lastSuccessCache = new Map<string, CacheEntry<unknown>>();

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeEventState(value: unknown): "unstarted" | "inProgress" | "completed" {
  if (value === "inProgress") {
    return "inProgress";
  }
  if (value === "completed") {
    return "completed";
  }
  return "unstarted";
}

function normalizeEventType(value: unknown): "match" | "show" {
  return value === "show" ? "show" : "match";
}

function mapTeam(raw: unknown): {
  name: string;
  code: string;
  image: string;
  result?: { outcome: "win" | "loss" | null; gameWins: number };
} {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const outcomeRaw = (entry.result as Record<string, unknown> | undefined)?.outcome;
  const outcome =
    outcomeRaw === "win" || outcomeRaw === "loss"
      ? outcomeRaw
      : null;

  return {
    name: toString(entry.name),
    code: toString(entry.code),
    image: toString(entry.image),
    result: {
      outcome,
      gameWins: toNumber((entry.result as Record<string, unknown> | undefined)?.gameWins),
    },
  };
}

function parseEvent(raw: unknown): EsportsEvent {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const matchRaw = entry.match as Record<string, unknown> | undefined;
  const teamsRaw = Array.isArray(matchRaw?.teams) ? matchRaw.teams : [];
  const gamesRaw = Array.isArray(matchRaw?.games) ? matchRaw.games : [];
  const startTime = toString(entry.startTime);
  const leagueSlug = toString((entry.league as Record<string, unknown> | undefined)?.slug);
  const fallbackIdParts = teamsRaw
    .map((team) => {
      const teamRecord = (team ?? {}) as Record<string, unknown>;
      return toString(teamRecord.code || teamRecord.name).toLowerCase();
    })
    .filter((value) => value.length > 0)
    .join("-");
  const eventId =
    toString(entry.id) ||
    toString(matchRaw?.id) ||
    `${leagueSlug || "unknown"}:${startTime || "unknown"}:${fallbackIdParts || "match"}`;

  return {
    id: eventId,
    startTime,
    state: normalizeEventState(entry.state),
    type: normalizeEventType(entry.type),
    blockName: toString(entry.blockName),
    league: {
      name: toString((entry.league as Record<string, unknown> | undefined)?.name),
      slug: toString((entry.league as Record<string, unknown> | undefined)?.slug),
    },
    match: matchRaw
      ? {
          id: toString(matchRaw.id ?? entry.id),
          teams: teamsRaw.map(mapTeam),
          strategy: {
            type: toString((matchRaw.strategy as Record<string, unknown> | undefined)?.type) || "bestOf",
            count: toNumber((matchRaw.strategy as Record<string, unknown> | undefined)?.count),
          },
          games: gamesRaw.map((game) => {
            const gameRecord = (game ?? {}) as Record<string, unknown>;
            return {
              id: toString(gameRecord.id),
              number: toNumber(gameRecord.number),
              state: toString(gameRecord.state),
            };
          }),
        }
      : undefined,
  };
}

function getActiveGameId(event: EsportsEvent): { gameId: string; gameNumber: number } | null {
  const games = event.match?.games ?? [];
  const inProgress = games.find((game) => game.state === "inProgress");
  if (inProgress?.id) {
    return { gameId: inProgress.id, gameNumber: inProgress.number || 1 };
  }

  const paused = games.find((game) => game.state === "paused");
  if (paused?.id) {
    return { gameId: paused.id, gameNumber: paused.number || 1 };
  }

  const latestStarted = games.find((game) => game.state === "completed");
  if (latestStarted?.id) {
    return { gameId: latestStarted.id, gameNumber: latestStarted.number || 1 };
  }

  return null;
}

function normalizeDragons(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((dragon) => toString(dragon).toLowerCase())
    .filter((dragon) => dragon.length > 0);
}

function toClockSeconds(frames: LiveStatsFrame[]): number {
  const first = frames[0]?.rfc460Timestamp ? Date.parse(frames[0].rfc460Timestamp) : Number.NaN;
  const last = frames[frames.length - 1]?.rfc460Timestamp
    ? Date.parse(frames[frames.length - 1].rfc460Timestamp ?? "")
    : Number.NaN;

  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    return 0;
  }

  return Math.max(0, Math.floor((last - first) / 1000));
}

function mapLiveFrameToGame(
  event: EsportsEvent,
  gameId: string,
  gameNumber: number,
  frame: LiveStatsFrame,
  allFrames: LiveStatsFrame[],
): EsportsLiveGame {
  const teams = event.match?.teams ?? [];
  const blueTeam = teams[0] ?? { name: "Blue", code: "BLU", image: "" };
  const redTeam = teams[1] ?? { name: "Red", code: "RED", image: "" };

  const isPaused = frame.gameState === "paused";

  return {
    id: gameId,
    eventId: event.id,
    state: isPaused ? "paused" : "inProgress",
    number: gameNumber,
    teams: [
      {
        name: blueTeam.name,
        code: blueTeam.code,
        kills: toNumber(frame.blueTeam?.totalKills),
        gold: toNumber(frame.blueTeam?.totalGold),
        towers: toNumber(frame.blueTeam?.towers),
        dragons: normalizeDragons(frame.blueTeam?.dragons),
        barons: toNumber(frame.blueTeam?.barons),
        inhibitors: toNumber(frame.blueTeam?.inhibitors),
      },
      {
        name: redTeam.name,
        code: redTeam.code,
        kills: toNumber(frame.redTeam?.totalKills),
        gold: toNumber(frame.redTeam?.totalGold),
        towers: toNumber(frame.redTeam?.towers),
        dragons: normalizeDragons(frame.redTeam?.dragons),
        barons: toNumber(frame.redTeam?.barons),
        inhibitors: toNumber(frame.redTeam?.inhibitors),
      },
    ],
    clock: {
      totalSeconds: toClockSeconds(allFrames),
      isRunning: !isPaused,
    },
  };
}

export function isEsportsLiveEnabled(): boolean {
  const value = (process.env.ENABLE_ESPORTS_LIVE ?? "true").toLowerCase();
  return value === "true";
}

export class EsportsAPIClient {
  private readonly headers = {
    "x-api-key": ESPORTS_API_KEY,
  };

  private getCache<T>(key: string): T | null {
    const entry = methodCache.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      methodCache.delete(key);
      return null;
    }

    return entry.value as T;
  }

  private setCache<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) {
      return;
    }

    methodCache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      updatedAt: Date.now(),
    });
  }

  private setLastSuccess<T>(key: string, value: T): void {
    lastSuccessCache.set(key, {
      value,
      expiresAt: Number.POSITIVE_INFINITY,
      updatedAt: Date.now(),
    });
  }

  public getLastSuccessful<T>(key: string): { value: T; updatedAt: number } | null {
    const entry = lastSuccessCache.get(key);
    if (!entry) {
      return null;
    }

    return {
      value: entry.value as T,
      updatedAt: entry.updatedAt,
    };
  }

  private async request<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: this.headers,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Esports API request failed (${response.status}) at ${url}`);
    }

    return (await response.json()) as T;
  }

  private async requestPersisted(path: string, params: Record<string, string | undefined>): Promise<unknown> {
    const query = new URLSearchParams({ hl: "en-US" });
    for (const [key, value] of Object.entries(params)) {
      if (value) {
        query.set(key, value);
      }
    }

    const url = `${ESPORTS_BASE_URL}/${path}?${query.toString()}`;
    return this.request<unknown>(url);
  }

  private async getLiveStatsWindow(gameId: string): Promise<LiveStatsWindow> {
    const url = `${ESPORTS_LIVESTATS_BASE_URL}/window/${encodeURIComponent(gameId)}`;
    return this.request<LiveStatsWindow>(url);
  }

  async getLeagues(): Promise<EsportsLeague[]> {
    const cacheKey = ESPORTS_CACHE_KEYS.leagues;
    const cached = this.getCache<EsportsLeague[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const payload = (await this.requestPersisted("getLeagues", {})) as {
      data?: { leagues?: unknown[] };
    };

    const leaguesRaw = Array.isArray(payload.data?.leagues) ? payload.data?.leagues : [];
    const leagues = leaguesRaw.map((entry) => {
      const league = (entry ?? {}) as Record<string, unknown>;
      return {
        id: toString(league.id),
        slug: toString(league.slug),
        name: toString(league.name),
        region: toString(league.region),
        image: toString(league.image),
        priority: toNumber(league.priority),
      } satisfies EsportsLeague;
    });

    this.setCache(cacheKey, leagues, CACHE_TTL_MS.leagues);
    this.setLastSuccess(cacheKey, leagues);
    return leagues;
  }

  async getSchedule(leagueId?: string): Promise<EsportsSchedule> {
    const cacheKey = leagueId
      ? `${ESPORTS_CACHE_KEYS.scheduleByLeague}${leagueId}`
      : ESPORTS_CACHE_KEYS.scheduleAll;
    const cached = this.getCache<EsportsSchedule>(cacheKey);
    if (cached) {
      return cached;
    }

    const payload = (await this.requestPersisted("getSchedule", {
      leagueId,
    })) as {
      data?: { schedule?: { events?: unknown[] } };
    };

    const events = Array.isArray(payload.data?.schedule?.events)
      ? payload.data?.schedule?.events.map(parseEvent)
      : [];

    const schedule = { events } satisfies EsportsSchedule;

    this.setCache(cacheKey, schedule, CACHE_TTL_MS.schedule);
    this.setLastSuccess(cacheKey, schedule);
    return schedule;
  }

  async getStandings(tournamentId: string): Promise<EsportsStanding[]> {
    const cacheKey = `${ESPORTS_CACHE_KEYS.standingsByTournament}${tournamentId}`;
    const cached = this.getCache<EsportsStanding[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const payload = (await this.requestPersisted("getStandings", {
      tournamentId,
    })) as {
      data?: {
        standings?: Array<{
          stages?: Array<{
            sections?: Array<{
              rankings?: unknown[];
            }>;
          }>;
        }>;
      };
    };

    const rankings =
      payload.data?.standings?.[0]?.stages?.[0]?.sections?.[0]?.rankings ?? [];

    const standings = (Array.isArray(rankings) ? rankings : []).map((ranking, index) => {
      const entry = (ranking ?? {}) as Record<string, unknown>;
      const team =
        ((entry.teams as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined) ??
        (entry.team as Record<string, unknown> | undefined) ??
        {};
      const record = (team.record as Record<string, unknown> | undefined) ??
        ((entry.record as Record<string, unknown> | undefined) ?? {});

      return {
        teamId: toString(team.id),
        teamName: toString(team.name),
        teamCode: toString(team.code),
        teamImage: toString(team.image),
        wins: toNumber(record.wins),
        losses: toNumber(record.losses),
        rank: toNumber(entry.ordinal) || index + 1,
      } satisfies EsportsStanding;
    });

    this.setCache(cacheKey, standings, CACHE_TTL_MS.standings);
    this.setLastSuccess(cacheKey, standings);
    return standings;
  }

  async getLive(): Promise<{ events: EsportsEvent[]; games: EsportsLiveGame[] }> {
    const payload = (await this.requestPersisted("getLive", {})) as {
      data?: { schedule?: { events?: unknown[] } };
    };

    const events = Array.isArray(payload.data?.schedule?.events)
      ? payload.data?.schedule?.events.map(parseEvent)
      : [];
    const baseLiveEvents = events.filter(
      (event) => event.state === "inProgress" && event.type === "match",
    );

    const liveEvents = await Promise.all(
      baseLiveEvents.map(async (event) => {
        const hasTeams = (event.match?.teams?.length ?? 0) > 0;
        const hasGames = (event.match?.games?.length ?? 0) > 0;
        const isSyntheticId = event.id.includes(":");
        if ((hasTeams && hasGames) || isSyntheticId) {
          return event;
        }

        try {
          const detail = await this.getEventDetails(event.id);
          const detailHasTeams = (detail.match?.teams?.length ?? 0) > 0;
          const detailHasGames = (detail.match?.games?.length ?? 0) > 0;
          if (detailHasTeams || detailHasGames) {
            return {
              ...event,
              match: detail.match ?? event.match,
              blockName: detail.blockName || event.blockName,
              league: {
                name: detail.league.name || event.league.name,
                slug: detail.league.slug || event.league.slug,
              },
            } satisfies EsportsEvent;
          }
        } catch (error) {
          console.error(`[EsportsAPI] Event details fetch failed for ${event.id}:`, error);
        }

        return event;
      }),
    );

    const liveGames = await Promise.all(
      liveEvents.map(async (event) => {
        const active = getActiveGameId(event);
        if (!active) {
          return null;
        }

        try {
          const window = await this.getLiveStatsWindow(active.gameId);
          const frames = Array.isArray(window.frames) ? window.frames : [];
          const latestFrame = frames[frames.length - 1];
          if (!latestFrame) {
            return null;
          }

          return mapLiveFrameToGame(event, active.gameId, active.gameNumber, latestFrame, frames);
        } catch (error) {
          console.error(`[EsportsAPI] Live stats fetch failed for game ${active.gameId}:`, error);
          return {
            id: active.gameId,
            eventId: event.id,
            state: "inProgress",
            number: active.gameNumber,
            teams: (event.match?.teams ?? []).slice(0, 2).map((team) => ({
              name: team.name,
              code: team.code,
              kills: 0,
              gold: 0,
              towers: 0,
              dragons: [],
              barons: 0,
              inhibitors: 0,
            })),
            clock: {
              totalSeconds: 0,
              isRunning: true,
            },
          } satisfies EsportsLiveGame;
        }
      }),
    );

    const result = {
      events: liveEvents,
      games: liveGames.filter((game): game is EsportsLiveGame => Boolean(game)),
    };

    this.setLastSuccess(ESPORTS_CACHE_KEYS.live, result);
    return result;
  }

  async getCompletedEvents(tournamentId: string): Promise<EsportsEvent[]> {
    const cacheKey = `${ESPORTS_CACHE_KEYS.completedByTournament}${tournamentId}`;
    const cached = this.getCache<EsportsEvent[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const payload = (await this.requestPersisted("getCompletedEvents", {
      tournamentId,
    })) as {
      data?: { schedule?: { events?: unknown[] } };
    };

    const events = Array.isArray(payload.data?.schedule?.events)
      ? payload.data?.schedule?.events.map(parseEvent)
      : [];

    this.setCache(cacheKey, events, CACHE_TTL_MS.completedEvents);
    this.setLastSuccess(cacheKey, events);
    return events;
  }

  async getEventDetails(eventId: string): Promise<EsportsEvent> {
    const cacheKey = `${ESPORTS_CACHE_KEYS.eventDetails}${eventId}`;
    const cached = this.getCache<EsportsEvent>(cacheKey);
    if (cached) {
      return cached;
    }

    const payload = (await this.requestPersisted("getEventDetails", {
      id: eventId,
    })) as {
      data?: { event?: unknown };
    };

    const event = parseEvent(payload.data?.event ?? {});
    this.setCache(cacheKey, event, CACHE_TTL_MS.eventDetails);
    this.setLastSuccess(cacheKey, event);
    return event;
  }
}

export const esportsAPIClient = new EsportsAPIClient();
