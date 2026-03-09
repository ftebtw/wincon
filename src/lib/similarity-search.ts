import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, lte, ne, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import {
  gameStateEncoder,
  type GameStateVector,
} from "@/lib/game-state-encoder";
import type { MatchDto, MatchTimelineDto } from "@/lib/types/riot";

const SONNET_MODEL = process.env.ANTHROPIC_SONNET_MODEL ?? "claude-sonnet-4-6";
const ENABLE_AI_INSIGHT = process.env.ENABLE_SIMILARITY_AI_INSIGHT === "true";

const ROLE_FILTERS = new Set(["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"]);
const RANK_ORDER: Record<string, number> = {
  IRON: 1,
  BRONZE: 2,
  SILVER: 3,
  GOLD: 4,
  PLATINUM: 5,
  EMERALD: 6,
  DIAMOND: 7,
  MASTER: 8,
  GRANDMASTER: 9,
  CHALLENGER: 10,
  PRO: 11,
};

const FEATURE_INDEX = {
  minute: 0,
  goldDiff: 1,
  killDiff: 3,
  towerDiff: 4,
  dragonCount: 5,
  enemyDragonCount: 6,
  hasDragonSoul: 7,
  baronActive: 8,
  championId: 13,
  role: 14,
} as const;

const DEFAULT_WEIGHTS = [
  2.0, // minute
  3.0, // gold diff
  1.0, // normalized gold
  1.25, // kill diff
  1.5, // tower diff
  2.0, // dragon count
  2.0, // enemy dragon count
  2.0, // has soul
  2.0, // baron active
  1.0, // elder
  1.0, // inhibs
  1.0, // cs diff
  1.0, // level diff avg
  5.0, // champion id
  1.5, // role
  1.0, // player kda
  1.0, // player gold share
  1.0, // player cs/min
  1.5, // comp damage
  1.5, // enemy comp damage
];

export interface SimilarGameResult {
  similarity: number;
  gameState: GameStateVector;
  highlightReason: string;
}

export interface SimilaritySearchResult {
  query: {
    champion: string;
    minute: number;
    goldDiff: number;
    situation: string;
  };
  results: SimilarGameResult[];
  aiInsight: string;
}

export interface SearchOptions {
  k?: number;
  sameChampion?: boolean;
  sameRole?: boolean;
  minRank?: string;
  proOnly?: boolean;
  patchFilter?: string;
}

type CandidateVectorRow = {
  matchId: string;
  minute: number;
  playerPuuid: string | null;
  championName: string | null;
  role: string | null;
  rank: string | null;
  isProGame: boolean;
  playerName: string | null;
  teamName: string | null;
  patch: string | null;
  features: unknown;
  outcome: unknown;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));
}

function normalizeRank(rank: string | null | undefined): string {
  if (!rank) {
    return "UNKNOWN";
  }

  return rank.toUpperCase().trim();
}

function passesMinRank(rank: string | null | undefined, minRank: string): boolean {
  if (minRank === "ANY") {
    return true;
  }

  const normalizedRank = normalizeRank(rank);
  const rankValue = RANK_ORDER[normalizedRank] ?? 0;
  const minValue = RANK_ORDER[minRank] ?? 0;

  return rankValue >= minValue;
}

function toOutcome(value: unknown): GameStateVector["outcome"] {
  if (typeof value !== "object" || value === null) {
    return {
      wonGame: false,
      next5MinEvents: "Outcome unavailable.",
      goldDiffChange5Min: 0,
      towersChange5Min: 0,
      killsChange5Min: 0,
      objectivesTaken: [],
      winProbChange: 0,
    };
  }

  const record = value as Record<string, unknown>;
  return {
    wonGame: Boolean(record.wonGame),
    next5MinEvents:
      typeof record.next5MinEvents === "string"
        ? record.next5MinEvents
        : "Outcome unavailable.",
    goldDiffChange5Min: Number(record.goldDiffChange5Min ?? 0),
    towersChange5Min: Number(record.towersChange5Min ?? 0),
    killsChange5Min: Number(record.killsChange5Min ?? 0),
    objectivesTaken: Array.isArray(record.objectivesTaken)
      ? record.objectivesTaken
          .map((entry) => String(entry))
          .filter((entry) => entry.length > 0)
      : [],
    winProbChange: Number(record.winProbChange ?? 0),
  };
}

