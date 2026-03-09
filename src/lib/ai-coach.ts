import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { CompactedMatchData } from "@/lib/match-compactor";
import { getItems } from "@/lib/data-dragon";
import { logger } from "@/lib/logger";
import { opggClient } from "@/lib/opgg-mcp";
import { patchTracker } from "@/lib/patch-tracker";
import type {
  EnemyLanerStats,
  EnemySummary,
  GameSummary,
  LiveGameScoutOutput,
  MatchAnalysisOutput,
  PatternAnalysisOutput,
  StatPattern,
} from "@/lib/types/analysis";

const OPUS_MODEL_VERSION = process.env.ANTHROPIC_OPUS_MODEL ?? "claude-opus-4-6";
const SONNET_MODEL_VERSION = process.env.ANTHROPIC_SONNET_MODEL ?? "claude-sonnet-4-6";
const MATCH_ANALYSIS_PRIMARY_MODEL =
  process.env.ANTHROPIC_MATCH_ANALYSIS_MODEL ?? SONNET_MODEL_VERSION;
const MODEL_VERSION = OPUS_MODEL_VERSION;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_API_RETRIES = 3;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type PatternCacheEntry = {
  expiresAt: number;
  value: PatternAnalysisOutput;
};

type ScoutCacheEntry = {
  expiresAt: number;
  value: LiveGameScoutOutput;
};

type JsonRecord = Record<string, unknown>;
type ModelFamily = "opus" | "sonnet" | "unknown";

type AIUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  model: string;
};

type AIResponseWithUsage = {
  text: string;
  usage: AIUsageSummary;
};

type ParsedResponseWithUsage<T> = {
  parsed: T;
  usage: AIUsageSummary;
};

type AnalysisLogParams = {
  matchId?: string | null;
  puuid?: string | null;
  analysisType: string;
  modelVersion: string;
  coachingText: string;
  analysisJson: unknown;
  usage: AIUsageSummary;
};

class AICircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AICircuitBreakerError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function coerceGrade(value: unknown): MatchAnalysisOutput["overall_grade"] {
  if (typeof value !== "string") {
    return "N/A";
  }

  const normalized = value.toUpperCase();
  if (["A", "B", "C", "D", "F", "N/A"].includes(normalized)) {
    return normalized as MatchAnalysisOutput["overall_grade"];
  }

  return "N/A";
}

function coerceBuildRating(
  value: unknown,
): MatchAnalysisOutput["build_analysis"]["rating"] {
  if (value === "optimal" || value === "suboptimal" || value === "poor") {
    return value;
  }

  return "suboptimal";
}

function fallbackMatchAnalysis(reason = "Analysis is temporarily unavailable."): MatchAnalysisOutput {
  return {
    overall_grade: "N/A",
    summary: reason,
    key_moments: [],
    build_analysis: {
      rating: "suboptimal",
      explanation: "Build analysis unavailable right now.",
      suggested_changes: [],
    },
    laning_phase: {
      cs_assessment: "Unavailable",
      trade_patterns: "Unavailable",
      tips: ["Try again shortly for full AI laning feedback."],
    },
    macro_assessment: {
      objective_participation: "Unavailable",
      map_presence: "Unavailable",
      tips: ["Try again shortly for full AI macro feedback."],
    },
    top_3_improvements: [
      "Review key deaths around objectives.",
      "Track item spikes before committing to fights.",
      "Retry analysis when the AI service is available.",
    ],
  };
}

function fallbackPatternAnalysis(reason = "Pattern analysis is temporarily unavailable."): PatternAnalysisOutput {
  return {
    patterns: [],
    overall_coaching_plan: reason,
  };
}

function fallbackLiveScout(reason = "Live scout is temporarily unavailable."): LiveGameScoutOutput {
  return {
    lane_matchup: {
      difficulty: "medium",
      their_win_condition: "Unavailable",
      your_win_condition: "Unavailable",
      power_spikes: "Unavailable",
      key_ability_to_watch: "Unavailable",
    },
    enemy_player_tendencies: {
      playstyle: "Unavailable",
      exploitable_weaknesses: [],
      danger_zones: [],
    },
    team_fight_plan: {
      their_comp_identity: "Unavailable",
      our_comp_identity: "Unavailable",
      how_to_win_fights: "Unavailable",
    },
    recommended_build_path: {
      core_items: [],
      reasoning: reason,
    },
    three_things_to_remember: ["Play around vision.", "Track cooldowns.", "Protect carries."],
  };
}

function extractTextFromAnthropicContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        return block.text;
      }

      return "";
    })
    .join("\n")
    .trim();
}

function stripJsonFences(text: string): string {
  return text.replace(/```json\s*|```\s*/gi, "").trim();
}

function parseJson(text: string): unknown {
  const cleaned = stripJsonFences(text);

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const candidate = cleaned.slice(start, end + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        // Try one more permissive pass below.
      }
    }

    const withoutTrailingCommas = cleaned.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(withoutTrailingCommas);
  }
}

function normalizeMatchAnalysis(value: unknown): MatchAnalysisOutput | null {
  if (!isRecord(value)) {
    return null;
  }

  const keyMomentsInput = Array.isArray(value.key_moments) ? value.key_moments : [];
  const keyMoments: MatchAnalysisOutput["key_moments"] = [];

  for (const entry of keyMomentsInput) {
    if (!isRecord(entry)) {
      continue;
    }

    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
    const type = entry.type === "mistake" || entry.type === "good_play" ? entry.type : "mistake";
    const title = typeof entry.title === "string" ? entry.title : "Key moment";
    const explanation =
      typeof entry.explanation === "string" ? entry.explanation : "No explanation provided.";
    const whatToDoInstead =
      typeof entry.what_to_do_instead === "string" ? entry.what_to_do_instead : undefined;
    const winProbImpact =
      typeof entry.win_prob_impact === "number" ? entry.win_prob_impact : 0;

    keyMoments.push({
      timestamp,
      type,
      title,
      explanation,
      what_to_do_instead: whatToDoInstead,
      win_prob_impact: winProbImpact,
    });
  }

  const buildAnalysisInput = isRecord(value.build_analysis) ? value.build_analysis : {};
  const laningInput = isRecord(value.laning_phase) ? value.laning_phase : {};
  const macroInput = isRecord(value.macro_assessment) ? value.macro_assessment : {};

  return {
    overall_grade: coerceGrade(value.overall_grade),
    summary:
      typeof value.summary === "string"
        ? value.summary
        : "No summary generated.",
    key_moments: keyMoments,
    build_analysis: {
      rating: coerceBuildRating(buildAnalysisInput.rating),
      explanation:
        typeof buildAnalysisInput.explanation === "string"
          ? buildAnalysisInput.explanation
          : "No build explanation generated.",
      what_they_built_well:
        typeof buildAnalysisInput.what_they_built_well === "string"
          ? buildAnalysisInput.what_they_built_well
          : undefined,
      suggested_changes: toStringArray(buildAnalysisInput.suggested_changes),
    },
    laning_phase: {
      cs_assessment:
        typeof laningInput.cs_assessment === "string"
          ? laningInput.cs_assessment
          : "Unavailable",
      trade_patterns:
        typeof laningInput.trade_patterns === "string"
          ? laningInput.trade_patterns
          : "Unavailable",
      tips: toStringArray(laningInput.tips),
    },
    macro_assessment: {
      objective_participation:
        typeof macroInput.objective_participation === "string"
          ? macroInput.objective_participation
          : "Unavailable",
      map_presence:
        typeof macroInput.map_presence === "string"
          ? macroInput.map_presence
          : "Unavailable",
      tips: toStringArray(macroInput.tips),
    },
    top_3_improvements: toStringArray(value.top_3_improvements).slice(0, 3),
  };
}

