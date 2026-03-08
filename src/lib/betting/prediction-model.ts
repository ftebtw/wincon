import { and, desc, eq, inArray, or } from "drizzle-orm";

import { classifyTeamComp, type CompTag } from "@/lib/comp-classifier";
import { db, schema } from "@/lib/db";
import { opggClient } from "@/lib/opgg-mcp";
import { patchTracker } from "@/lib/patch-tracker";

import { CompHistoryAnalyzer } from "./comp-history";
import { lineMovementTracker } from "./line-movement";
import { patchTransitionModel, type PatchDiff } from "./patch-alpha";
import { proSqMultiplier } from "./pro-sq-multiplier";
import { rosterChangeDetector, type RosterChangeSignal } from "./roster-detector";
import { soloQueueSpy, type DraftPrediction } from "./solo-queue-spy";

export interface TeamFeatures {
  teamName: string;
  overallWinRate: number;
  recentForm5: number;
  recentForm10: number;
  avgGameDuration: number;
  blueWinRate: number;
  redWinRate: number;
}

export interface DraftFeatures {
  champions: string[];
  compTags: CompTag[];
  scalingScore: number;
  engageScore: number;
  pokeDamage: number;
  damageBalance: number;
  playerChampionWinRates: number[];
  adjustedProWinRates: number[];
  playerChampionGames: number[];
  counterPickAdvantages: number[];
}

export interface H2HFeatures {
  totalGamesPlayed: number;
  team1Wins: number;
  team2Wins: number;
  recentH2H: number;
  currentPatchH2H?: number;
}

export interface PlayerFormFeatures {
  players: {
    name: string;
    role: string;
    recentProKDA: number;
    recentProCSdiff: number;
    soloQueueRank: string;
    soloQueueLPTrend: number;
    soloQueueGamesThisWeek: number;
    championPoolSize: number;
  }[];
}

export type ModelFeatureKey =
  | "team_strength"
  | "draft_quality"
  | "h2h_history"
  | "blue_red_side"
  | "solo_queue_spy"
  | "pro_sq_multiplier"
  | "player_form"
  | "roster_detection"
  | "line_movement"
  | "patch_transition"
  | "comp_history";

export type FeatureToggles = Partial<Record<ModelFeatureKey, boolean>>;

type EdgeSignals = {
  soloQueueTeam1: DraftPrediction | null;
  soloQueueTeam2: DraftPrediction | null;
  rosterSignalsTeam1: RosterChangeSignal[];
  rosterSignalsTeam2: RosterChangeSignal[];
  rosterRiskTeam1: number;
  rosterRiskTeam2: number;
  lineMovement: { team1Adjustment: number; team2Adjustment: number; reason: string } | null;
  patchTransition: { team1Adjustment: number; team2Adjustment: number; reason: string } | null;
};

export interface MatchPrediction {
  matchId: string;
  team1: string;
  team2: string;
  team1WinProb: number;
  team2WinProb: number;
  confidence: "high" | "medium" | "low";
  edgeOverMarket?: number;
  edgeDivergence?: number;
  factors: {
    category: string;
    factor: string;
    impact: number;
    favoredTeam: string;
  }[];
  edgeSignals?: {
    soloQueueSpy?: { team1?: DraftPrediction | null; team2?: DraftPrediction | null };
    rosterDetection?: { team1: RosterChangeSignal[]; team2: RosterChangeSignal[] };
    lineMovement?: { team1Adjustment: number; team2Adjustment: number; reason: string } | null;
    patchTransition?: { team1Adjustment: number; team2Adjustment: number; reason: string } | null;
  };
  draftProgression?: {
    phase: string;
    team1Prob: number;
    team2Prob: number;
    lastAction: string;
    probChange: number;
  }[];
  bettingRecommendation?: {
    shouldBet: boolean;
    side: string;
    edge: number;
    kellyFraction: number;
    suggestedBetSize: number;
    confidence: string;
    reasoning: string;
  };
}

