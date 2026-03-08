import type { LeagueEntryDto } from "@/lib/types/riot";

export interface MatchSummary {
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
}

export interface PlayerLookupResponse {
  lastUpdated: string;
  player: {
    puuid: string;
    gameName: string;
    tagLine: string;
    profileIconId: number;
    summonerLevel: number;
  };
  rankedStats: LeagueEntryDto[];
  recentMatches: MatchSummary[];
  isInGame: boolean;
  activeGame?: {
    gameMode: string;
    gameStartTime: number;
    gameLength: number;
    championId: number;
    enemyTeam: {
      championId: number;
      puuid: string;
    }[];
  };
}
