export const DATA_PRIORITY = {
  buildRecommendations: {
    primary: "our_collected_data_current_patch_comp_aware",
    secondary: "opgg_meta_build_current_patch",
    tertiary: "meraki_ability_context",
    rule:
      "Use own build stats when sample size is above 100 for the relevant champion/role context; otherwise use OP.GG as baseline and apply WinCon comp-aware adjustments.",
  },
  championStats: {
    primary: "opgg_global_current_patch",
    secondary: "wincon_collected_data_rank_breakdowns",
    rule:
      "Prefer OP.GG for broad win/pick/ban rates due to larger sample size; supplement with WinCon rank-scoped metrics when available.",
  },
  counterMatchups: {
    primary: "opgg_counter_data",
    secondary: "wincon_matchup_guides",
    rule:
      "Use OP.GG counter win rates as baseline and enrich with WinCon matchup explanation, ability windows, and strategy.",
  },
  summonerLookup: {
    primary: "riot_api_authoritative",
    fallback: "opgg_summoner_search",
    rule:
      "Use Riot API for full timeline-capable data. Fall back to OP.GG when Riot API is rate-limited or temporarily unavailable.",
  },
  esports: {
    primary: "oracles_elixir_historical_detail",
    secondary: "opgg_esports_schedule_standings",
    tertiary: "lolesports_live_scores",
    rule:
      "Oracle's Elixir remains source of truth for deep historical pro stats; OP.GG and LoL Esports APIs are live overlays.",
  },
} as const;

export type DataPriority = typeof DATA_PRIORITY;