function roundPct(value: number): number {
  return Number((value * 100).toFixed(1));
}

function rankLabel(meta: GameStateVector["metadata"]): string {
  if (meta.isProGame) {
    const parts = [meta.teamName, meta.playerName].filter(Boolean);
    return parts.length > 0 ? parts.join(" - ") : "Pro";
  }

  const rank = meta.rank || "High Elo";
  return `${rank} ${meta.region}`.trim();
}

export class SimilaritySearchEngine {
  private anthropic: Anthropic | null = null;

  private getAnthropicClient(): Anthropic | null {
    if (!ENABLE_AI_INSIGHT || !process.env.ANTHROPIC_API_KEY) {
      return null;
    }

    if (!this.anthropic) {
      this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }

    return this.anthropic;
  }

  private buildSituationDescription(query: GameStateVector): string {
    const features = query.features;
    const goldDiff = features[FEATURE_INDEX.goldDiff] ?? 0;
    const minute = Math.round(features[FEATURE_INDEX.minute] ?? query.metadata.minute);
    const dragons = Math.round(features[FEATURE_INDEX.dragonCount] ?? 0);
    const enemyDragons = Math.round(features[FEATURE_INDEX.enemyDragonCount] ?? 0);
    const towerDiff = Math.round(features[FEATURE_INDEX.towerDiff] ?? 0);
    const baron = (features[FEATURE_INDEX.baronActive] ?? 0) > 0.5;

    const tempo =
      goldDiff <= -1500
        ? "behind in gold"
        : goldDiff >= 1500
          ? "ahead in gold"
          : "gold is close";
    const objectiveState = `dragons ${dragons}-${enemyDragons}, towers ${towerDiff >= 0 ? "+" : ""}${towerDiff}`;
    const objectiveTimer = baron ? "baron buff active" : "major objectives contested";

    return `${tempo} at ${minute}m, ${objectiveState}, ${objectiveTimer}`;
  }

  private toCandidateGameState(row: CandidateVectorRow): GameStateVector | null {
    const features = toNumberArray(row.features);
    if (features.length < 20) {
      return null;
    }

    return {
      features,
      metadata: {
        matchId: row.matchId,
        minute: row.minute,
        playerChampion: row.championName ?? "Unknown",
        playerRole: row.role ?? "UNKNOWN",
        rank: row.rank ?? "UNKNOWN",
        region: row.isProGame ? "Pro" : "Unknown",
        patch: row.patch ?? "Unknown",
        isProGame: row.isProGame,
        playerName: row.playerName ?? undefined,
        teamName: row.teamName ?? undefined,
      },
      outcome: toOutcome(row.outcome),
    };
  }

  private buildHighlightReason(
    query: GameStateVector,
    candidate: GameStateVector,
  ): string {
    const reasons: string[] = [];
    const queryFeatures = query.features;
    const candidateFeatures = candidate.features;

    if (query.metadata.playerChampion === candidate.metadata.playerChampion) {
      reasons.push("same champion");
    }

    if (query.metadata.playerRole === candidate.metadata.playerRole) {
      reasons.push("same role");
    }

    const goldGap = Math.abs(
      (queryFeatures[FEATURE_INDEX.goldDiff] ?? 0) -
      (candidateFeatures[FEATURE_INDEX.goldDiff] ?? 0),
    );
    if (goldGap <= 1000) {
      reasons.push("similar gold state");
    }

    const dragonGap = Math.abs(
      (queryFeatures[FEATURE_INDEX.enemyDragonCount] ?? 0) -
      (candidateFeatures[FEATURE_INDEX.enemyDragonCount] ?? 0),
    );
    if (dragonGap <= 1) {
      reasons.push("similar dragon pressure");
    }

    const minuteGap = Math.abs(query.metadata.minute - candidate.metadata.minute);
    if (minuteGap <= 2) {
      reasons.push("same game phase");
    }

    return reasons.slice(0, 3).join(", ") || "overall vector similarity";
  }