type AllFeatures = {
  team: TeamFeatures;
  draft: DraftFeatures | null;
  playerForm: PlayerFormFeatures | null;
  compHistoryScore: number;
  sideScore: number;
};

const MODEL_WEIGHTS: Record<ModelFeatureKey, number> = {
  team_strength: 0.15,
  draft_quality: 0.2,
  h2h_history: 0.05,
  blue_red_side: 0.03,
  solo_queue_spy: 0.15,
  pro_sq_multiplier: 0.08,
  player_form: 0.1,
  roster_detection: 0.05,
  line_movement: 0.07,
  patch_transition: 0.05,
  comp_history: 0.07,
};

const ROLE_ORDER = ["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function featureOn(feature: ModelFeatureKey, toggles: Record<ModelFeatureKey, boolean>): boolean {
  return toggles[feature];
}

function weight(feature: ModelFeatureKey, toggles: Record<ModelFeatureKey, boolean>): number {
  return featureOn(feature, toggles) ? MODEL_WEIGHTS[feature] : 0;
}

function normalizeToggles(toggles?: FeatureToggles): Record<ModelFeatureKey, boolean> {
  return {
    team_strength: toggles?.team_strength ?? true,
    draft_quality: toggles?.draft_quality ?? true,
    h2h_history: toggles?.h2h_history ?? true,
    blue_red_side: toggles?.blue_red_side ?? true,
    solo_queue_spy: toggles?.solo_queue_spy ?? true,
    pro_sq_multiplier: toggles?.pro_sq_multiplier ?? true,
    player_form: toggles?.player_form ?? true,
    roster_detection: toggles?.roster_detection ?? true,
    line_movement: toggles?.line_movement ?? true,
    patch_transition: toggles?.patch_transition ?? true,
    comp_history: toggles?.comp_history ?? true,
  };
}

function getRoleByIndex(index: number): string {
  return ROLE_ORDER[index] ?? `ROLE_${index + 1}`;
}

function tagsScore(tags: CompTag[], key: CompTag): number {
  return tags.includes(key) ? 1 : 0;
}

function scoreScaling(tags: CompTag[]): number {
  return clamp(0.5 + tagsScore(tags, "scaling_comp") * 0.25 - tagsScore(tags, "early_game") * 0.2, 0, 1);
}

function scoreEngage(tags: CompTag[]): number {
  return clamp(tagsScore(tags, "engage_comp") * 0.6 + tagsScore(tags, "dive_comp") * 0.25 + tagsScore(tags, "cc_heavy") * 0.15, 0, 1);
}

function scorePoke(tags: CompTag[]): number {
  return clamp(tagsScore(tags, "poke_comp") * 0.7 + tagsScore(tags, "high_ap") * 0.1 + tagsScore(tags, "high_ad") * 0.1, 0, 1);
}

function scoreDamage(tags: CompTag[]): number {
  if (tags.includes("mixed_damage")) {
    return 1;
  }
  return 0.6;
}

export class PredictionModel {
  private compHistory = new CompHistoryAnalyzer();

