import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, sql } from "drizzle-orm";

import {
  abilityDataService,
  type ChampionAbilities,
  type PowerSpike,
  type TradeWindowAnalysis,
} from "@/lib/ability-data";
import { db, schema } from "@/lib/db";
import { opggClient } from "@/lib/opgg-mcp";
import { patchTracker } from "@/lib/patch-tracker";
import { getProMatchupTip } from "@/lib/pro-insights";

export interface MatchupGuide {
  id: string;
  champion: string;
  role: string;
  enemy: string;
  enemyRole: string;
  patch: string;
  winRate: number;
  sampleSize: number;
  difficulty: "easy" | "medium" | "hard";
  summary: string;
  earlyGame: {
    levels1to3: string;
    tradingPattern: string;
    firstBackTiming: string;
    jungleConsiderations: string;
  };
  levelSixSpike: string;
  midGame: string;
  teamfighting: string;
  buildPath: {
    recommended: string[];
    reasoning: string;
  };
  abilityTradeWindows: TradeWindowAnalysis;
  powerSpikes: PowerSpike[];
  proReference?: string;
  tips: string[];
  generatedAt: string;
  modelVersion: string;
}

type CommonMatchupRow = {
  champion: string;
  role: string;
  enemy: string;
  enemyRole: string;
  games: number;
  winRate: number;
};

const MATCHUP_MODEL = process.env.MATCHUP_GUIDE_MODEL ?? "claude-sonnet-4-6-20250514";

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeRole(value: string): string {
  const normalized = value.toUpperCase();
  if (normalized === "MIDDLE") return "MID";
  if (normalized === "UTILITY") return "SUPPORT";
  if (normalized === "BOTTOM") return "ADC";
  return normalized;
}

function slugPart(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "");
}