function normalizePatternAnalysis(value: unknown): PatternAnalysisOutput | null {
  if (!isRecord(value)) {
    return null;
  }

  const patternsInput = Array.isArray(value.patterns) ? value.patterns : [];
  const patterns = patternsInput
    .map((pattern) => {
      if (!isRecord(pattern)) {
        return null;
      }

      const priority =
        pattern.priority === "high" || pattern.priority === "medium" || pattern.priority === "low"
          ? pattern.priority
          : "medium";

      return {
        pattern_name:
          typeof pattern.pattern_name === "string" ? pattern.pattern_name : "Unknown pattern",
        frequency: typeof pattern.frequency === "string" ? pattern.frequency : "Unknown",
        description:
          typeof pattern.description === "string"
            ? pattern.description
            : "No description provided.",
        root_cause:
          typeof pattern.root_cause === "string"
            ? pattern.root_cause
            : "No root cause provided.",
        specific_fix:
          typeof pattern.specific_fix === "string"
            ? pattern.specific_fix
            : "No fix provided.",
        priority,
      };
    })
    .filter(
      (pattern): pattern is PatternAnalysisOutput["patterns"][number] =>
        pattern !== null,
    );

  return {
    patterns,
    overall_coaching_plan:
      typeof value.overall_coaching_plan === "string"
        ? value.overall_coaching_plan
        : "No coaching plan generated.",
  };
}

function normalizeLiveScout(value: unknown): LiveGameScoutOutput | null {
  if (!isRecord(value)) {
    return null;
  }

  const laneMatchup = isRecord(value.lane_matchup) ? value.lane_matchup : {};
  const tendencies = isRecord(value.enemy_player_tendencies)
    ? value.enemy_player_tendencies
    : {};
  const teamFightPlan = isRecord(value.team_fight_plan) ? value.team_fight_plan : {};
  const buildPath = isRecord(value.recommended_build_path)
    ? value.recommended_build_path
    : {};

  const difficulty =
    laneMatchup.difficulty === "easy" ||
    laneMatchup.difficulty === "medium" ||
    laneMatchup.difficulty === "hard"
      ? laneMatchup.difficulty
      : "medium";

  return {
    lane_matchup: {
      difficulty,
      their_win_condition:
        typeof laneMatchup.their_win_condition === "string"
          ? laneMatchup.their_win_condition
          : "Unavailable",
      your_win_condition:
        typeof laneMatchup.your_win_condition === "string"
          ? laneMatchup.your_win_condition
          : "Unavailable",
      power_spikes:
        typeof laneMatchup.power_spikes === "string" ? laneMatchup.power_spikes : "Unavailable",
      key_ability_to_watch:
        typeof laneMatchup.key_ability_to_watch === "string"
          ? laneMatchup.key_ability_to_watch
          : "Unavailable",
    },
    enemy_player_tendencies: {
      playstyle:
        typeof tendencies.playstyle === "string" ? tendencies.playstyle : "Unavailable",
      exploitable_weaknesses: toStringArray(tendencies.exploitable_weaknesses),
      danger_zones: toStringArray(tendencies.danger_zones),
    },
    team_fight_plan: {
      their_comp_identity:
        typeof teamFightPlan.their_comp_identity === "string"
          ? teamFightPlan.their_comp_identity
          : "Unavailable",
      our_comp_identity:
        typeof teamFightPlan.our_comp_identity === "string"
          ? teamFightPlan.our_comp_identity
          : "Unavailable",
      how_to_win_fights:
        typeof teamFightPlan.how_to_win_fights === "string"
          ? teamFightPlan.how_to_win_fights
          : "Unavailable",
    },
    recommended_build_path: {
      core_items: toStringArray(buildPath.core_items),
      reasoning: typeof buildPath.reasoning === "string" ? buildPath.reasoning : "Unavailable",
    },
    three_things_to_remember: toStringArray(value.three_things_to_remember),
  };
}

