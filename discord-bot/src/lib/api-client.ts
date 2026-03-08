import fetch, { HeadersInit } from "node-fetch";

type RankedEntry = {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
};

export type PlayerData = {
  lastUpdated: string;
  player: {
    puuid: string;
    gameName: string;
    tagLine: string;
    profileIconId: number;
    summonerLevel: number;
  };
  rankedStats: RankedEntry[];
  recentMatches: Array<{
    matchId: string;
    champion: string;
    championId: number;
    role: string;
    win: boolean;
    kills: number;
    deaths: number;
    assists: number;
    cs: number;
    goldEarned: number;
    visionScore: number;
    items: number[];
    gameDuration: number;
    gameStartTimestamp: number;
    queueId: number;
  }>;
  isInGame: boolean;
  activeGame?: {
    gameMode: string;
    gameStartTime: number;
    gameLength: number;
    championId: number;
    enemyTeam: Array<{ championId: number; puuid: string }>;
  };
};

export type MatchData = {
  match: {
    matchId: string;
    gameVersion: string;
    gameDuration: number;
    gameMode: string;
    queueId: number;
    gameStartTimestamp: number;
    winningTeam: number;
  };
  player: {
    puuid: string;
    gameName: string;
    champion: string;
    championId: number;
    role: string;
    kills: number;
    deaths: number;
    assists: number;
    win: boolean;
  };
  winProbTimeline: Array<{
    minute: number;
    timestamp: number;
    winProbability: number;
  }>;
  keyMoments: Array<{
    timestamp: number;
    minute: number;
    description: string;
    totalDelta: number;
    type: "positive" | "negative";
  }>;
};

export type AnalysisData = {
  overall_grade: "A" | "B" | "C" | "D" | "F" | "N/A";
  summary: string;
  key_moments: Array<{
    timestamp: string;
    type: "mistake" | "good_play";
    title: string;
    explanation: string;
    what_to_do_instead?: string;
    win_prob_impact: number;
  }>;
  build_analysis: {
    rating: "optimal" | "suboptimal" | "poor";
    explanation: string;
    what_they_built_well?: string;
    suggested_changes: string[];
  };
  top_3_improvements: string[];
};

export type LiveGameData =
  | {
      inGame: false;
      checkedAt: string;
    }
  | {
      inGame: true;
      loadingMoreData: boolean;
      checkedAt: string;
      player: {
        puuid: string;
        championName: string;
        role: "TOP" | "JUNGLE" | "MID" | "ADC" | "SUPPORT";
        rank: string;
      };
      laneOpponent: {
        championName: string;
        role: "TOP" | "JUNGLE" | "MID" | "ADC" | "SUPPORT";
      };
      aiScout: {
        three_things_to_remember: string[];
        lane_matchup: {
          difficulty: "easy" | "medium" | "hard";
          their_win_condition: string;
          your_win_condition: string;
          power_spikes: string;
          key_ability_to_watch: string;
        };
      };
      recommendedBuild: {
        items: Array<{ itemName: string; itemId?: number }>;
        reasoning: string;
      };
    };

export type ProgressData = {
  current: {
    wins: number;
    losses: number;
    winRate: number;
    avgKDA: number;
    avgCSPerMin: number;
    avgVisionScore: number;
    avgDeathsBefor10: number;
    avgDamageShare: number;
  };
  previous: {
    avgKDA: number;
    avgCSPerMin: number;
    avgVisionScore: number;
    avgDeathsBefor10: number;
    avgDamageShare: number;
  };
  trends: Array<{
    metric: string;
    current: number;
    previous: number;
    change: number;
    changePercent: number;
    direction: "improved" | "declined" | "stable";
  }>;
  rankPrediction: {
    currentRank: string;
    predictedRank: string;
    confidence: "high" | "medium" | "low";
    gamesNeeded: number;
    reasoning: string;
  };
  improvementScore: number;
};

export type BuildData = {
  build: {
    boots: {
      item: string;
      itemId?: number;
      reason: string;
    };
    items: Array<{
      slot: number;
      item: string;
      itemId?: number;
      reason: string;
      isContextual: boolean;
    }>;
  };
  genericBuild: string[];
  deviations: Array<{
    genericItem: string;
    contextualItem: string;
    reason: string;
  }>;
  threats: Array<{
    threatType: string;
    severity: "critical" | "high" | "medium" | "low";
    sourceChampions: string[];
  }>;
  buildOrder: Array<{
    phase: "early" | "mid" | "late";
    instruction: string;
  }>;
};

export type SimilarityData = {
  query: {
    champion: string;
    minute: number;
    goldDiff: number;
    situation: string;
  };
  results: Array<{
    similarity: number;
    gameState: {
      metadata: {
        minute: number;
        playerChampion: string;
        playerRole: string;
        rank: string;
        region: string;
        isProGame: boolean;
        playerName?: string;
        teamName?: string;
      };
      outcome: {
        wonGame: boolean;
        next5MinEvents: string;
        goldDiffChange5Min: number;
      };
    };
  }>;
  aiInsight: string;
};

export type ProLiveEvent = {
  id: string;
  startTime: string;
  state: "unstarted" | "inProgress" | "completed";
  league: {
    name: string;
    slug: string;
  };
  match?: {
    teams: Array<{
      name: string;
      code: string;
      image: string;
      result?: {
        outcome: "win" | "loss" | null;
        gameWins: number;
      };
    }>;
    strategy: {
      type: string;
      count: number;
    };
  };
};

export type ProLiveGame = {
  id: string;
  eventId?: string;
  state: "inProgress" | "paused";
  number: number;
  teams: Array<{
    name: string;
    code: string;
    kills: number;
    gold: number;
    towers: number;
    dragons: string[];
    barons: number;
    inhibitors: number;
  }>;
  clock: {
    totalSeconds: number;
    isRunning: boolean;
  };
};