  async predict(params: {
    team1: string;
    team2: string;
    league: string;
    side: { team1: "blue" | "red" };
    draft?: {
      team1Champions: string[];
      team2Champions: string[];
      bans: string[];
    };
    includePlayerForm?: boolean;
    includeEdgeSignals?: boolean;
    fixtureId?: string;
    featureToggles?: FeatureToggles;
  }): Promise<MatchPrediction> {
    const split = await this.resolveCurrentSplit(params.league);
    const toggles = normalizeToggles(params.featureToggles);

    const [team1Team, team2Team, h2h, team1PlayerForm, team2PlayerForm, team1Draft, team2Draft, team1CompHistory, team2CompHistory] = await Promise.all([
      this.gatherTeamFeatures(params.team1, split, params.league),
      this.gatherTeamFeatures(params.team2, split, params.league),
      this.gatherH2HFeatures(params.team1, params.team2),
      params.includePlayerForm === false ? Promise.resolve(null) : this.gatherPlayerFormFeatures(params.team1),
      params.includePlayerForm === false ? Promise.resolve(null) : this.gatherPlayerFormFeatures(params.team2),
      params.draft ? this.gatherDraftFeatures(params.team1, params.draft.team1Champions) : Promise.resolve(null),
      params.draft ? this.gatherDraftFeatures(params.team2, params.draft.team2Champions) : Promise.resolve(null),
      params.draft
        ? this.compHistory.getTeamCompWinRate(params.team1, team1DraftTagFallback(params.draft.team1Champions), 50).then((row) => row.winRate).catch(() => 0.5)
        : Promise.resolve(0.5),
      params.draft
        ? this.compHistory.getTeamCompWinRate(params.team2, team1DraftTagFallback(params.draft.team2Champions), 50).then((row) => row.winRate).catch(() => 0.5)
        : Promise.resolve(0.5),
    ]);

    const team1Features: AllFeatures = {
      team: team1Team,
      draft: team1Draft,
      playerForm: team1PlayerForm,
      compHistoryScore: team1CompHistory,
      sideScore: params.side.team1 === "blue" ? team1Team.blueWinRate : team1Team.redWinRate,
    };

    const team2Features: AllFeatures = {
      team: team2Team,
      draft: team2Draft,
      playerForm: team2PlayerForm,
      compHistoryScore: team2CompHistory,
      sideScore: params.side.team1 === "blue" ? team2Team.redWinRate : team2Team.blueWinRate,
    };

    const edge = await this.collectEdgeSignals(params, toggles);
    const scored = this.computeProbability(team1Features, team2Features, h2h, edge, toggles);

    const sampleSize = h2h.totalGamesPlayed + 50;
    const modelEdge = Math.abs(scored.team1WinProb - 0.5);
    const confidence: MatchPrediction["confidence"] = sampleSize > 500 && modelEdge > 0.1 ? "high" : sampleSize > 100 && modelEdge > 0.05 ? "medium" : "low";

    const prediction: MatchPrediction = {
      matchId: `${params.team1}-vs-${params.team2}-${new Date().toISOString().slice(0, 10)}`,
      team1: params.team1,
      team2: params.team2,
      team1WinProb: scored.team1WinProb,
      team2WinProb: 1 - scored.team1WinProb,
      confidence,
      edgeDivergence: scored.edgeDivergence,
      factors: this.buildFactors(params.team1, params.team2, scored.diffs, toggles),
      edgeSignals: params.includeEdgeSignals === false
        ? undefined
        : {
            soloQueueSpy: { team1: edge.soloQueueTeam1, team2: edge.soloQueueTeam2 },
            rosterDetection: { team1: edge.rosterSignalsTeam1, team2: edge.rosterSignalsTeam2 },
            lineMovement: edge.lineMovement,
            patchTransition: edge.patchTransition,
          },
    };

    if (params.draft) {
      prediction.draftProgression = [
        {
          phase: "picks_locked",
          team1Prob: prediction.team1WinProb,
          team2Prob: prediction.team2WinProb,
          lastAction: "Full draft captured",
          probChange: 0,
        },
      ];
    }

    return prediction;
  }

  async updateWithDraftAction(currentPrediction: MatchPrediction, action: { type: "ban" | "pick"; team: string; champion: string }): Promise<MatchPrediction> {
    const baseShift = action.type === "pick" ? 0.02 : 0.01;
    const before = currentPrediction.team1WinProb;
    const after = clamp(action.team === currentPrediction.team1 ? before + baseShift : before - baseShift, 0.03, 0.97);

    const progression = currentPrediction.draftProgression ?? [];
    progression.push({
      phase: action.type === "pick" ? "picks" : "bans",
      team1Prob: after,
      team2Prob: 1 - after,
      lastAction: `${action.team} ${action.type}ed ${action.champion}`,
      probChange: after - before,
    });

    return {
      ...currentPrediction,
      team1WinProb: after,
      team2WinProb: 1 - after,
      draftProgression: progression,
    };
  }

