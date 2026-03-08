export interface ImportReport {
  teamsImported: number;
  playersImported: number;
  matchesImported: number;
  playerStatsImported: number;
  errors: string[];
}

export interface ProBuild {
  buildPath: Array<number | string>;
  games: number;
  wins: number;
  winRate: number;
  leagues: string[];
}

export interface ProPlayerAverages {
  playerName: string;
  games: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  avgCspm: number;
  avgDpm: number;
  avgGoldShare: number;
  avgDamageShare: number;
  avgVisionScore: number;
  avgGoldDiffAt10: number;
  avgCsAt10: number;
}

export interface MatchPrediction {
  team1: string;
  team2: string;
  team1WinProb: number;
  team2WinProb: number;
  confidence: "high" | "medium" | "low";
  keyFactors: {
    factor: string;
    favoredTeam: string;
    impact: number;
  }[];
}

export interface TeamStrengthProfile {
  earlyGame: number;
  objectiveControl: number;
  teamfighting: number;
  closingSpeed: number;
  consistency: number;
}
