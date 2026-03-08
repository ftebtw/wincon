export type MatchGrade = "A" | "B" | "C" | "D" | "F" | "N/A";

export interface MatchAnalysisOutput {
  overall_grade: MatchGrade;
  summary: string;
  key_moments: {
    timestamp: string;
    type: "mistake" | "good_play";
    title: string;
    explanation: string;
    what_to_do_instead?: string;
    win_prob_impact: number;
  }[];
  build_analysis: {
    rating: "optimal" | "suboptimal" | "poor";
    explanation: string;
    what_they_built_well?: string;
    suggested_changes: string[];
  };
  laning_phase: {
    cs_assessment: string;
    trade_patterns: string;
    tips: string[];
  };
  macro_assessment: {
    objective_participation: string;
    map_presence: string;
    tips: string[];
  };
  top_3_improvements: string[];
}

export interface PatternAnalysisOutput {
  patterns: {
    pattern_name: string;
    frequency: string;
    description: string;
    root_cause: string;
    specific_fix: string;
    priority: "high" | "medium" | "low";
  }[];
  overall_coaching_plan: string;
}

export interface LiveGameScoutOutput {
  lane_matchup: {
    difficulty: "easy" | "medium" | "hard";
    their_win_condition: string;
    your_win_condition: string;
    power_spikes: string;
    key_ability_to_watch: string;
  };
  enemy_player_tendencies: {
    playstyle: string;
    exploitable_weaknesses: string[];
    danger_zones: string[];
  };
  team_fight_plan: {
    their_comp_identity: string;
    our_comp_identity: string;
    how_to_win_fights: string;
  };
  recommended_build_path: {
    core_items: string[];
    reasoning: string;
  };
  three_things_to_remember: string[];
}

export interface GameSummary {
  matchId: string;
  champion: string;
  role: string;
  result: "WIN" | "LOSS";
  kda: string;
  cs: number;
  duration: string;
  earlyDeaths: number;
  deathPositions: string;
  visionScore: number;
  wardsPlaced: number;
  firstItemTime: string;
  items: string;
  biggestMistake: string;
  allyCompTags: string;
  enemyCompTags: string;
  buildAppropriate: boolean;
}

export interface StatPattern {
  type: string;
  frequency: number;
  occurrences: number;
  totalGames: number;
  severity: "high" | "medium" | "low";
  matchIds: string[];
  details: Record<string, unknown>;
  description: string;
}

export interface EnemyLanerStats {
  name?: string;
  champion: string;
  role?: string;
  rank?: string;
  games: number;
  winRate: number;
  kda: number;
  recentRecord?: string;
  avgKDA?: string;
  firstItem?: string;
  spells?: string[];
  aggression?: number;
  keyThreat?: string;
  laneStyle?: string;
}

export interface EnemySummary {
  name?: string;
  champion: string;
  role: string;
  rank?: string;
  recentRecord?: string;
  keyThreat?: string;
  winRate?: number;
  avgKDA?: string;
  recentWinRate?: number;
  tendency?: string;
}