  private async resolveCurrentSplit(league: string): Promise<string> {
    const rows = await db.select({ split: schema.proTeamStats.split }).from(schema.proTeamStats).where(eq(schema.proTeamStats.league, league)).orderBy(desc(schema.proTeamStats.computedAt)).limit(1);
    return rows[0]?.split ?? "Current";
  }

  private async gatherTeamFeatures(teamName: string, split: string, league: string): Promise<TeamFeatures> {
    const rows = await db.select().from(schema.proTeamStats).where(and(eq(schema.proTeamStats.teamName, teamName), eq(schema.proTeamStats.split, split), eq(schema.proTeamStats.league, league))).orderBy(desc(schema.proTeamStats.computedAt)).limit(1);
    const latest = rows[0];
    const [recent5, recent10] = await Promise.all([this.getRecentForm(teamName, league, 5), this.getRecentForm(teamName, league, 10)]);

    return {
      teamName,
      overallWinRate: toNumber(latest?.winRate, 0.5),
      recentForm5: recent5,
      recentForm10: recent10,
      avgGameDuration: toNumber(latest?.avgGameDuration, 1900),
      blueWinRate: toNumber(latest?.blueWinRate, 0.5),
      redWinRate: toNumber(latest?.redWinRate, 0.5),
    };
  }

  private async getRecentForm(teamName: string, league: string, limit: number): Promise<number> {
    const rows = await db.select({ winner: schema.proMatches.winner }).from(schema.proMatches).where(and(eq(schema.proMatches.league, league), or(eq(schema.proMatches.blueTeam, teamName), eq(schema.proMatches.redTeam, teamName)))).orderBy(desc(schema.proMatches.date)).limit(limit);
    if (rows.length === 0) {
      return 0.5;
    }
    return rows.filter((row) => row.winner === teamName).length / rows.length;
  }

  private async gatherDraftFeatures(teamName: string, champions: string[]): Promise<DraftFeatures> {
    const compAnalysis = await classifyTeamComp(champions);

    const playerChampionWinRates: number[] = [];
    const adjustedProWinRates: number[] = [];
    const playerChampionGames: number[] = [];
    const counterPickAdvantages: number[] = [];

    for (let index = 0; index < champions.length; index += 1) {
      const champion = champions[index];
      const role = getRoleByIndex(index);

      const [meta, stats] = await Promise.all([
        opggClient.getChampionMeta(champion, role).catch(() => null),
        this.getTeamChampionStats(teamName, champion, role),
      ]);

      const rawWinRate = stats.sampleSize > 0 ? stats.winRate : meta?.winRate ?? 0.5;
      playerChampionWinRates.push(rawWinRate);
      adjustedProWinRates.push(proSqMultiplier.getAdjustedProWinRate(champion, rawWinRate));
      playerChampionGames.push(stats.sampleSize);
      counterPickAdvantages.push((meta?.winRate ?? 0.5) - 0.5);
    }

    return {
      champions,
      compTags: compAnalysis.tags,
      scalingScore: scoreScaling(compAnalysis.tags),
      engageScore: scoreEngage(compAnalysis.tags),
      pokeDamage: scorePoke(compAnalysis.tags),
      damageBalance: scoreDamage(compAnalysis.tags),
      playerChampionWinRates,
      adjustedProWinRates,
      playerChampionGames,
      counterPickAdvantages,
    };
  }

  private async getTeamChampionStats(teamName: string, champion: string, role: string): Promise<{ winRate: number; sampleSize: number }> {
    const rows = await db.select({ result: schema.proPlayerStats.result }).from(schema.proPlayerStats).where(and(eq(schema.proPlayerStats.teamName, teamName), eq(schema.proPlayerStats.champion, champion), eq(schema.proPlayerStats.position, role))).limit(100);
    if (rows.length === 0) {
      return { winRate: 0.5, sampleSize: 0 };
    }
    return { winRate: rows.filter((row) => row.result).length / rows.length, sampleSize: rows.length };
  }