export type ProLiveData = {
  isLive: boolean;
  disabled?: boolean;
  stale?: boolean;
  error?: boolean;
  message?: string;
  lastUpdated?: string | null;
  events?: ProLiveEvent[];
  games?: ProLiveGame[];
  upcoming?: ProLiveEvent[];
};

export class WinConAPIError extends Error {
  readonly status: number;

  readonly retryAfter?: number;

  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.name = "WinConAPIError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function parseRiotId(riotId: string, regionFallback?: string): {
  gameName: string;
  tagLine: string;
} {
  const trimmed = riotId.trim();
  const separatorIndex = trimmed.lastIndexOf("#");

  if (separatorIndex === -1) {
    if (!regionFallback) {
      throw new Error("Riot ID must include # tag (example: Player#NA1).");
    }

    return {
      gameName: trimmed,
      tagLine: regionFallback.toUpperCase(),
    };
  }

  const gameName = trimmed.slice(0, separatorIndex).trim();
  const tagLine = trimmed.slice(separatorIndex + 1).trim();

  if (!gameName || !tagLine) {
    throw new Error("Invalid Riot ID format. Use Player#TAG.");
  }

  return { gameName, tagLine };
}

export function toRiotSlug(riotId: string, regionFallback?: string): string {
  const parsed = parseRiotId(riotId, regionFallback);
  return `${encodeURIComponent(parsed.gameName)}-${encodeURIComponent(parsed.tagLine)}`;
}

function defaultEnemyTeam(): string[] {
  return ["Aatrox", "Viego", "Ahri", "KaiSa", "Nautilus"];
}

function defaultAllies(champion: string, role: string): string[] {
  const baseline = ["Ornn", "LeeSin", "Orianna", "Jinx", "Lulu"];
  const normalizedRole = role.toUpperCase();
  const roleToIndex: Record<string, number> = {
    TOP: 0,
    JUNGLE: 1,
    MID: 2,
    ADC: 3,
    SUPPORT: 4,
  };

  const index = roleToIndex[normalizedRole] ?? 2;
  baseline[index] = champion;
  return baseline;
}

export class WinConAPIClient {
  private readonly baseUrl: string;

  private readonly secret?: string;

  constructor(params?: { baseUrl?: string; secret?: string }) {
    this.baseUrl = (params?.baseUrl ?? process.env.WINCON_API_BASE_URL ?? "https://wincon.gg").replace(/\/$/, "");
    this.secret = params?.secret ?? process.env.WINCON_API_SECRET;
  }

  private async request<T>(path: string, timeoutMs = 45_000): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers: HeadersInit = {
      Accept: "application/json",
    };

    if (this.secret) {
      headers["x-wincon-secret"] = this.secret;
    }

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          retryAfter?: number;
        };

        throw new WinConAPIError(
          response.status,
          payload.error ?? `WinCon API request failed (${response.status}).`,
          payload.retryAfter,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof WinConAPIError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Request to WinCon API timed out.");
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 45_000): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers: HeadersInit = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    if (this.secret) {
      headers["x-wincon-secret"] = this.secret;
    }

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          retryAfter?: number;
        };

        throw new WinConAPIError(
          response.status,
          payload.error ?? `WinCon API request failed (${response.status}).`,
          payload.retryAfter,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof WinConAPIError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Request to WinCon API timed out.");
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public websiteUrl(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  async getPlayer(riotId: string, region?: string): Promise<PlayerData> {
    const slug = toRiotSlug(riotId, region);
    return this.request<PlayerData>(`/api/player/${slug}`);
  }

  async getMatch(matchId: string, puuid: string): Promise<MatchData> {
    return this.request<MatchData>(
      `/api/match/${encodeURIComponent(matchId)}?player=${encodeURIComponent(puuid)}`,
      30_000,
    );
  }

  async getMatchAnalysis(matchId: string, puuid: string): Promise<AnalysisData> {
    return this.request<AnalysisData>(
      `/api/analysis/${encodeURIComponent(matchId)}?player=${encodeURIComponent(puuid)}`,
      70_000,
    );
  }

  async getLiveGame(riotId: string): Promise<LiveGameData> {
    const slug = toRiotSlug(riotId);
    return this.request<LiveGameData>(`/api/livegame/${slug}`, 45_000);
  }

  async getProgress(puuid: string, period: "week" | "month" = "week"): Promise<ProgressData> {
    return this.request<ProgressData>(
      `/api/progress/${encodeURIComponent(puuid)}?period=${period}`,
      30_000,
    );
  }

  async getBuild(
    champion: string,
    role: string,
    enemies?: string[],
    allies?: string[],
  ): Promise<BuildData> {
    const payload = {
      champion,
      role: role.toUpperCase(),
      allies:
        (allies && allies.length > 0 ? allies : defaultAllies(champion, role))
          .map((entry) => entry.trim())
          .filter(Boolean)
          .slice(0, 4),
      enemies:
        (enemies && enemies.length > 0 ? enemies : defaultEnemyTeam())
          .map((entry) => entry.trim())
          .filter(Boolean)
          .slice(0, 5),
    };

    return this.post<BuildData>("/api/build", payload, 30_000);
  }

  async getProLive(): Promise<ProLiveData> {
    return this.request<ProLiveData>("/api/pro/live", 20_000);
  }

  async getSimilar(
    matchId: string,
    playerPuuid: string,
    minute: number,
  ): Promise<SimilarityData> {
    return this.post<SimilarityData>(
      "/api/similar",
      {
        matchId,
        playerPuuid,
        minute,
        options: {
          k: 3,
          sameChampion: true,
          sameRole: true,
        },
      },
      25_000,
    );
  }
}
