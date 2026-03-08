import type { DualCompAnalysis } from "@/lib/comp-classifier";
import type { ContextualBuildRecommendation } from "@/lib/contextual-build-engine";
import type {
  AnalyzedEvent,
  DeathMapData,
  GoldEfficiencyEvent,
  RecallEvent,
  Teamfight,
  WardMapData,
} from "@/lib/play-by-play";
import type { RankBenchmarks } from "@/lib/rank-benchmarks";
import type { PlayerWPASummary, WPAEvent } from "@/lib/wpa-engine";
import type { KeyMoment, WinProbPoint } from "@/lib/win-probability";

export interface TeamDisplay {
  puuid: string;
  gameName: string;
  champion: string;
  championId: number;
  role: string;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  items: number[];
  win: boolean;
}

export interface ParticipantDisplay extends TeamDisplay {
  summonerName: string;
  goldEarned: number;
  damageDealt: number;
  damageTaken: number;
  visionScore: number;
  wardsPlaced: number;
  wardsKilled: number;
  kdaRatio: number;
}

export interface LaneStatsDisplay {
  csAt10: number;
  goldAt10: number;
  xpAt10: number;
  csAt15: number;
  goldAt15: number;
  damageDealt: number;
  damageTaken: number;
  visionScore: number;
  wardsPlaced: number;
  wardsKilled: number;
  kda: string;
}

export interface BuildPathItem {
  itemId: number;
  timestamp: number;
  itemName: string;
}

export interface MatchAnalysisResponse {
  match: {
    matchId: string;
    gameVersion: string;
    gameDuration: number;
    gameMode: string;
    queueId: number;
    gameStartTimestamp: number;
    winningTeam: number;
  };
  teams: {
    blue: TeamDisplay[];
    red: TeamDisplay[];
  };
  player: ParticipantDisplay;
  opponent: ParticipantDisplay;
  compAnalysis: DualCompAnalysis;
  winProbTimeline: WinProbPoint[];
  keyMoments: Array<KeyMoment & { context?: string }>;
  buildPath: {
    player: BuildPathItem[];
    opponent: BuildPathItem[];
  };
  playerStats: LaneStatsDisplay;
  opponentStats: LaneStatsDisplay;
  playByPlay: {
    events: AnalyzedEvent[];
    teamfights: Teamfight[];
    recalls: RecallEvent[];
    goldEfficiency: GoldEfficiencyEvent[];
    deathMap: DeathMapData;
    wardMap: WardMapData;
    aiRelevantEvents: AnalyzedEvent[];
  };
  rankBenchmarks: {
    playerTier: RankBenchmarks;
    oneTierUp: RankBenchmarks;
    challenger: RankBenchmarks;
  };
  wpa: {
    playerSummary: PlayerWPASummary;
    allPlayers: PlayerWPASummary[];
    events: WPAEvent[];
    mvp: {
      champion: string;
      totalWPA: number;
    };
  };
  contextualBuild?: ContextualBuildRecommendation;
}
