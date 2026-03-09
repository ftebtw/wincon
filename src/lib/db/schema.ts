import {
  bigint,
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const players = pgTable("players", {
  puuid: text("puuid").primaryKey(),
  gameName: text("game_name").notNull(),
  tagLine: text("tag_line").notNull(),
  summonerId: text("summoner_id").notNull(),
  profileIconId: integer("profile_icon_id").notNull(),
  summonerLevel: integer("summoner_level").notNull(),
  region: text("region").notNull().default("na1"),
  lastFetched: timestamp("last_fetched", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rankedStats = pgTable("ranked_stats", {
  id: serial("id").primaryKey(),
  puuid: text("puuid")
    .notNull()
    .references(() => players.puuid, { onDelete: "cascade" }),
  queueType: text("queue_type").notNull(),
  tier: text("tier").notNull(),
  rankDivision: text("rank_division").notNull(),
  leaguePoints: integer("league_points").notNull(),
  wins: integer("wins").notNull(),
  losses: integer("losses").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const matches = pgTable("matches", {
  matchId: text("match_id").primaryKey(),
  gameVersion: text("game_version").notNull(),
  gameMode: text("game_mode").notNull(),
  gameDuration: integer("game_duration").notNull(),
  queueId: integer("queue_id").notNull(),
  mapId: integer("map_id").notNull(),
  gameStartTs: bigint("game_start_ts", { mode: "number" }).notNull(),
  winningTeam: integer("winning_team").notNull(),
  rawData: jsonb("raw_data").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const matchParticipants = pgTable(
  "match_participants",
  {
    id: serial("id").primaryKey(),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.matchId, { onDelete: "cascade" }),
    puuid: text("puuid").notNull(),
    participantId: integer("participant_id").notNull(),
    teamId: integer("team_id").notNull(),
    championId: integer("champion_id").notNull(),
    championName: text("champion_name").notNull(),
    role: text("role").notNull(),
    win: boolean("win").notNull(),
    kills: integer("kills").notNull(),
    deaths: integer("deaths").notNull(),
    assists: integer("assists").notNull(),
    cs: integer("cs").notNull(),
    goldEarned: integer("gold_earned").notNull(),
    damageDealt: integer("damage_dealt").notNull(),
    damageTaken: integer("damage_taken").notNull(),
    visionScore: integer("vision_score").notNull(),
    items: jsonb("items").notNull(),
    runes: jsonb("runes").notNull(),
    summonerSpells: jsonb("summoner_spells").notNull(),
  },
  (table) => [
    uniqueIndex("uq_match_participants_match_puuid").on(table.matchId, table.puuid),
    index("idx_match_participants_puuid").on(table.puuid),
    index("idx_match_participants_champion").on(table.championName),
  ],
);

export const matchEvents = pgTable(
  "match_events",
  {
    id: serial("id").primaryKey(),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.matchId, { onDelete: "cascade" }),
    timestampMs: integer("timestamp_ms").notNull(),
    eventType: text("event_type").notNull(),
    killerPuuid: text("killer_puuid"),
    victimPuuid: text("victim_puuid"),
    assistingPuuids: jsonb("assisting_puuids"),
    positionX: integer("position_x"),
    positionY: integer("position_y"),
    eventData: jsonb("event_data"),
  },
  (table) => [
    index("idx_match_events_match").on(table.matchId),
    index("idx_match_events_type").on(table.eventType),
  ],
);

export const timelineFrames = pgTable(
  "timeline_frames",
  {
    id: serial("id").primaryKey(),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.matchId, { onDelete: "cascade" }),
    frameMinute: integer("frame_minute").notNull(),
    puuid: text("puuid").notNull(),
    participantId: integer("participant_id").notNull(),
    gold: integer("gold").notNull(),
    xp: integer("xp").notNull(),
    cs: integer("cs").notNull(),
    jungleCs: integer("jungle_cs").notNull(),
    level: integer("level").notNull(),
    positionX: integer("position_x"),
    positionY: integer("position_y"),
  },
  (table) => [index("idx_timeline_frames_match").on(table.matchId)],
);

export const aiAnalyses = pgTable(
  "ai_analyses",
  {
    id: serial("id").primaryKey(),
    matchId: text("match_id").references(() => matches.matchId, {
      onDelete: "cascade",
    }),
    puuid: text("puuid").notNull(),
    analysisType: text("analysis_type").notNull(),
    analysisJson: jsonb("analysis_json").notNull(),
    coachingText: text("coaching_text").notNull(),
    modelVersion: text("model_version").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    estimatedCost: decimal("estimated_cost", { precision: 10, scale: 6 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_ai_analyses_match_puuid_type").on(
      table.matchId,
      table.puuid,
      table.analysisType,
    ),
    index("idx_ai_analyses_lookup").on(table.matchId, table.puuid),
    index("idx_ai_analyses_cost_rollup").on(table.createdAt, table.analysisType),
  ],
);

export const buildStats = pgTable(
  "build_stats",
  {
    id: serial("id").primaryKey(),
    championId: integer("champion_id").notNull(),
    role: text("role").notNull(),
    allyCompTags: jsonb("ally_comp_tags").notNull(),
    enemyCompTags: jsonb("enemy_comp_tags").notNull(),
    itemBuildPath: jsonb("item_build_path").notNull(),
    sampleSize: integer("sample_size").notNull(),
    winRate: decimal("win_rate", { precision: 5, scale: 4 }).notNull(),
    avgGameLength: integer("avg_game_length").notNull(),
    patch: text("patch").notNull(),
    isStale: boolean("is_stale").notNull().default(false),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_build_stats_champion").on(table.championId, table.role, table.patch),
  ],
);

export const championStats = pgTable(
  "champion_stats",
  {
    id: serial("id").primaryKey(),
    championId: integer("champion_id").notNull(),
    championName: text("champion_name").notNull(),
    role: text("role").notNull(),
    patch: text("patch").notNull(),
    tier: text("tier").default("ALL"),
    gamesPlayed: integer("games_played").notNull(),
    wins: integer("wins").notNull(),
    winRate: decimal("win_rate", { precision: 5, scale: 4 }),
    pickRate: decimal("pick_rate", { precision: 5, scale: 4 }),
    banRate: decimal("ban_rate", { precision: 5, scale: 4 }),
    avgKills: decimal("avg_kills", { precision: 4, scale: 1 }),
    avgDeaths: decimal("avg_deaths", { precision: 4, scale: 1 }),
    avgAssists: decimal("avg_assists", { precision: 4, scale: 1 }),
    avgCs: decimal("avg_cs", { precision: 5, scale: 1 }),
    avgCsAt10: decimal("avg_cs_at_10", { precision: 4, scale: 1 }),
    avgGoldAt10: decimal("avg_gold_at_10", { precision: 6, scale: 0 }),
    avgVisionScore: decimal("avg_vision_score", { precision: 4, scale: 1 }),
    isStale: boolean("is_stale").notNull().default(false),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_champion_stats_patch_role_tier").on(
      table.championId,
      table.role,
      table.patch,
      table.tier,
    ),
    index("idx_champion_stats_lookup").on(
      table.championId,
      table.role,
      table.patch,
    ),
    index("idx_champion_stats_patch").on(table.patch),
  ],
);

export const collectionJobs = pgTable("collection_jobs", {
  id: serial("id").primaryKey(),
  jobType: text("job_type").notNull(),
  status: text("status").notNull(),
  config: jsonb("config"),
  report: jsonb("report"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
});

export const matchupGuides = pgTable(
  "matchup_guides",
  {
    id: text("id").primaryKey(),
    champion: text("champion").notNull(),
    role: text("role").notNull(),
    enemy: text("enemy").notNull(),
    enemyRole: text("enemy_role").notNull(),
    patch: text("patch").notNull(),
    winRate: decimal("win_rate", { precision: 5, scale: 4 }),
    sampleSize: integer("sample_size"),
    difficulty: text("difficulty"),
    guideJson: jsonb("guide_json").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow(),
    modelVersion: text("model_version"),
  },
  (table) => [
    index("idx_matchup_guides_lookup").on(
      table.champion,
      table.role,
      table.enemy,
      table.patch,
    ),
    index("idx_matchup_guides_champion").on(table.champion, table.role),
  ],
);

export const abilityCache = pgTable(
  "ability_cache",
  {
    id: serial("id").primaryKey(),
    patch: text("patch").notNull(),
    source: text("source").notNull().default("meraki"),
    championData: jsonb("champion_data").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_ability_cache_source_patch").on(table.source, table.patch)],
);

export const pbeDiffs = pgTable(
  "pbe_diffs",
  {
    id: serial("id").primaryKey(),
    liveVersion: text("live_version").notNull(),
    pbeVersion: text("pbe_version"),
    diffReport: jsonb("diff_report").notNull(),
    aiAnalysis: text("ai_analysis"),
    totalChanges: integer("total_changes"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow(),
    isLatest: boolean("is_latest").default(true),
  },
  (table) => [index("idx_pbe_diffs_latest").on(table.isLatest)],
);

export const patchNotes = pgTable("patch_notes", {
  id: serial("id").primaryKey(),
  version: text("version").notNull().unique(),
  releaseDate: timestamp("release_date", { withTimezone: true }),
  changes: jsonb("changes").notNull(),
  rawNotesUrl: text("raw_notes_url"),
  parsedAt: timestamp("parsed_at", { withTimezone: true }).defaultNow(),
});

export const patchState = pgTable("patch_state", {
  id: serial("id").primaryKey(),
  currentVersion: text("current_version").notNull(),
  previousVersion: text("previous_version"),
  detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow(),
  buildStatsStale: boolean("build_stats_stale").default(false),
  championStatsStale: boolean("champion_stats_stale").default(false),
  collectionStarted: boolean("collection_started").default(false),
});

export const playerPatterns = pgTable(
  "player_patterns",
  {
    id: serial("id").primaryKey(),
    puuid: text("puuid")
      .notNull()
      .references(() => players.puuid, { onDelete: "cascade" }),
    patternType: text("pattern_type").notNull(),
    frequency: decimal("frequency", { precision: 5, scale: 4 }).notNull(),
    matchIds: jsonb("match_ids").notNull(),
    details: jsonb("details").notNull(),
    lastComputed: timestamp("last_computed", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_player_patterns_puuid").on(table.puuid)],
);

export const progressSnapshots = pgTable(
  "progress_snapshots",
  {
    id: serial("id").primaryKey(),
    puuid: text("puuid").references(() => players.puuid, { onDelete: "cascade" }),
    period: text("period").notNull(),
    periodType: text("period_type").notNull(),
    gamesPlayed: integer("games_played"),
    wins: integer("wins"),
    losses: integer("losses"),
    winRate: decimal("win_rate", { precision: 5, scale: 4 }),
    avgKda: decimal("avg_kda", { precision: 4, scale: 2 }),
    avgCsPerMin: decimal("avg_cs_per_min", { precision: 4, scale: 2 }),
    avgVisionScore: decimal("avg_vision_score", { precision: 5, scale: 1 }),
    avgDeathsBefore10: decimal("avg_deaths_before_10", { precision: 3, scale: 1 }),
    avgGoldDiffAt10: decimal("avg_gold_diff_at_10", { precision: 6, scale: 0 }),
    avgDamageShare: decimal("avg_damage_share", { precision: 5, scale: 4 }),
    rank: text("rank"),
    lp: integer("lp"),
    topPatterns: jsonb("top_patterns"),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_progress_puuid_period").on(
      table.puuid,
      table.period,
      table.periodType,
    ),
    index("idx_progress_puuid_period_type").on(table.puuid, table.periodType),
  ],
);

export const gameStateVectors = pgTable(
  "game_state_vectors",
  {
    id: serial("id").primaryKey(),
    matchId: text("match_id").notNull(),
    minute: integer("minute").notNull(),
    playerPuuid: text("player_puuid"),
    championId: integer("champion_id"),
    championName: text("champion_name"),
    role: text("role"),
    rank: text("rank"),
    isProGame: boolean("is_pro_game").notNull().default(false),
    playerName: text("player_name"),
    teamName: text("team_name"),
    patch: text("patch"),
    features: jsonb("features").notNull(),
    outcome: jsonb("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_vectors_champion_role").on(table.championId, table.role),
    index("idx_vectors_minute").on(table.minute),
    index("idx_vectors_rank").on(table.rank),
    index("idx_vectors_pro").on(table.isProGame),
    index("idx_vectors_patch").on(table.patch),
  ],
);

export const proTeams = pgTable("pro_teams", {
  id: serial("id").primaryKey(),
  teamName: text("team_name").notNull(),
  teamSlug: text("team_slug").notNull().unique(),
  league: text("league").notNull(),
  region: text("region").notNull(),
  logoUrl: text("logo_url"),
  wins: integer("wins").default(0),
  losses: integer("losses").default(0),
  winRate: decimal("win_rate", { precision: 5, scale: 4 }),
  split: text("split"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
});

export const proPlayers = pgTable("pro_players", {
  id: serial("id").primaryKey(),
  playerName: text("player_name").notNull(),
  realName: text("real_name"),
  teamId: integer("team_id").references(() => proTeams.id, { onDelete: "set null" }),
  position: text("position").notNull(),
  league: text("league").notNull(),
  riotPuuid: text("riot_puuid"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
});

export const proMatches = pgTable(
  "pro_matches",
  {
    id: serial("id").primaryKey(),
    gameId: text("game_id").notNull().unique(),
    league: text("league").notNull(),
    split: text("split"),
    playoffs: boolean("playoffs").default(false),
    date: timestamp("date", { withTimezone: true }),
    gameNumber: integer("game_number"),
    blueTeam: text("blue_team").notNull(),
    redTeam: text("red_team").notNull(),
    winner: text("winner").notNull(),
    gameDuration: integer("game_duration"),
    patch: text("patch"),
  },
  (table) => [index("idx_pro_matches_league").on(table.league, table.date)],
);

export const proPlayerStats = pgTable(
  "pro_player_stats",
  {
    id: serial("id").primaryKey(),
    gameId: text("game_id").references(() => proMatches.gameId, {
      onDelete: "cascade",
    }),
    playerName: text("player_name").notNull(),
    teamName: text("team_name").notNull(),
    champion: text("champion").notNull(),
    position: text("position").notNull(),
    result: boolean("result").notNull(),
    kills: integer("kills"),
    deaths: integer("deaths"),
    assists: integer("assists"),
    cs: integer("cs"),
    cspm: decimal("cspm", { precision: 4, scale: 1 }),
    dpm: decimal("dpm", { precision: 6, scale: 1 }),
    goldShare: decimal("gold_share", { precision: 5, scale: 4 }),
    damageShare: decimal("damage_share", { precision: 5, scale: 4 }),
    visionScore: decimal("vision_score", { precision: 5, scale: 1 }),
    goldAt10: integer("gold_at_10"),
    goldAt15: integer("gold_at_15"),
    goldDiffAt10: integer("gold_diff_at_10"),
    goldDiffAt15: integer("gold_diff_at_15"),
    csAt10: integer("cs_at_10"),
    csAt15: integer("cs_at_15"),
    xpAt10: integer("xp_at_10"),
    firstBlood: boolean("first_blood"),
    firstDragon: boolean("first_dragon"),
    firstBaron: boolean("first_baron"),
    firstTower: boolean("first_tower"),
    dragons: integer("dragons"),
    barons: integer("barons"),
    towers: integer("towers"),
    side: text("side"),
    items: jsonb("items"),
  },
  (table) => [
    index("idx_pro_player_stats_player").on(table.playerName),
    index("idx_pro_player_stats_champion").on(table.champion),
    uniqueIndex("uq_pro_player_stats_game_player_team_pos").on(
      table.gameId,
      table.playerName,
      table.teamName,
      table.position,
    ),
  ],
);

export const proTeamStats = pgTable(
  "pro_team_stats",
  {
    id: serial("id").primaryKey(),
    teamName: text("team_name").notNull(),
    league: text("league").notNull(),
    split: text("split").notNull(),
    gamesPlayed: integer("games_played"),
    wins: integer("wins"),
    losses: integer("losses"),
    winRate: decimal("win_rate", { precision: 5, scale: 4 }),
    avgGameDuration: decimal("avg_game_duration", { precision: 6, scale: 1 }),
    firstBloodRate: decimal("first_blood_rate", { precision: 5, scale: 4 }),
    firstDragonRate: decimal("first_dragon_rate", { precision: 5, scale: 4 }),
    firstTowerRate: decimal("first_tower_rate", { precision: 5, scale: 4 }),
    firstBaronRate: decimal("first_baron_rate", { precision: 5, scale: 4 }),
    avgKillsPerGame: decimal("avg_kills", { precision: 4, scale: 1 }),
    avgDeathsPerGame: decimal("avg_deaths", { precision: 4, scale: 1 }),
    avgTowersPerGame: decimal("avg_towers", { precision: 4, scale: 1 }),
    avgDragonsPerGame: decimal("avg_dragons", { precision: 4, scale: 1 }),
    blueWinRate: decimal("blue_win_rate", { precision: 5, scale: 4 }),
    redWinRate: decimal("red_win_rate", { precision: 5, scale: 4 }),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_pro_team_stats_lookup").on(table.teamName, table.split),
    uniqueIndex("uq_pro_team_stats_team_split").on(table.teamName, table.league, table.split),
  ],
);

export const bettingPredictions = pgTable(
  "betting_predictions",
  {
    id: serial("id").primaryKey(),
    matchIdentifier: text("match_identifier").notNull(),
    team1: text("team1").notNull(),
    team2: text("team2").notNull(),
    league: text("league"),
    team1WinProb: decimal("team1_win_prob", { precision: 5, scale: 4 }),
    confidence: text("confidence"),
    factors: jsonb("factors"),
    draftFeatures: jsonb("draft_features"),
    actualResult: text("actual_result"),
    wasCorrect: boolean("was_correct"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_betting_predictions_match_identifier").on(table.matchIdentifier),
    index("idx_betting_predictions_created_at").on(table.createdAt),
  ],
);

export const bettingLog = pgTable(
  "betting_log",
  {
    id: serial("id").primaryKey(),
    predictionId: integer("prediction_id").references(() => bettingPredictions.id, {
      onDelete: "set null",
    }),
    platform: text("platform").default("polymarket"),
    marketId: text("market_id"),
    side: text("side"),
    ourProbability: decimal("our_probability", { precision: 5, scale: 4 }),
    marketProbability: decimal("market_probability", { precision: 5, scale: 4 }),
    edge: decimal("edge", { precision: 5, scale: 4 }),
    betAmount: decimal("bet_amount", { precision: 10, scale: 2 }),
    status: text("status"),
    orderId: text("order_id"),
    pnl: decimal("pnl", { precision: 10, scale: 2 }),
    bankrollBefore: decimal("bankroll_before", { precision: 10, scale: 2 }),
    bankrollAfter: decimal("bankroll_after", { precision: 10, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_betting_log_created_at").on(table.createdAt),
    index("idx_betting_log_market_id").on(table.marketId),
    index("idx_betting_log_status").on(table.status),
  ],
);

export const backtestResults = pgTable(
  "backtest_results",
  {
    id: serial("id").primaryKey(),
    config: jsonb("config").notNull(),
    results: jsonb("results").notNull(),
    accuracy: decimal("accuracy", { precision: 5, scale: 4 }),
    roi: decimal("roi", { precision: 7, scale: 4 }),
    totalMatches: integer("total_matches"),
    runAt: timestamp("run_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_backtest_results_run_at").on(table.runAt),
  ],
);

export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
export type Match = typeof matches.$inferSelect;
export type NewMatch = typeof matches.$inferInsert;