function isFallbackMatchAnalysis(analysis: MatchAnalysisOutput): boolean {
  const summary = analysis.summary.toLowerCase();
  if (
    summary.includes("temporarily unavailable") ||
    summary.includes("not configured") ||
    summary.includes("at capacity")
  ) {
    return true;
  }

  return analysis.laning_phase.tips.some((tip) =>
    tip.toLowerCase().includes("try again shortly"),
  );
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (isRecord(value)) {
    const sortedKeys = Object.keys(value).sort();
    return `{${sortedKeys
      .map((key) => `${key}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export class AICoach {
  private client: Anthropic | null;
  private readonly patternCache = new Map<string, PatternCacheEntry>();
  private readonly scoutCache = new Map<string, ScoutCacheEntry>();

  constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  private isRetryableStatus(status: number | null): boolean {
    return status === 429 || status === 500 || status === 503;
  }

  private getErrorStatus(error: unknown): number | null {
    if (isRecord(error) && typeof error.status === "number") {
      return error.status;
    }

    return null;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Anthropic request timed out.")), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async callAnthropic(
    prompt: string,
    maxTokens: number,
    model = MODEL_VERSION,
  ): Promise<AIResponseWithUsage> {
    if (!this.client) {
      throw new Error("ANTHROPIC_API_KEY is not configured.");
    }

    await this.assertSpendCircuitBreaker();

    for (let attempt = 1; attempt <= MAX_API_RETRIES; attempt += 1) {
      try {
        const response = await this.withTimeout(
          this.client.messages.create({
            model,
            max_tokens: maxTokens,
            messages: [{ role: "user", content: prompt }],
          }),
        );

        const usage = response.usage;
        const inputTokens =
          usage && typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        const outputTokens =
          usage && typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
        const estimatedCostUsd = this.estimateCallCostUsd(model, inputTokens, outputTokens);

        logger.info("Anthropic call succeeded.", {
          endpoint: "AICoach.callAnthropic",
          model,
          inputTokens,
          outputTokens,
          estimatedCostUsd,
        });

        return {
          text: extractTextFromAnthropicContent(response.content),
          usage: {
            inputTokens,
            outputTokens,
            estimatedCostUsd,
            model,
          },
        };
      } catch (error) {
        const status = this.getErrorStatus(error);
        if (attempt < MAX_API_RETRIES && this.isRetryableStatus(status)) {
          const backoffMs = 2 ** (attempt - 1) * 1000;
          await sleep(backoffMs);
          continue;
        }

        logger.error("Anthropic call failed.", {
          endpoint: "AICoach.callAnthropic",
          model,
          status: status ?? "unknown",
          promptLength: prompt.length,
          retryAttempt: attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    throw new Error("Anthropic retries exhausted.");
  }

  private async generateJsonResponse<T>(params: {
    prompt: string;
    shorterPrompt: string;
    normalize: (value: unknown) => T | null;
    maxTokens: number;
    model?: string;
  }): Promise<ParsedResponseWithUsage<T>> {
    const firstCall = await this.callAnthropic(
      params.prompt,
      params.maxTokens,
      params.model ?? MODEL_VERSION,
    );
    const firstRaw = firstCall.text;

    try {
      const parsed = params.normalize(parseJson(firstRaw));
      if (parsed) {
        return {
          parsed,
          usage: firstCall.usage,
        };
      }
    } catch {
      // Retry below with shorter prompt.
    }

    const secondCall = await this.callAnthropic(
      params.shorterPrompt,
      params.maxTokens,
      params.model ?? MODEL_VERSION,
    );
    const secondRaw = secondCall.text;
    const parsedSecond = params.normalize(parseJson(secondRaw));

    if (!parsedSecond) {
      throw new Error("AI response was not valid JSON in the expected schema.");
    }

    return {
      parsed: parsedSecond,
      usage: {
        inputTokens: firstCall.usage.inputTokens + secondCall.usage.inputTokens,
        outputTokens: firstCall.usage.outputTokens + secondCall.usage.outputTokens,
        estimatedCostUsd:
          firstCall.usage.estimatedCostUsd + secondCall.usage.estimatedCostUsd,
        model: params.model ?? MODEL_VERSION,
      },
    };
  }

  private getModelFamily(model: string): ModelFamily {
    const normalized = model.toLowerCase();
    if (normalized.includes("opus")) {
      return "opus";
    }
    if (normalized.includes("sonnet")) {
      return "sonnet";
    }
    return "unknown";
  }

  private estimateCallCostUsd(model: string, inputTokens: number, outputTokens: number): number {
    const family = this.getModelFamily(model);
    const inputPerMillion =
      family === "opus"
        ? 15
        : family === "sonnet"
          ? 3
          : 10;
    const outputPerMillion =
      family === "opus"
        ? 75
        : family === "sonnet"
          ? 15
          : 50;

    const inputCost = (Math.max(0, inputTokens) / 1_000_000) * inputPerMillion;
    const outputCost = (Math.max(0, outputTokens) / 1_000_000) * outputPerMillion;
    return Number((inputCost + outputCost).toFixed(6));
  }

  private getDailySpendLimitUsd(): number {
    const parsed = Number(process.env.AI_DAILY_SPEND_LIMIT_USD ?? 50);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 50;
    }
    return parsed;
  }

  private startOfUtcDay(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private async getTodayAICostUsd(): Promise<number> {
    if (!process.env.DATABASE_URL) {
      return 0;
    }

    const dayStart = this.startOfUtcDay();
    const rows = await db
      .select({
        total: sql<string>`coalesce(sum(${schema.aiAnalyses.estimatedCost}), 0)`,
      })
      .from(schema.aiAnalyses)
      .where(gte(schema.aiAnalyses.createdAt, dayStart))
      .limit(1);

    const parsed = Number(rows[0]?.total ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async assertSpendCircuitBreaker(): Promise<void> {
    const limit = this.getDailySpendLimitUsd();
    const currentSpend = await this.getTodayAICostUsd();

    if (currentSpend >= limit) {
      throw new AICircuitBreakerError(
        "AI coaching is temporarily at capacity. Stats and graphs are still available.",
      );
    }
  }

  private async getCachedMatchAnalysis(
    matchId: string,
    playerPuuid: string,
  ): Promise<MatchAnalysisOutput | null> {
    if (!process.env.DATABASE_URL) {
      return null;
    }

    try {
      const cutoff = new Date(Date.now() - CACHE_TTL_MS);
      const cached = await db
        .select({
          analysisJson: schema.aiAnalyses.analysisJson,
        })
        .from(schema.aiAnalyses)
        .where(
          and(
            eq(schema.aiAnalyses.matchId, matchId),
            eq(schema.aiAnalyses.puuid, playerPuuid),
            eq(schema.aiAnalyses.analysisType, "match_review"),
            gte(schema.aiAnalyses.createdAt, cutoff),
          ),
        )
        .limit(1);

      if (cached.length === 0) {
        return null;
      }

      const normalized = normalizeMatchAnalysis(cached[0].analysisJson);
      if (!normalized || isFallbackMatchAnalysis(normalized)) {
        return null;
      }

      return normalized;
    } catch (error) {
      console.error("[AICoach] Failed to read cached match analysis:", error);
      return null;
    }
  }

  private async saveCachedMatchAnalysis(params: {
    matchId: string;
    playerPuuid: string;
    analysis: MatchAnalysisOutput;
    usage: AIUsageSummary;
    modelVersion: string;
  }): Promise<void> {
    if (!process.env.DATABASE_URL) {
      return;
    }

    try {
      await db
        .insert(schema.aiAnalyses)
        .values({
          matchId: params.matchId,
          puuid: params.playerPuuid,
          analysisType: "match_review",
          analysisJson: params.analysis,
          coachingText: params.analysis.summary,
          modelVersion: params.modelVersion,
          inputTokens: params.usage.inputTokens,
          outputTokens: params.usage.outputTokens,
          estimatedCost: params.usage.estimatedCostUsd.toFixed(6),
          createdAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.aiAnalyses.matchId,
            schema.aiAnalyses.puuid,
            schema.aiAnalyses.analysisType,
          ],
          set: {
            analysisJson: params.analysis,
            coachingText: params.analysis.summary,
            modelVersion: params.modelVersion,
            inputTokens: params.usage.inputTokens,
            outputTokens: params.usage.outputTokens,
            estimatedCost: params.usage.estimatedCostUsd.toFixed(6),
            createdAt: new Date(),
          },
        });
    } catch (error) {
      console.error("[AICoach] Failed to cache match analysis:", error);
    }
  }

  private async logAnalysisUsage(params: AnalysisLogParams): Promise<void> {
    if (!process.env.DATABASE_URL) {
      return;
    }

    try {
      await db.insert(schema.aiAnalyses).values({
        matchId: params.matchId ?? null,
        puuid: params.puuid ?? "unknown",
        analysisType: params.analysisType,
        analysisJson: params.analysisJson,
        coachingText: params.coachingText,
        modelVersion: params.modelVersion,
        inputTokens: params.usage.inputTokens,
        outputTokens: params.usage.outputTokens,
        estimatedCost: params.usage.estimatedCostUsd.toFixed(6),
        createdAt: new Date(),
      });
    } catch (error) {
      logger.warn("Failed to write AI usage row.", {
        endpoint: "AICoach.logAnalysisUsage",
        analysisType: params.analysisType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async analyzeMatch(params: {
    compactedData: CompactedMatchData;
    formatForPrompt: (data: CompactedMatchData) => string;
    matchId?: string;
    playerPuuid?: string;
    playerChampion?: string;
    playerItems?: number[];
    matchPatch?: string;
    abilityContext?: string;
  }): Promise<MatchAnalysisOutput> {
    const {
      compactedData,
      formatForPrompt,
      matchId,
      playerPuuid,
      playerChampion,
      playerItems,
      matchPatch,
      abilityContext,
    } = params;

    if (matchId && playerPuuid) {
      const cached = await this.getCachedMatchAnalysis(matchId, playerPuuid);
      if (cached) {
        return cached;
      }
    }

    if (!this.client) {
      return fallbackMatchAnalysis(
        "AI analysis is temporarily unavailable because ANTHROPIC_API_KEY is not configured.",
      );
    }

    const formattedMatchRaw = formatForPrompt(compactedData);
    const formattedMatch =
      formattedMatchRaw.length > 7000
        ? `${formattedMatchRaw.slice(0, 7000)}\n[TRUNCATED FOR LATENCY]`
        : formattedMatchRaw;
    const truncatedMatch =
      formattedMatch.length > 4500
        ? `${formattedMatch.slice(0, 4500)}\n[TRUNCATED FOR RETRY]`
        : formattedMatch;

    const resolvedChampion = playerChampion ?? compactedData.playerInfo.champion;
    const resolvedItems = playerItems ?? [];
    const resolvedPatch = matchPatch;

    let championPatchContext: string | null = null;
    let itemPatchContext: string | null = null;
    let opggMetaContext: string | null = null;
    if (resolvedPatch) {
      try {
        [championPatchContext, itemPatchContext] = await Promise.all([
          patchTracker.getPatchContextForChampion(resolvedChampion, resolvedPatch),
          patchTracker.getPatchContextForItems(resolvedItems, resolvedPatch),
        ]);
      } catch (error) {
        console.warn("[AICoach] Failed to load patch context:", error);
      }
    }

    try {
      const role = compactedData.playerInfo.role;
      const opggMeta = await opggClient.getChampionMeta(resolvedChampion, role);
      const itemsById = await getItems();
      const coreNames = opggMeta.builds.items.coreItems
        .map((itemId) => itemsById.get(itemId)?.name ?? `Item ${itemId}`)
        .slice(0, 4);
      const bootName =
        opggMeta.builds.items.boots > 0
          ? itemsById.get(opggMeta.builds.items.boots)?.name ?? `Item ${opggMeta.builds.items.boots}`
          : "No standard boot";
      opggMetaContext =
        `OP.GG current patch baseline (${Math.round(opggMeta.winRate * 100)}% WR, ${opggMeta.sampleSize} games): ` +
        `Core ${coreNames.join(" -> ") || "N/A"}, Boots ${bootName}, Skill order ${opggMeta.builds.skillOrder || "N/A"}.`;
    } catch (error) {
      console.warn("[AICoach] Failed to load OP.GG meta context:", error);
      opggMetaContext = null;
    }

    const buildPrompt = (matchText: string) => `
You are an expert League of Legends coach analyzing a player's ranked game for WinCon.gg.

${matchText}

## Patch Context (current patch changes relevant to this game)
${championPatchContext ?? "No changes to your champion this patch."}
${itemPatchContext ?? "No changes to your items this patch."}

## Ability Cooldowns at Time of Death
${abilityContext ?? "Ability cooldown context unavailable for this match."}

## OP.GG Meta Baseline
${opggMetaContext ?? "OP.GG meta baseline unavailable for this matchup."}

## Analysis Instructions
Provide coaching feedback in this exact JSON structure:
{
  "overall_grade": "A/B/C/D/F",
  "summary": "2-3 sentence overall assessment",
  "key_moments": [
    {
      "timestamp": "14:32",
      "type": "mistake | good_play",
      "title": "Short title",
      "explanation": "Why this mattered",
      "what_to_do_instead": "Only for mistakes",
      "win_prob_impact": -14
    }
  ],
  "build_analysis": {
    "rating": "optimal/suboptimal/poor",
    "explanation": "Analysis based on BOTH team compositions",
    "what_they_built_well": "...",
    "suggested_changes": ["..."]
  },
  "laning_phase": {
    "cs_assessment": "...",
    "trade_patterns": "...",
    "tips": ["..."]
  },
  "macro_assessment": {
    "objective_participation": "...",
    "map_presence": "...",
    "tips": ["..."]
  },
  "top_3_improvements": ["...", "...", "..."]
}

Respond ONLY with valid JSON. No markdown fences, no preamble, no explanation outside the JSON.
`.trim();

    try {
      const analysis = await this.generateJsonResponse<MatchAnalysisOutput>({
        prompt: buildPrompt(formattedMatch),
        shorterPrompt: buildPrompt(truncatedMatch),
        normalize: normalizeMatchAnalysis,
        maxTokens: 1200,
        model: MATCH_ANALYSIS_PRIMARY_MODEL,
      });

      if (matchId && playerPuuid) {
        await this.saveCachedMatchAnalysis({
          matchId,
          playerPuuid,
          analysis: analysis.parsed,
          usage: analysis.usage,
          modelVersion: analysis.usage.model,
        });
      }

      return analysis.parsed;
    } catch (error) {
      if (error instanceof AICircuitBreakerError) {
        return fallbackMatchAnalysis(error.message);
      }
      logger.error("analyzeMatch failed.", {
        endpoint: "AICoach.analyzeMatch",
        error: error instanceof Error ? error.message : String(error),
      });
      return fallbackMatchAnalysis(
        "AI analysis is temporarily unavailable. Please retry in a minute.",
      );
    }
  }

  async detectPatterns(params: {
    playerPuuid?: string;
    playerInfo: { gameName: string; tagLine: string; tier: string; division: string };
    recentGames: GameSummary[];
    detectedPatterns: StatPattern[];
  }): Promise<PatternAnalysisOutput> {
    const cacheKey = stableStringify(params);
    const cached = this.patternCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (!this.client) {
      return fallbackPatternAnalysis(
        "Pattern analysis is unavailable because ANTHROPIC_API_KEY is not configured.",
      );
    }

    const prompt = `
You are an expert League of Legends coach for WinCon.gg.
Analyze recurring issues across this player's recent ranked games.

PLAYER
${params.playerInfo.gameName}#${params.playerInfo.tagLine} - ${params.playerInfo.tier} ${params.playerInfo.division}

RECENT_GAMES
${JSON.stringify(params.recentGames)}

STAT_PATTERNS
${JSON.stringify(params.detectedPatterns)}

Return ONLY valid JSON in this shape:
{
  "patterns": [
    {
      "pattern_name": "...",
      "frequency": "...",
      "description": "...",
      "root_cause": "...",
      "specific_fix": "...",
      "priority": "high|medium|low"
    }
  ],
  "overall_coaching_plan": "..."
}
`.trim();

    const shorterPrompt = `
You are a League coach. Return only JSON with keys: patterns, overall_coaching_plan.
Patterns must include: pattern_name, frequency, description, root_cause, specific_fix, priority.
Input:
${JSON.stringify({
  playerInfo: params.playerInfo,
  recentGames: params.recentGames.slice(0, 8),
  detectedPatterns: params.detectedPatterns.slice(0, 8),
})}
`.trim();

    try {
      const analysis = await this.generateJsonResponse<PatternAnalysisOutput>({
        prompt,
        shorterPrompt,
        normalize: normalizePatternAnalysis,
        maxTokens: 2500,
        model: SONNET_MODEL_VERSION,
      });

      await this.logAnalysisUsage({
        matchId: null,
        puuid: params.playerPuuid,
        analysisType: "pattern_detect",
        modelVersion: SONNET_MODEL_VERSION,
        coachingText: analysis.parsed.overall_coaching_plan,
        analysisJson: analysis.parsed,
        usage: analysis.usage,
      });

      this.patternCache.set(cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        value: analysis.parsed,
      });

      return analysis.parsed;
    } catch (error) {
      if (error instanceof AICircuitBreakerError) {
        return fallbackPatternAnalysis(error.message);
      }
      logger.error("detectPatterns failed.", {
        endpoint: "AICoach.detectPatterns",
        error: error instanceof Error ? error.message : String(error),
      });
      return fallbackPatternAnalysis(
        "Pattern analysis is temporarily unavailable. Please retry shortly.",
      );
    }
  }

  async scoutLiveGame(params: {
    playerPuuid?: string;
    ourChampion: string;
    ourRole: string;
    ourRank: string;
    allyTeam: string;
    enemyTeam: string;
    allyCompTags: string;
    enemyCompTags: string;
    enemyLaner: EnemyLanerStats;
    allEnemies: EnemySummary[];
    abilityMatchupContext?: string;
    matchupGuideSummary?: string;
    matchupGuideTips?: string[];
    opggCounterContext?: string;
  }): Promise<LiveGameScoutOutput> {
    const cacheKey = stableStringify(params);
    const cached = this.scoutCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (!this.client) {
      return fallbackLiveScout(
        "Live scout is unavailable because ANTHROPIC_API_KEY is not configured.",
      );
    }

    const prompt = `
You are an expert League of Legends coach producing a loading-screen scout report for WinCon.gg.

OUR_CHAMPION: ${params.ourChampion}
OUR_ROLE: ${params.ourRole}
OUR_RANK: ${params.ourRank}
ALLY_TEAM: ${params.allyTeam}
ENEMY_TEAM: ${params.enemyTeam}
ALLY_COMP_TAGS: ${params.allyCompTags}
ENEMY_COMP_TAGS: ${params.enemyCompTags}
ENEMY_LANER: ${JSON.stringify(params.enemyLaner)}
ALL_ENEMIES: ${JSON.stringify(params.allEnemies)}
MATCHUP_GUIDE_SUMMARY: ${params.matchupGuideSummary ?? "Unavailable"}
MATCHUP_GUIDE_TIPS: ${JSON.stringify(params.matchupGuideTips ?? [])}
ABILITY_MATCHUP_CONTEXT: ${params.abilityMatchupContext ?? "Unavailable"}
OPGG_COUNTER_CONTEXT: ${params.opggCounterContext ?? "Unavailable"}

Return ONLY valid JSON with this shape:
{
  "lane_matchup": {
    "difficulty": "easy|medium|hard",
    "their_win_condition": "...",
    "your_win_condition": "...",
    "power_spikes": "...",
    "key_ability_to_watch": "..."
  },
  "enemy_player_tendencies": {
    "playstyle": "...",
    "exploitable_weaknesses": ["..."],
    "danger_zones": ["..."]
  },
  "team_fight_plan": {
    "their_comp_identity": "...",
    "our_comp_identity": "...",
    "how_to_win_fights": "..."
  },
  "recommended_build_path": {
    "core_items": ["..."],
    "reasoning": "..."
  },
  "three_things_to_remember": ["...", "...", "..."]
}
`.trim();

    const shorterPrompt = `
Return only JSON with keys:
lane_matchup, enemy_player_tendencies, team_fight_plan, recommended_build_path, three_things_to_remember.
Input:
${JSON.stringify({
  ourChampion: params.ourChampion,
  ourRole: params.ourRole,
  ourRank: params.ourRank,
  allyCompTags: params.allyCompTags,
  enemyCompTags: params.enemyCompTags,
  enemyLaner: params.enemyLaner,
  abilityMatchupContext: params.abilityMatchupContext,
  matchupGuideTips: params.matchupGuideTips,
})}
`.trim();

    try {
      const analysis = await this.generateJsonResponse<LiveGameScoutOutput>({
        prompt,
        shorterPrompt,
        normalize: normalizeLiveScout,
        maxTokens: 2500,
      });

      await this.logAnalysisUsage({
        matchId: null,
        puuid: params.playerPuuid,
        analysisType: "live_scout",
        modelVersion: MODEL_VERSION,
        coachingText: analysis.parsed.team_fight_plan.how_to_win_fights,
        analysisJson: analysis.parsed,
        usage: analysis.usage,
      });

      this.scoutCache.set(cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        value: analysis.parsed,
      });

      return analysis.parsed;
    } catch (error) {
      if (error instanceof AICircuitBreakerError) {
        return fallbackLiveScout(error.message);
      }
      logger.error("scoutLiveGame failed.", {
        endpoint: "AICoach.scoutLiveGame",
        error: error instanceof Error ? error.message : String(error),
      });
      return fallbackLiveScout(
        "Live scout is temporarily unavailable. Please retry shortly.",
      );
    }
  }
}

export const aiCoach = new AICoach();