  private async gatherH2HFeatures(team1: string, team2: string): Promise<H2HFeatures> {
    const rows = await db.select({ winner: schema.proMatches.winner, patch: schema.proMatches.patch }).from(schema.proMatches).where(and(inArray(schema.proMatches.blueTeam, [team1, team2]), inArray(schema.proMatches.redTeam, [team1, team2]))).orderBy(desc(schema.proMatches.date)).limit(200);

    if (rows.length === 0) {
      return { totalGamesPlayed: 0, team1Wins: 0, team2Wins: 0, recentH2H: 0.5, currentPatchH2H: 0.5 };
    }

    const team1Wins = rows.filter((row) => row.winner === team1).length;
    const team2Wins = rows.length - team1Wins;
    const recent = rows.slice(0, 5);
    const recentTeam1Wins = recent.filter((row) => row.winner === team1).length;

    const currentPatch = await patchTracker.getCurrentPatch().catch(() => null);
    const patchRows = currentPatch ? rows.filter((row) => row.patch?.startsWith(currentPatch)) : [];

    return {
      totalGamesPlayed: rows.length,
      team1Wins,
      team2Wins,
      recentH2H: recent.length > 0 ? recentTeam1Wins / recent.length : 0.5,
      currentPatchH2H: patchRows.length > 0 ? patchRows.filter((row) => row.winner === team1).length / patchRows.length : undefined,
    };
  }

  private async gatherPlayerFormFeatures(teamName: string): Promise<PlayerFormFeatures> {
    const roster = await db.select({ playerName: schema.proPlayers.playerName, position: schema.proPlayers.position, riotPuuid: schema.proPlayers.riotPuuid }).from(schema.proPlayers).innerJoin(schema.proTeams, eq(schema.proPlayers.teamId, schema.proTeams.id)).where(eq(schema.proTeams.teamName, teamName));

    const players = await Promise.all(
      roster.slice(0, 5).map(async (player) => {
        const statsRows = await db.select({ kills: schema.proPlayerStats.kills, deaths: schema.proPlayerStats.deaths, assists: schema.proPlayerStats.assists, csAt15: schema.proPlayerStats.csAt15 }).from(schema.proPlayerStats).where(eq(schema.proPlayerStats.playerName, player.playerName)).orderBy(desc(schema.proPlayerStats.id)).limit(5);

        const avgKills = statsRows.length ? statsRows.reduce((sum, row) => sum + toNumber(row.kills, 0), 0) / statsRows.length : 2.5;
        const avgDeaths = statsRows.length ? statsRows.reduce((sum, row) => sum + Math.max(1, toNumber(row.deaths, 1)), 0) / statsRows.length : 2.5;
        const avgAssists = statsRows.length ? statsRows.reduce((sum, row) => sum + toNumber(row.assists, 0), 0) / statsRows.length : 4;
        const recentProKDA = (avgKills + avgAssists) / Math.max(1, avgDeaths);
        const recentProCSdiff = statsRows.length ? statsRows.reduce((sum, row) => sum + toNumber(row.csAt15, 0), 0) / statsRows.length - 120 : 0;

        return {
          name: player.playerName,
          role: player.position,
          recentProKDA,
          recentProCSdiff,
          soloQueueRank: "UNKNOWN",
          soloQueueLPTrend: 0,
          soloQueueGamesThisWeek: 0,
          championPoolSize: 3,
        };
      }),
    );

    return { players };
  }