function matchupId(champion: string, role: string, enemy: string, enemyRole: string): string {
  return `${slugPart(champion)}-${normalizeRole(role)}-vs-${slugPart(enemy)}-${normalizeRole(enemyRole)}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function difficultyFromWinRate(winRate: number): MatchupGuide["difficulty"] {
  if (winRate >= 0.54) return "easy";
  if (winRate <= 0.47) return "hard";
  return "medium";
}

function stripJsonFences(value: string): string {
  return value.replace(/```json\s*|```\s*/gi, "").trim();
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${key}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fallbackGuide(params: {
  champion: string;
  role: string;
  enemy: string;
  enemyRole: string;
  patch: string;
  winRate: number;
  sampleSize: number;
  abilityTradeWindows: TradeWindowAnalysis;
  powerSpikes: PowerSpike[];
  proReference?: string;
}): MatchupGuide {
  const difficulty = difficultyFromWinRate(params.winRate);
  return {
    id: matchupId(params.champion, params.role, params.enemy, params.enemyRole),
    champion: params.champion,
    role: normalizeRole(params.role),
    enemy: params.enemy,
    enemyRole: normalizeRole(params.enemyRole),
    patch: params.patch,
    winRate: clamp01(params.winRate),
    sampleSize: params.sampleSize,
    difficulty,
    summary: `${params.champion} ${normalizeRole(params.role)} vs ${params.enemy} ${normalizeRole(params.enemyRole)} is a ${difficulty} lane this patch. Prioritize cooldown tracking and controlled wave states.`,
    earlyGame: {
      levels1to3:
        "Play around first three waves, contest only when your key cooldown is available, and avoid extended trades without wave cover.",
      tradingPattern: params.abilityTradeWindows.bestTradeWindow,
      firstBackTiming:
        "Base around 1100-1400 gold for first component. Avoid delayed recalls into objective windows.",
      jungleConsiderations:
        "Ward river/tri-brush before 3:15 and refresh vision before each wave crash.",
    },
    levelSixSpike:
      "Level 6 changes lethal ranges. Respect ultimate timers and don't commit if your escape cooldown is unavailable.",
    midGame:
      "Rotate with objective timers and avoid side-lane overextension when enemy engage tools are up.",
    teamfighting:
      "Track enemy primary engage cooldown, play front-to-back when possible, and preserve summoners for key threats.",
    buildPath: {
      recommended: ["Core item 1", "Core item 2", "Situational defense/penetration"],
      reasoning:
        "Build to survive their first threat window, then optimize damage uptime in extended fights.",
    },
    abilityTradeWindows: params.abilityTradeWindows,
    powerSpikes: params.powerSpikes,
    proReference: params.proReference,
    tips: [
      params.abilityTradeWindows.bestTradeWindow,
      params.abilityTradeWindows.dangerAbility,
      "Sync aggressive windows with jungle position and objective spawn timers.",
    ],
    generatedAt: new Date().toISOString(),
    modelVersion: MATCHUP_MODEL,
  };
}

function normalizeGuide(
  value: unknown,
  fallback: MatchupGuide,
): MatchupGuide {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const record = value as Record<string, unknown>;
  const earlyGame = (record.earlyGame ?? {}) as Record<string, unknown>;
  const buildPath = (record.buildPath ?? {}) as Record<string, unknown>;
  const tips = Array.isArray(record.tips)
    ? record.tips.filter((item): item is string => typeof item === "string").slice(0, 5)
    : fallback.tips;

  return {
    ...fallback,
    summary: typeof record.summary === "string" ? record.summary : fallback.summary,
    earlyGame: {
      levels1to3:
        typeof earlyGame.levels1to3 === "string"
          ? earlyGame.levels1to3
          : fallback.earlyGame.levels1to3,
      tradingPattern:
        typeof earlyGame.tradingPattern === "string"
          ? earlyGame.tradingPattern
          : fallback.earlyGame.tradingPattern,
      firstBackTiming:
        typeof earlyGame.firstBackTiming === "string"
          ? earlyGame.firstBackTiming
          : fallback.earlyGame.firstBackTiming,
      jungleConsiderations:
        typeof earlyGame.jungleConsiderations === "string"
          ? earlyGame.jungleConsiderations
          : fallback.earlyGame.jungleConsiderations,
    },
    levelSixSpike:
      typeof record.levelSixSpike === "string" ? record.levelSixSpike : fallback.levelSixSpike,
    midGame: typeof record.midGame === "string" ? record.midGame : fallback.midGame,
    teamfighting:
      typeof record.teamfighting === "string" ? record.teamfighting : fallback.teamfighting,
    buildPath: {
      recommended: Array.isArray(buildPath.recommended)
        ? buildPath.recommended
            .filter((item): item is string => typeof item === "string")
            .slice(0, 5)
        : fallback.buildPath.recommended,
      reasoning:
        typeof buildPath.reasoning === "string"
          ? buildPath.reasoning
          : fallback.buildPath.reasoning,
    },
    proReference:
      typeof record.proReference === "string" ? record.proReference : fallback.proReference,
    tips: tips.length > 0 ? tips : fallback.tips,
  };
}

function formatCounterContext(params: {
  champion: string;
  enemy: string;
  championMeta?: Awaited<ReturnType<typeof opggClient.getChampionMeta>> | null;
  enemyMeta?: Awaited<ReturnType<typeof opggClient.getChampionMeta>> | null;
}): string {
  const lines: string[] = [];

  if (params.championMeta) {
    lines.push(
      `${params.champion} ${params.championMeta.role}: ${Math.round(params.championMeta.winRate * 100)}% WR (${params.championMeta.sampleSize} games).`,
    );
    if (params.championMeta.counters.weakAgainst.length > 0) {
      lines.push(
        `Weak counters for ${params.champion}: ${params.championMeta.counters.weakAgainst
          .slice(0, 3)
          .map((entry) => `${entry.championName} (${Math.round(entry.winRate * 100)}%)`)
          .join(", ")}.`,
      );
    }
  }

  if (params.enemyMeta) {
    lines.push(
      `${params.enemy} ${params.enemyMeta.role}: ${Math.round(params.enemyMeta.winRate * 100)}% WR (${params.enemyMeta.sampleSize} games).`,
    );
    if (params.enemyMeta.counters.weakAgainst.length > 0) {
      lines.push(
        `Weak counters for ${params.enemy}: ${params.enemyMeta.counters.weakAgainst
          .slice(0, 3)
          .map((entry) => `${entry.championName} (${Math.round(entry.winRate * 100)}%)`)
          .join(", ")}.`,
      );
    }
  }

  return lines.join(" ");
}

async function parseGuideFromAnthropic(client: Anthropic, prompt: string): Promise<unknown> {
  const response = await client.messages.create({
    model: MATCHUP_MODEL,
    max_tokens: 3000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .map((entry) => (entry.type === "text" ? entry.text : ""))
    .join("\n")
    .trim();

  return JSON.parse(stripJsonFences(text));
}

export class MatchupGuideService {
  private client: Anthropic | null;
  private memoryCache = new Map<string, MatchupGuide>();

  constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  private cacheKey(champion: string, role: string, enemy: string, patch: string): string {
    return stableStringify({
      champion: normalizeName(champion),
      role: normalizeRole(role),
      enemy: normalizeName(enemy),
      patch,
    });
  }

  private async getMatchupStats(params: {
    champion: string;
    role: string;
    enemy: string;
    enemyRole: string;
  }): Promise<{ winRate: number; sampleSize: number }> {
    if (!process.env.DATABASE_URL) {
      return { winRate: 0.5, sampleSize: 0 };
    }

    const role = normalizeRole(params.role);
    const enemyRole = normalizeRole(params.enemyRole);

    const result = await db.execute(sql`
      select
        count(*)::int as games,
        avg(case when p1.win then 1 else 0 end)::float as win_rate
      from match_participants p1
      join match_participants p2
        on p1.match_id = p2.match_id
        and p1.team_id <> p2.team_id
      where lower(p1.champion_name) = lower(${params.champion})
        and lower(p2.champion_name) = lower(${params.enemy})
        and p1.role = ${role}
        and p2.role = ${enemyRole}
    `);

    const row = result.rows[0] as { games?: number | string; win_rate?: number | string } | undefined;
    const sampleSize = toNumber(row?.games);
    const winRate = clamp01(toNumber(row?.win_rate, 0.5));
    if (sampleSize <= 0) {
      return { winRate: 0.5, sampleSize: 0 };
    }

    return { winRate, sampleSize };
  }

  async generateGuide(
    champion: string,
    role: string,
    enemy: string,
    enemyRole: string,
    winRate: number,
    sampleSize: number,
    abilityData: { player: ChampionAbilities; enemy: ChampionAbilities },
    proGameExamples?: string[],
    patch?: string,
  ): Promise<MatchupGuide> {
    const normalizedRole = normalizeRole(role);
    const normalizedEnemyRole = normalizeRole(enemyRole);
    const resolvedPatch = patch ?? (await patchTracker.getCurrentPatch());

    await abilityDataService.fetchAllChampions();
    const abilityTradeWindows = abilityDataService.getTradeWindows(champion, enemy, 6);
    const powerSpikes = abilityDataService.getPowerSpikes(champion, normalizedRole);

    const fallback = fallbackGuide({
      champion: abilityData.player.champion,
      role: normalizedRole,
      enemy: abilityData.enemy.champion,
      enemyRole: normalizedEnemyRole,
      patch: resolvedPatch,
      winRate,
      sampleSize,
      abilityTradeWindows,
      powerSpikes,
      proReference: proGameExamples?.[0],
    });

    if (!this.client) {
      return fallback;
    }

    const abilityContext = abilityDataService.formatForPrompt(
      abilityData.player.champion,
      abilityData.enemy.champion,
      6,
    );

    const [playerMeta, enemyMeta] = await Promise.all([
      opggClient
        .getChampionMeta(abilityData.player.champion, normalizedRole)
        .catch(() => null),
      opggClient
        .getChampionMeta(abilityData.enemy.champion, normalizedEnemyRole)
        .catch(() => null),
    ]);
    const opggContext = formatCounterContext({
      champion: abilityData.player.champion,
      enemy: abilityData.enemy.champion,
      championMeta: playerMeta,
      enemyMeta,
    });

    const prompt = `
You are an expert League of Legends lane matchup coach writing a WinCon.gg matchup guide.

MATCHUP
Champion: ${abilityData.player.champion} (${normalizedRole})
Enemy: ${abilityData.enemy.champion} (${normalizedEnemyRole})
Patch: ${resolvedPatch}
Win rate: ${(winRate * 100).toFixed(1)}%
Sample size: ${sampleSize}

ABILITY CONTEXT
${abilityContext}

POWER SPIKES
${JSON.stringify(powerSpikes)}

TRADE WINDOWS
${JSON.stringify(abilityTradeWindows)}

PRO REFERENCES
${JSON.stringify(proGameExamples ?? [])}

OP.GG DATA
${opggContext || "No OP.GG matchup context available."}

Return ONLY valid JSON with this structure:
{
  "summary": "2-3 sentence overview",
  "earlyGame": {
    "levels1to3": "...",
    "tradingPattern": "...",
    "firstBackTiming": "...",
    "jungleConsiderations": "..."
  },
  "levelSixSpike": "...",
  "midGame": "...",
  "teamfighting": "...",
  "buildPath": {
    "recommended": ["...", "...", "..."],
    "reasoning": "..."
  },
  "tips": ["...", "...", "..."],
  "proReference": "..."
}
`.trim();

    try {
      const parsed = await parseGuideFromAnthropic(this.client, prompt);
      const merged = normalizeGuide(parsed, fallback);
      return {
        ...merged,
        generatedAt: new Date().toISOString(),
        modelVersion: MATCHUP_MODEL,
      };
    } catch (error) {
      console.error("[MatchupGuideService] Failed to generate guide with Anthropic:", error);
      return fallback;
    }
  }

  async getGuide(
    champion: string,
    role: string,
    enemy: string,
    enemyRole = role,
  ): Promise<MatchupGuide> {
    const patch = await patchTracker.getCurrentPatch();
    const cacheKey = this.cacheKey(champion, role, enemy, patch);
    const memoryCached = this.memoryCache.get(cacheKey);
    if (memoryCached) {
      return memoryCached;
    }

    const normalizedRole = normalizeRole(role);
    const normalizedEnemyRole = normalizeRole(enemyRole);
    const guideId = matchupId(champion, normalizedRole, enemy, normalizedEnemyRole);

    if (process.env.DATABASE_URL) {
      const cached = await db
        .select({ guideJson: schema.matchupGuides.guideJson })
        .from(schema.matchupGuides)
        .where(
          and(
            eq(schema.matchupGuides.id, guideId),
            eq(schema.matchupGuides.patch, patch),
          ),
        )
        .limit(1);

      if (cached[0]?.guideJson) {
        const guide = cached[0].guideJson as MatchupGuide;
        this.memoryCache.set(cacheKey, guide);
        return guide;
      }
    }

    await abilityDataService.fetchAllChampions();
    const [playerAbilities, enemyAbilities, stats, proTip] = await Promise.all([
      abilityDataService.getChampionAbilities(champion),
      abilityDataService.getChampionAbilities(enemy),
      this.getMatchupStats({
        champion,
        role: normalizedRole,
        enemy,
        enemyRole: normalizedEnemyRole,
      }),
      getProMatchupTip({
        ourChampion: champion,
        enemyChampion: enemy,
        role: normalizedRole,
      }).catch(() => null),
    ]);

    const generated = await this.generateGuide(
      playerAbilities.champion,
      normalizedRole,
      enemyAbilities.champion,
      normalizedEnemyRole,
      stats.winRate,
      stats.sampleSize,
      { player: playerAbilities, enemy: enemyAbilities },
      proTip?.summary ? [proTip.summary] : undefined,
      patch,
    );

    if (process.env.DATABASE_URL) {
      await db
        .insert(schema.matchupGuides)
        .values({
          id: generated.id,
          champion: generated.champion,
          role: generated.role,
          enemy: generated.enemy,
          enemyRole: generated.enemyRole,
          patch: generated.patch,
          winRate: generated.winRate.toString(),
          sampleSize: generated.sampleSize,
          difficulty: generated.difficulty,
          guideJson: generated,
          generatedAt: new Date(generated.generatedAt),
          modelVersion: generated.modelVersion,
        })
        .onConflictDoUpdate({
          target: schema.matchupGuides.id,
          set: {
            patch: generated.patch,
            winRate: generated.winRate.toString(),
            sampleSize: generated.sampleSize,
            difficulty: generated.difficulty,
            guideJson: generated,
            generatedAt: new Date(generated.generatedAt),
            modelVersion: generated.modelVersion,
          },
        });
    }

    this.memoryCache.set(cacheKey, generated);
    return generated;
  }

  async seedCommonMatchups(topN: number): Promise<number> {
    if (!process.env.DATABASE_URL) {
      return 0;
    }

    const result = await db.execute(sql`
      select
        p1.champion_name as champion,
        p1.role as role,
        p2.champion_name as enemy,
        p2.role as enemy_role,
        count(*)::int as games,
        avg(case when p1.win then 1 else 0 end)::float as win_rate
      from match_participants p1
      join match_participants p2
        on p1.match_id = p2.match_id
        and p1.team_id <> p2.team_id
        and p1.role = p2.role
      where p1.role in ('TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT')
      group by p1.champion_name, p1.role, p2.champion_name, p2.role
      order by games desc
      limit ${Math.max(1, topN)}
    `);

    const rows = result.rows as Array<{
      champion?: unknown;
      role?: unknown;
      enemy?: unknown;
      enemy_role?: unknown;
      games?: unknown;
      win_rate?: unknown;
    }>;

    const common = rows
      .map((row) => ({
        champion: String(row.champion ?? ""),
        role: normalizeRole(String(row.role ?? "MID")),
        enemy: String(row.enemy ?? ""),
        enemyRole: normalizeRole(String(row.enemy_role ?? row.role ?? "MID")),
        games: toNumber(row.games),
        winRate: clamp01(toNumber(row.win_rate, 0.5)),
      }))
      .filter(
        (row): row is CommonMatchupRow =>
          row.champion.length > 0 && row.enemy.length > 0 && row.games > 0,
      );

    let generated = 0;
    for (const row of common) {
      await this.getGuide(row.champion, row.role, row.enemy, row.enemyRole);
      generated += 1;
    }
    return generated;
  }

  async getChampionMatchups(champion: string, role: string): Promise<MatchupGuide[]> {
    const patch = await patchTracker.getCurrentPatch();
    const normalizedRole = normalizeRole(role);

    if (!process.env.DATABASE_URL) {
      return [];
    }

    const rows = await db
      .select({
        guideJson: schema.matchupGuides.guideJson,
      })
      .from(schema.matchupGuides)
      .where(
        and(
          sql`lower(${schema.matchupGuides.champion}) = lower(${champion})`,
          eq(schema.matchupGuides.role, normalizedRole),
          eq(schema.matchupGuides.patch, patch),
        ),
      )
      .orderBy(desc(schema.matchupGuides.sampleSize))
      .limit(50);

    return rows
      .map((row) => row.guideJson as MatchupGuide)
      .filter((row) => Boolean(row?.id));
  }
}

export const matchupGuideService = new MatchupGuideService();

export { matchupId };