  private candidateFilters(
    queryVector: GameStateVector,
    options: SearchOptions,
  ) {
    const minute = queryVector.metadata.minute;
    const championId = Math.round(queryVector.features[FEATURE_INDEX.championId] ?? 0);
    const roleEncoded = Math.round(queryVector.features[FEATURE_INDEX.role] ?? -1);
    const roleValue = queryVector.metadata.playerRole.toUpperCase();
    const minuteLow = Math.max(1, minute - 2);
    const minuteHigh = minute + 2;

    const conditions = [
      gte(schema.gameStateVectors.minute, minuteLow),
      lte(schema.gameStateVectors.minute, minuteHigh),
      ne(schema.gameStateVectors.matchId, queryVector.metadata.matchId),
    ];

    if (options.sameChampion !== false && championId > 0) {
      conditions.push(eq(schema.gameStateVectors.championId, championId));
    }

    if (
      options.sameRole !== false &&
      roleEncoded >= 0 &&
      ROLE_FILTERS.has(roleValue)
    ) {
      conditions.push(eq(schema.gameStateVectors.role, roleValue));
    }

    if (options.patchFilter) {
      conditions.push(eq(schema.gameStateVectors.patch, options.patchFilter));
    }

    if (options.proOnly) {
      conditions.push(eq(schema.gameStateVectors.isProGame, true));
    }

    return and(...conditions);
  }