  private async collectEdgeSignals(
    params: { team1: string; team2: string; includeEdgeSignals?: boolean; fixtureId?: string },
    toggles: Record<ModelFeatureKey, boolean>,
  ): Promise<EdgeSignals> {
    const result: EdgeSignals = {
      soloQueueTeam1: null,
      soloQueueTeam2: null,
      rosterSignalsTeam1: [],
      rosterSignalsTeam2: [],
      rosterRiskTeam1: 0,
      rosterRiskTeam2: 0,
      lineMovement: null,
      patchTransition: null,
    };

    if (params.includeEdgeSignals === false) {
      return result;
    }

    const tasks: Promise<void>[] = [];

    if (featureOn("solo_queue_spy", toggles)) {
      tasks.push(
        Promise.all([soloQueueSpy.predictDraft(params.team1, params.team2), soloQueueSpy.predictDraft(params.team2, params.team1)])
          .then(([a, b]) => {
            result.soloQueueTeam1 = a;
            result.soloQueueTeam2 = b;
          })
          .catch(() => undefined),
      );
    }

    if (featureOn("roster_detection", toggles)) {
      tasks.push(
        Promise.all([rosterChangeDetector.detectPotentialSub(params.team1), rosterChangeDetector.detectPotentialSub(params.team2)])
          .then(([a, b]) => {
            result.rosterSignalsTeam1 = a;
            result.rosterSignalsTeam2 = b;
            result.rosterRiskTeam1 = this.riskFromRosterSignals(a);
            result.rosterRiskTeam2 = this.riskFromRosterSignals(b);
          })
          .catch(() => undefined),
      );
    }

    if (featureOn("line_movement", toggles) && params.fixtureId) {
      tasks.push(
        lineMovementTracker.trackMovements(params.fixtureId).then((rows) => {
          result.lineMovement = lineMovementTracker.getLineMovementAdjustment(rows);
        }).catch(() => undefined),
      );
    }

    if (featureOn("patch_transition", toggles)) {
      tasks.push(
        this.loadPatchDiffs()
          .then((patch) => patchTransitionModel.getPatchTransitionEdge(params.team1, params.team2, patch.changes, patch.patchAgeDays))
          .then((edge) => {
            result.patchTransition = {
              team1Adjustment: edge.team1Adjustment,
              team2Adjustment: edge.team2Adjustment,
              reason: edge.reason,
            };
          })
          .catch(() => undefined),
      );
    }

    await Promise.all(tasks);
    return result;
  }

  private async loadPatchDiffs(): Promise<{ changes: PatchDiff[]; patchAgeDays: number }> {
    const patchRows = await db.select({ releaseDate: schema.patchNotes.releaseDate, changes: schema.patchNotes.changes }).from(schema.patchNotes).orderBy(desc(schema.patchNotes.releaseDate)).limit(1);
    const patch = patchRows[0];
    const patchAgeDays = patch?.releaseDate ? Math.max(0, Math.floor((Date.now() - new Date(patch.releaseDate).getTime()) / (24 * 60 * 60 * 1000))) : 7;

    const changes = (Array.isArray(patch?.changes) ? patch.changes : []).map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return null;
      }
      const target = String((entry as { target?: string }).target ?? "");
      const rawType = String((entry as { type?: string }).type ?? "adjustment").toLowerCase();
      if (!target) {
        return null;
      }
      return {
        target,
        changeType: rawType.includes("buff") ? "buff" : rawType.includes("nerf") ? "nerf" : "adjustment",
        percentChange: toNumber((entry as { percentChange?: number }).percentChange, 0),
      } as PatchDiff;
    }).filter((entry): entry is PatchDiff => Boolean(entry));

    return { changes, patchAgeDays };
  }

  private computeProbability(team1: AllFeatures, team2: AllFeatures, h2h: H2HFeatures, edge: EdgeSignals, toggles: Record<ModelFeatureKey, boolean>): {
    team1WinProb: number;
    edgeDivergence: number;
    diffs: Record<ModelFeatureKey, number>;
  } {
    const teamStrength1 = team1.team.overallWinRate * 0.5 + team1.team.recentForm5 * 0.3 + team1.team.recentForm10 * 0.2;
    const teamStrength2 = team2.team.overallWinRate * 0.5 + team2.team.recentForm5 * 0.3 + team2.team.recentForm10 * 0.2;

    const draft1 = this.scoreDraft(team1.draft);
    const draft2 = this.scoreDraft(team2.draft);

    const h2h1 = h2h.totalGamesPlayed > 0 ? h2h.team1Wins / h2h.totalGamesPlayed : 0.5;
    const h2h2 = 1 - h2h1;

    const side1 = clamp(team1.sideScore, 0, 1);
    const side2 = clamp(team2.sideScore, 0, 1);

    const playerForm1 = this.scorePlayerForm(team1.playerForm);
    const playerForm2 = this.scorePlayerForm(team2.playerForm);

    const compHist1 = clamp(team1.compHistoryScore, 0, 1);
    const compHist2 = clamp(team2.compHistoryScore, 0, 1);

    const solo1 = this.scoreSoloSpy(edge.soloQueueTeam1);
    const solo2 = this.scoreSoloSpy(edge.soloQueueTeam2);

    const proSq1 = this.scoreProSq(team1.draft);
    const proSq2 = this.scoreProSq(team2.draft);

    const roster1 = clamp(1 - edge.rosterRiskTeam1, 0, 1);
    const roster2 = clamp(1 - edge.rosterRiskTeam2, 0, 1);

    const lineAdj = edge.lineMovement?.team1Adjustment ?? 0;
    const line1 = clamp(0.5 + lineAdj * 6, 0, 1);
    const line2 = clamp(0.5 - lineAdj * 6, 0, 1);

    const patchAdj = edge.patchTransition?.team1Adjustment ?? 0;
    const patch1 = clamp(0.5 + patchAdj * 8, 0, 1);
    const patch2 = clamp(0.5 - patchAdj * 8, 0, 1);

    const diffs: Record<ModelFeatureKey, number> = {
      team_strength: teamStrength1 - teamStrength2,
      draft_quality: draft1 - draft2,
      h2h_history: h2h1 - h2h2,
      blue_red_side: side1 - side2,
      solo_queue_spy: solo1 - solo2,
      pro_sq_multiplier: proSq1 - proSq2,
      player_form: playerForm1 - playerForm2,
      roster_detection: roster1 - roster2,
      line_movement: line1 - line2,
      patch_transition: patch1 - patch2,
      comp_history: compHist1 - compHist2,
    };

    const weightedDiff = (Object.keys(diffs) as ModelFeatureKey[]).reduce((sum, key) => sum + diffs[key] * weight(key, toggles), 0);
    const team1WinProb = clamp(sigmoid(weightedDiff * 3.7), 0.03, 0.97);

    const edgeKeys: ModelFeatureKey[] = ["solo_queue_spy", "pro_sq_multiplier", "player_form", "roster_detection", "line_movement", "patch_transition", "comp_history"];
    const edgeDivergence = Math.abs(edgeKeys.reduce((sum, key) => sum + diffs[key] * weight(key, toggles), 0));

    return { team1WinProb, edgeDivergence, diffs };
  }

  private scoreDraft(draft: DraftFeatures | null): number {
    if (!draft) {
      return 0.5;
    }

    const avgChampionWin = draft.playerChampionWinRates.length > 0 ? draft.playerChampionWinRates.reduce((sum, value) => sum + value, 0) / draft.playerChampionWinRates.length : 0.5;
    const experienceBoost = draft.playerChampionGames.length > 0 ? clamp(draft.playerChampionGames.reduce((sum, value) => sum + clamp(value / 40, 0, 1), 0) / draft.playerChampionGames.length, 0, 1) : 0.5;
    const counterScore = draft.counterPickAdvantages.length > 0 ? clamp(0.5 + draft.counterPickAdvantages.reduce((sum, value) => sum + value, 0) / draft.counterPickAdvantages.length, 0, 1) : 0.5;

    return clamp(avgChampionWin * 0.4 + draft.scalingScore * 0.15 + draft.engageScore * 0.1 + draft.pokeDamage * 0.1 + draft.damageBalance * 0.1 + experienceBoost * 0.1 + counterScore * 0.05, 0, 1);
  }

  private scoreProSq(draft: DraftFeatures | null): number {
    if (!draft || draft.playerChampionWinRates.length === 0) {
      return 0.5;
    }

    const raw = draft.playerChampionWinRates.reduce((sum, value) => sum + value, 0) / draft.playerChampionWinRates.length;
    const adjusted = draft.adjustedProWinRates.reduce((sum, value) => sum + value, 0) / draft.adjustedProWinRates.length;
    return clamp(0.5 + (adjusted - raw) * 3, 0, 1);
  }

  private scorePlayerForm(form: PlayerFormFeatures | null): number {
    if (!form || form.players.length === 0) {
      return 0.5;
    }

    const total = form.players.reduce((sum, player) => {
      const kda = clamp((player.recentProKDA - 1.8) / 3, 0, 1);
      const cs = clamp((player.recentProCSdiff + 25) / 50, 0, 1);
      return sum + kda * 0.7 + cs * 0.3;
    }, 0);

    return clamp(total / form.players.length, 0, 1);
  }

  private scoreSoloSpy(prediction: DraftPrediction | null): number {
    if (!prediction || prediction.predictedPicks.length === 0) {
      return 0.5;
    }

    const avgConfidence = prediction.predictedPicks.reduce((sum, pick) => sum + pick.confidence, 0) / prediction.predictedPicks.length;
    return clamp(avgConfidence + clamp(prediction.predictedPicks.length / 5, 0, 1) * 0.1, 0, 1);
  }

  private riskFromRosterSignals(signals: RosterChangeSignal[]): number {
    if (signals.length === 0) {
      return 0;
    }

    const detected = signals.filter((signal) => signal.detected);
    if (detected.length === 0) {
      return 0;
    }

    return clamp(detected.reduce((sum, signal) => sum + signal.confidence, 0) / detected.length, 0, 1);
  }

  private buildFactors(team1: string, team2: string, diffs: Record<ModelFeatureKey, number>, toggles: Record<ModelFeatureKey, boolean>): MatchPrediction["factors"] {
    const labels: Record<ModelFeatureKey, string> = {
      team_strength: "Team strength and recent form",
      draft_quality: "Draft quality",
      h2h_history: "Head-to-head trend",
      blue_red_side: "Blue/red side tendency",
      solo_queue_spy: "Solo queue champion spy",
      pro_sq_multiplier: "Pro vs soloQ multiplier",
      player_form: "Player form",
      roster_detection: "Roster stability",
      line_movement: "Sharp line movement",
      patch_transition: "Patch adaptation",
      comp_history: "Composition history",
    };

    const factors = (Object.keys(labels) as ModelFeatureKey[])
      .filter((key) => featureOn(key, toggles))
      .map((key) => ({
        category: key,
        factor: labels[key],
        impact: Math.abs(diffs[key] * weight(key, toggles)),
        favoredTeam: diffs[key] >= 0 ? team1 : team2,
      }))
      .filter((row) => row.impact > 0.002)
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 10);

    return factors;
  }
}

function team1DraftTagFallback(champions: string[]): CompTag[] {
  const lower = champions.map((entry) => entry.toLowerCase());
  const tags: CompTag[] = [];

  if (lower.some((entry) => ["ornn", "malphite", "leona", "nautilus"].includes(entry))) {
    tags.push("engage_comp");
  }
  if (lower.some((entry) => ["jinx", "veigar", "kassadin", "kayle"].includes(entry))) {
    tags.push("scaling_comp");
  }
  if (lower.some((entry) => ["ziggs", "xerath", "lux"].includes(entry))) {
    tags.push("poke_comp");
  }
  if (tags.length === 0) {
    tags.push("mixed_damage");
  }

  return tags;
}