  async findSimilar(
    queryVector: GameStateVector,
    options: SearchOptions = {},
  ): Promise<SimilarGameResult[]> {
    if (!process.env.DATABASE_URL) {
      return [];
    }

    const k = Math.max(1, Math.min(options.k ?? 3, 10));
    const minRank = normalizeRank(options.minRank ?? "DIAMOND");
    const whereClause = this.candidateFilters(queryVector, options);

    const rows = await db
      .select({
        matchId: schema.gameStateVectors.matchId,
        minute: schema.gameStateVectors.minute,
        playerPuuid: schema.gameStateVectors.playerPuuid,
        championName: schema.gameStateVectors.championName,
        role: schema.gameStateVectors.role,
        rank: schema.gameStateVectors.rank,
        isProGame: schema.gameStateVectors.isProGame,
        playerName: schema.gameStateVectors.playerName,
        teamName: schema.gameStateVectors.teamName,
        patch: schema.gameStateVectors.patch,
        features: schema.gameStateVectors.features,
        outcome: schema.gameStateVectors.outcome,
      })
      .from(schema.gameStateVectors)
      .where(whereClause)
      .orderBy(sql`${schema.gameStateVectors.createdAt} desc`)
      .limit(8000);

    const queryFeatures = gameStateEncoder.normalizeVector(queryVector.features);
    const scored: SimilarGameResult[] = [];

    for (const row of rows) {
      if (!passesMinRank(row.rank, minRank)) {
        continue;
      }

      const candidate = this.toCandidateGameState(row);
      if (!candidate) {
        continue;
      }

      const candidateFeatures = gameStateEncoder.normalizeVector(candidate.features);
      const similarity = this.weightedSimilarity(
        queryFeatures,
        candidateFeatures,
        DEFAULT_WEIGHTS,
      );

      const bonus =
        options.sameChampion !== false &&
        queryVector.metadata.playerChampion === candidate.metadata.playerChampion
          ? 0.04
          : 0;

      scored.push({
        similarity: clamp(similarity + bonus, 0, 1),
        gameState: candidate,
        highlightReason: this.buildHighlightReason(queryVector, candidate),
      });
    }

    return scored
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) {
      return 0;
    }

    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let index = 0; index < a.length; index += 1) {
      dot += a[index] * b[index];
      magA += a[index] ** 2;
      magB += b[index] ** 2;
    }

    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    if (denom <= 0) {
      return 0;
    }

    return clamp(dot / denom, -1, 1);
  }

  private euclideanDistance(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) {
      return 1;
    }

    let sum = 0;
    for (let index = 0; index < a.length; index += 1) {
      const delta = a[index] - b[index];
      sum += delta ** 2;
    }

    return Math.sqrt(sum);
  }

  private weightedSimilarity(a: number[], b: number[], weights: number[]): number {
    if (a.length !== b.length || a.length === 0) {
      return 0;
    }

    const weightedA = a.map((value, index) => value * (weights[index] ?? 1));
    const weightedB = b.map((value, index) => value * (weights[index] ?? 1));
    const cosine = this.cosineSimilarity(weightedA, weightedB);
    const distance = this.euclideanDistance(weightedA, weightedB);
    const maxDistance = Math.sqrt(weightedA.length * 4);
    const distanceScore = 1 - clamp(distance / Math.max(1e-6, maxDistance), 0, 1);

    return clamp(((cosine + 1) / 2) * 0.75 + distanceScore * 0.25, 0, 1);
  }

  private heuristicInsight(
    queryState: GameStateVector,
    results: SimilarGameResult[],
  ): string {
    if (results.length === 0) {
      return "Not enough similar states yet. Keep collecting games and this recommendation will improve.";
    }

    const wins = results.filter((result) => result.gameState.outcome.wonGame).length;
    const losses = results.length - wins;
    const avgGoldSwing =
      results.reduce(
        (sum, result) => sum + result.gameState.outcome.goldDiffChange5Min,
        0,
      ) / Math.max(1, results.length);
    const objectiveBias = results.filter(
      (result) => result.gameState.outcome.objectivesTaken.length > 0,
    ).length;
    const top = results[0];

    const phase = queryState.metadata.minute <= 15 ? "mid-game setup" : "late-mid transition";
    const trendLine =
      wins >= losses
        ? `In ${wins}/${results.length} similar games, this state converted into a win.`
        : `Only ${wins}/${results.length} similar games converted into a win, so this spot is fragile.`;
    const objectiveLine =
      objectiveBias >= Math.ceil(results.length / 2)
        ? "Objective setup in the next 5 minutes was the most common turning point."
        : "Most comparable games flipped through picks and tempo, not direct objective rushing.";
    const swingLine = `Average 5-minute gold swing was ${avgGoldSwing >= 0 ? "+" : ""}${Math.round(avgGoldSwing)}g.`;
    const referenceLine = `Closest reference (${roundPct(top.similarity)}%): ${rankLabel(top.gameState.metadata)} - ${top.gameState.outcome.next5MinEvents}.`;

    return `${trendLine} ${objectiveLine} ${swingLine} Use this ${phase} window deliberately. ${referenceLine}`;
  }

  async generateInsight(
    queryState: GameStateVector,
    results: SimilarGameResult[],
  ): Promise<string> {
    if (results.length === 0) {
      return this.heuristicInsight(queryState, results);
    }

    const client = this.getAnthropicClient();
    if (!client) {
      return this.heuristicInsight(queryState, results);
    }

    const summary = results.slice(0, 3).map((result, index) => ({
      index: index + 1,
      similarity: roundPct(result.similarity),
      champion: result.gameState.metadata.playerChampion,
      role: result.gameState.metadata.playerRole,
      rank: rankLabel(result.gameState.metadata),
      outcome: result.gameState.outcome,
      reason: result.highlightReason,
    }));

    const prompt = [
      "You are a League of Legends analyst.",
      "Given a query game state and similar historical states, produce a concise 2-3 sentence recommendation.",
      "Focus on what action usually worked in similar games.",
      "",
      `Query champion: ${queryState.metadata.playerChampion}`,
      `Query role: ${queryState.metadata.playerRole}`,
      `Query minute: ${queryState.metadata.minute}`,
      `Query state: ${this.buildSituationDescription(queryState)}`,
      "",
      `Similar states JSON: ${JSON.stringify(summary)}`,
      "",
      "Return plain text only.",
    ].join("\n");

    try {
      const response = await client.messages.create({
        model: SONNET_MODEL,
        max_tokens: 250,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .map((block) =>
          block.type === "text" ? block.text : "",
        )
        .join("\n")
        .trim();

      if (text.length > 0) {
        return text;
      }
    } catch (error) {
      console.warn("[SimilaritySearch] AI insight generation failed, using heuristic:", error);
    }

    return this.heuristicInsight(queryState, results);
  }

  async search(
    match: MatchDto,
    timeline: MatchTimelineDto,
    playerPuuid: string,
    minute: number,
    options: SearchOptions = {},
  ): Promise<SimilaritySearchResult> {
    const queryVector = gameStateEncoder.encodeGameState(
      match,
      timeline,
      playerPuuid,
      minute,
    );
    const results = await this.findSimilar(queryVector, options);
    const aiInsight = await this.generateInsight(queryVector, results);

    return {
      query: {
        champion: queryVector.metadata.playerChampion,
        minute: queryVector.metadata.minute,
        goldDiff: Math.round(queryVector.features[FEATURE_INDEX.goldDiff] ?? 0),
        situation: this.buildSituationDescription(queryVector),
      },
      results,
      aiInsight,
    };
  }
}

export const similaritySearchEngine = new SimilaritySearchEngine();
