import { and, desc, eq } from "drizzle-orm";

import type { CompTag } from "@/lib/comp-classifier";
import { getChampionByName, getItems } from "@/lib/data-dragon";
import { db, schema } from "@/lib/db";
import { opggClient } from "@/lib/opgg-mcp";
import { getTopProBuildForChampion } from "@/lib/pro-insights";

export interface BuildRecommendation {
  coreItems: {
    itemId: number;
    itemName: string;
    reasoning: string;
  }[];
  boots: {
    itemId: number;
    itemName: string;
    reasoning: string;
  };
  situationalItems: {
    itemId: number;
    itemName: string;
    when: string;
  }[];
  overallStrategy: string;
}

export interface BuildAnalysis {
  rating: "optimal" | "suboptimal" | "poor";
  correctDecisions: string[];
  mistakes: {
    itemBuilt: string;
    shouldHaveBuilt: string;
    reasoning: string;
  }[];
  missingItems: {
    itemName: string;
    reasoning: string;
  }[];
}

type BuildArchetype = "ap" | "ad" | "tank";

type ItemReason = {
  itemId: number;
  reason: string;
};

type WeightedItem = {
  score: number;
  reasons: string[];
};

const BOOT_ITEM_IDS = new Set([3006, 3047, 3111, 3020, 3158, 3009, 3117]);

const GW_ITEMS_BY_CLASS = new Map<string, number[]>([
  ["ap", [3916, 3165]],
  ["ad", [3123, 3033, 6609]],
  ["tank", [3076, 3075]],
  ["support", [3109, 3916, 3076]],
]);

const GW_ALL_ITEMS = new Set(Array.from(new Set([...GW_ITEMS_BY_CLASS.values()].flat())));
const MR_ITEMS = new Set([3111, 3155, 3156, 3102, 4401, 3065, 2504, 8020, 6665, 3091]);
const ARMOR_ITEMS = new Set([3047, 3157, 3026, 3110, 3143, 3075, 6662, 3742]);
const DEFENSIVE_CARRY_ITEMS = new Set([3157, 3026, 6673, 3102, 3156]);
const TANK_SHREDDER_ITEMS = new Set([3135, 3036, 6694, 3153, 6653, 6692]);

function normalizeRole(role: string): string {
  const value = role.toUpperCase();
  if (value === "MIDDLE") {
    return "MID";
  }
  if (value === "UTILITY") {
    return "SUPPORT";
  }
  return value;
}

function isCarryRole(role: string): boolean {
  const normalized = normalizeRole(role);
  return normalized === "MID" || normalized === "ADC";
}

function inferArchetype(championTags: string[], role: string): BuildArchetype {
  const normalizedRole = normalizeRole(role);

  if (championTags.includes("Tank") && !championTags.includes("Mage")) {
    if (normalizedRole === "TOP" || normalizedRole === "JUNGLE" || normalizedRole === "SUPPORT") {
      return "tank";
    }
  }

  if (championTags.includes("Mage")) {
    return "ap";
  }

  if (championTags.includes("Marksman")) {
    return "ad";
  }

  if (championTags.includes("Assassin") && normalizedRole === "MID") {
    return "ap";
  }

  if (championTags.includes("Support") && normalizedRole === "SUPPORT") {
    return "ap";
  }

  return "ad";
}

function fallbackCoreByArchetype(archetype: BuildArchetype, role: string): number[] {
  const normalizedRole = normalizeRole(role);

  if (archetype === "ap") {
    return [6655, 3089, 3135];
  }

  if (archetype === "tank") {
    if (normalizedRole === "SUPPORT") {
      return [3190, 3109, 3222];
    }
    return [3068, 3075, 4401];
  }

  if (normalizedRole === "ADC") {
    return [6672, 3031, 3094];
  }

  return [6692, 3071, 3026];
}

function defaultBoots(archetype: BuildArchetype, role: string, enemyCompTags: CompTag[]): number {
  if (enemyCompTags.includes("cc_heavy") || enemyCompTags.includes("high_ap")) {
    return 3111;
  }

  if (enemyCompTags.includes("high_ad")) {
    return 3047;
  }

  const normalizedRole = normalizeRole(role);

  if (normalizedRole === "ADC") {
    return 3006;
  }

  if (archetype === "ap") {
    return 3020;
  }

  if (normalizedRole === "SUPPORT") {
    return 3117;
  }

  return 3158;
}

async function resolveItemName(itemId: number): Promise<string> {
  const items = await getItems();
  return items.get(itemId)?.name ?? `Item ${itemId}`;
}

function hasAny(items: number[], candidates: Set<number>): boolean {
  return items.some((itemId) => candidates.has(itemId));
}

type BaselineBuildRow = {
  items: number[];
  sampleSize: number;
  winRate: number;
};

async function loadBaselineBuild(params: {
  championId: number;
  role: string;
  patch?: string;
}): Promise<BaselineBuildRow | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  try {
    const conditions = [
      eq(schema.buildStats.championId, params.championId),
      eq(schema.buildStats.role, normalizeRole(params.role)),
      eq(schema.buildStats.isStale, false),
    ];

    if (params.patch) {
      conditions.push(eq(schema.buildStats.patch, params.patch));
    }

    const rows = await db
      .select({
        itemBuildPath: schema.buildStats.itemBuildPath,
        sampleSize: schema.buildStats.sampleSize,
        winRate: schema.buildStats.winRate,
      })
      .from(schema.buildStats)
      .where(and(...conditions))
      .orderBy(desc(schema.buildStats.winRate), desc(schema.buildStats.sampleSize))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    const path = rows[0].itemBuildPath;
    if (!Array.isArray(path)) {
      return null;
    }

    const items = path
      .map((item) => Number(item))
      .filter((itemId): itemId is number => Number.isFinite(itemId) && itemId > 0);

    return {
      items,
      sampleSize: rows[0].sampleSize ?? 0,
      winRate: Number(rows[0].winRate ?? 0),
    };
  } catch (error) {
    console.error("[BuildAnalyzer] Failed to load baseline build:", error);
    return null;
  }
}

function upsertCore(core: ItemReason[], entry: ItemReason, atStart = false) {
  const existingIndex = core.findIndex((candidate) => candidate.itemId === entry.itemId);
  if (existingIndex >= 0) {
    core[existingIndex] = entry;
    return;
  }

  if (atStart) {
    core.unshift(entry);
    return;
  }

  core.push(entry);
}

function upsertSituational(
  situational: Array<{ itemId: number; when: string }>,
  itemId: number,
  when: string,
) {
  const existingIndex = situational.findIndex((entry) => entry.itemId === itemId);
  if (existingIndex >= 0) {
    situational[existingIndex] = { itemId, when };
    return;
  }

  situational.push({ itemId, when });
}

function substituteSatisfied(recommendedItemId: number, builtItems: number[]): boolean {
  if (builtItems.includes(recommendedItemId)) {
    return true;
  }

  if (GW_ALL_ITEMS.has(recommendedItemId)) {
    return hasAny(builtItems, GW_ALL_ITEMS);
  }

  if (MR_ITEMS.has(recommendedItemId)) {
    return hasAny(builtItems, MR_ITEMS);
  }

  if (ARMOR_ITEMS.has(recommendedItemId)) {
    return hasAny(builtItems, ARMOR_ITEMS);
  }

  if (TANK_SHREDDER_ITEMS.has(recommendedItemId)) {
    return hasAny(builtItems, TANK_SHREDDER_ITEMS);
  }

  return false;
}

function addWeightedItem(
  weights: Map<number, WeightedItem>,
  itemId: number,
  score: number,
  reason: string,
) {
  const existing = weights.get(itemId) ?? {
    score: 0,
    reasons: [],
  };

  existing.score += score;
  if (!existing.reasons.includes(reason)) {
    existing.reasons.push(reason);
  }

  weights.set(itemId, existing);
}

export async function getOptimalBuild(params: {
  championName: string;
  role: string;
  allyCompTags: CompTag[];
  enemyCompTags: CompTag[];
  patch?: string;
}): Promise<BuildRecommendation> {
  const champion = await getChampionByName(params.championName);
  const championId = Number(champion?.key ?? 0);
  const championTags = champion?.tags ?? [];
  const role = normalizeRole(params.role);
  const archetype = inferArchetype(championTags, role);

  const [baselineFromDb, proReference, opggMeta] = await Promise.all([
    championId
      ? loadBaselineBuild({
          championId,
          role,
          patch: params.patch,
        })
      : Promise.resolve(null),
    getTopProBuildForChampion({
      champion: params.championName,
      role,
      patch: params.patch,
      recentGames: 300,
    }),
    opggClient.getChampionMeta(params.championName, role).catch((error) => {
      console.warn("[BuildAnalyzer] OP.GG meta unavailable:", error);
      return null;
    }),
  ]);

  const baseline =
    baselineFromDb?.sampleSize && baselineFromDb.sampleSize > 100
      ? baselineFromDb.items
      : [];

  const opggCore = opggMeta?.builds.items.coreItems ?? [];
  const opggBoots = opggMeta?.builds.items.boots ?? 0;
  const opggFallbackCore = opggCore.filter((itemId) => itemId > 0 && !BOOT_ITEM_IDS.has(itemId));

  const baselineWithoutBoots = baseline.filter((itemId) => !BOOT_ITEM_IDS.has(itemId));
  const baselineBoots = baseline.find((itemId) => BOOT_ITEM_IDS.has(itemId));

  const weightedCore = new Map<number, WeightedItem>();
  const baselineCandidates =
    baselineWithoutBoots.length > 0
      ? baselineWithoutBoots.slice(0, 4)
      : opggFallbackCore.length > 0
        ? opggFallbackCore.slice(0, 4)
      : fallbackCoreByArchetype(archetype, role);

  baselineCandidates.forEach((itemId, index) => {
    const isDbDriven = baselineWithoutBoots.length > 0;
    addWeightedItem(
      weightedCore,
      itemId,
      Math.max(1, 4 - index) * (isDbDriven ? 1.2 : 1),
      isDbDriven
        ? "Baseline high-win solo queue item from WinCon collected data."
        : "Baseline high-win OP.GG meta item for this champion and role.",
    );
  });

  if (opggFallbackCore.length > 0 && baselineWithoutBoots.length > 0) {
    opggFallbackCore.slice(0, 4).forEach((itemId, index) => {
      addWeightedItem(
        weightedCore,
        itemId,
        Math.max(1, 3 - index),
        "Supported by OP.GG current patch trend data.",
      );
    });
  }

  if (proReference && proReference.games >= 8) {
    proReference.buildPath
      .filter((itemId) => !BOOT_ITEM_IDS.has(itemId))
      .slice(0, 4)
      .forEach((itemId, index) => {
        const proScore = Math.max(1, 3 - index) * (0.8 + proReference.winRate);
        addWeightedItem(
          weightedCore,
          itemId,
          proScore,
          `Backed by pro play trend (${Math.round(proReference.winRate * 100)}% WR across ${proReference.games} games).`,
        );
      });
  }

  const coreItems: ItemReason[] = Array.from(weightedCore.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 4)
    .map(([itemId, details]) => ({
      itemId,
      reason: details.reasons[0] ?? "Recommended core item for this matchup.",
    }));

  const situationalItems: Array<{ itemId: number; when: string }> = [];
  const strategyNotes: string[] = [];

  if (baselineFromDb?.sampleSize && baselineFromDb.sampleSize > 100) {
    strategyNotes.push(
      `Primary build path from WinCon data (${baselineFromDb.sampleSize} games, ${Math.round(
        baselineFromDb.winRate * 100,
      )}% WR).`,
    );
  } else if (opggMeta) {
    strategyNotes.push(
      `Primary build path from OP.GG (${Math.round(opggMeta.winRate * 100)}% WR, ${
        opggMeta.sampleSize
      } games this patch).`,
    );
  }

  if (proReference && proReference.games >= 8) {
    strategyNotes.push(
      `Pro reference weighted in: ${Math.round(proReference.winRate * 100)}% WR on ${params.championName} (${proReference.games} games).`,
    );
  }

  let bootsItemId =
    baselineBoots ?? (opggBoots > 0 ? opggBoots : defaultBoots(archetype, role, params.enemyCompTags));
  let bootsReasoning =
    "Default boots for this champion and role in neutral matchups.";

  if (params.enemyCompTags.includes("healing_heavy")) {
    const gwItemsByClass = getGrievousWoundsItems();
    const classKey =
      archetype === "tank" ? "tank" : archetype === "ap" ? "ap" : "ad";
    const gwItemId = gwItemsByClass.get(classKey)?.[0];

    if (gwItemId) {
      upsertCore(
        coreItems,
        {
          itemId: gwItemId,
          reason: "Enemy comp is healing-heavy, so anti-heal is mandatory.",
        },
        true,
      );
      strategyNotes.push(
        "Enemy has heavy sustain, so your build must include Grievous Wounds early.",
      );
    }
  }

  if (params.enemyCompTags.includes("high_ap")) {
    const mrItem = archetype === "tank" ? 4401 : role === "ADC" ? 3156 : 3102;
    upsertSituational(
      situationalItems,
      mrItem,
      "Build early if enemy AP threats are fed or team has stacked magic damage.",
    );
    bootsItemId = 3111;
    bootsReasoning =
      "Enemy comp is AP-heavy, so Mercury's Treads improve survivability and tenacity.";
    strategyNotes.push("Against AP-heavy teams, prioritize Magic Resist timing.");
  }

  if (params.enemyCompTags.includes("high_ad")) {
    const armorItem = archetype === "tank" ? 3143 : role === "ADC" ? 3026 : 3157;
    upsertSituational(
      situationalItems,
      armorItem,
      "Buy when enemy physical damage carries are strongest in fights.",
    );
    if (!params.enemyCompTags.includes("high_ap")) {
      bootsItemId = 3047;
      bootsReasoning =
        "Enemy comp is AD-heavy, so Plated Steelcaps reduce incoming physical damage.";
    }
    strategyNotes.push("Against AD-heavy teams, add armor before third major spike.");
  }

  if (params.enemyCompTags.includes("assassin_heavy") && isCarryRole(role)) {
    const safetyItem = archetype === "ap" ? 3157 : 3026;
    upsertSituational(
      situationalItems,
      safetyItem,
      "Rush after first damage item if assassins are getting picks.",
    );
    strategyNotes.push(
      "Enemy has strong dive/assassin pressure, so include a defensive self-peel item.",
    );
  }

  if (params.enemyCompTags.includes("cc_heavy")) {
    bootsItemId = 3111;
    bootsReasoning =
      "High crowd control threat makes tenacity from Mercury's Treads high value.";
    upsertSituational(
      situationalItems,
      3139,
      "Build QSS path if repeated CC is deciding fights.",
    );
  }

  if (params.enemyCompTags.includes("tank_heavy")) {
    const shredItem = archetype === "ap" ? 3135 : role === "ADC" ? 3036 : 6694;
    upsertSituational(
      situationalItems,
      shredItem,
      "Take this when frontliners are surviving your normal combo/rotation.",
    );
    strategyNotes.push(
      "Enemy frontline is durable, so percent-health or penetration items are required.",
    );
  }

  if (params.allyCompTags.includes("engage_comp") && isCarryRole(role)) {
    const damageItem = archetype === "ap" ? 3089 : 3031;
    upsertSituational(
      situationalItems,
      damageItem,
      "Your team provides engage, so this amplifies follow-up burst.",
    );
    strategyNotes.push(
      "Your team has reliable engage, so convert setup into higher damage spikes.",
    );
  }

  if (params.allyCompTags.includes("peel_heavy") && isCarryRole(role)) {
    const greedItem = archetype === "ap" ? 4628 : 3094;
    upsertSituational(
      situationalItems,
      greedItem,
      "When your team can peel effectively, optimize for sustained damage output.",
    );
    strategyNotes.push(
      "Ally peel tools let you play greedier damage curves in front-to-back fights.",
    );
  }

  if (params.allyCompTags.includes("split_push") && role === "TOP") {
    upsertSituational(
      situationalItems,
      3181,
      "If side-lane pressure is your team's main map win condition.",
    );
    strategyNotes.push("Your comp can leverage side-lane pressure, so split-push tools gain value.");
  }

  if (!params.allyCompTags.includes("tank_heavy") && (role === "TOP" || role === "JUNGLE")) {
    upsertSituational(
      situationalItems,
      3742,
      "When your team lacks frontline and you need to absorb first engage.",
    );
    strategyNotes.push("Your team has limited frontline, so your build should be slightly tankier.");
  }

  const bootsName = await resolveItemName(bootsItemId);
  const resolvedCore = await Promise.all(
    coreItems.slice(0, 4).map(async (entry) => ({
      itemId: entry.itemId,
      itemName: await resolveItemName(entry.itemId),
      reasoning: entry.reason,
    })),
  );
  const resolvedSituational = await Promise.all(
    situationalItems.slice(0, 6).map(async (entry) => ({
      itemId: entry.itemId,
      itemName: await resolveItemName(entry.itemId),
      when: entry.when,
    })),
  );

  const overallStrategy =
    strategyNotes.length > 0
      ? strategyNotes.join(" ")
      : "Standard scaling build is acceptable here; adapt only to fed threats.";

  return {
    coreItems: resolvedCore,
    boots: {
      itemId: bootsItemId,
      itemName: bootsName,
      reasoning: bootsReasoning,
    },
    situationalItems: resolvedSituational,
    overallStrategy,
  };
}

export function analyzeBuildDecisions(params: {
  playerItems: number[];
  optimalBuild: BuildRecommendation;
  allyCompTags: CompTag[];
  enemyCompTags: CompTag[];
}): BuildAnalysis {
  const builtItems = params.playerItems.filter((itemId) => itemId > 0);
  const mistakes: BuildAnalysis["mistakes"] = [];
  const missingItems: BuildAnalysis["missingItems"] = [];
  const correctDecisions: string[] = [];

  for (const coreItem of params.optimalBuild.coreItems) {
    if (substituteSatisfied(coreItem.itemId, builtItems)) {
      correctDecisions.push(`${coreItem.itemName} (or a valid substitute) matched matchup needs.`);
    } else {
      mistakes.push({
        itemBuilt: builtItems[0] ? `Item ${builtItems[0]}` : "No comparable item",
        shouldHaveBuilt: coreItem.itemName,
        reasoning: coreItem.reasoning,
      });
    }
  }

  if (substituteSatisfied(params.optimalBuild.boots.itemId, builtItems)) {
    correctDecisions.push(`Boot choice was aligned with threat profile.`);
  } else {
    mistakes.push({
      itemBuilt: "Boot slot",
      shouldHaveBuilt: params.optimalBuild.boots.itemName,
      reasoning: params.optimalBuild.boots.reasoning,
    });
  }

  if (params.enemyCompTags.includes("healing_heavy") && !hasAny(builtItems, GW_ALL_ITEMS)) {
    missingItems.push({
      itemName: "Grievous Wounds item",
      reasoning: "Enemy sustain was high; anti-heal was required to win extended fights.",
    });
  }

  if (params.enemyCompTags.includes("high_ap") && !hasAny(builtItems, MR_ITEMS)) {
    missingItems.push({
      itemName: "Magic Resist item",
      reasoning: "Enemy damage profile was AP-heavy and needed MR adaptation.",
    });
  }

  if (params.enemyCompTags.includes("high_ad") && !hasAny(builtItems, ARMOR_ITEMS)) {
    missingItems.push({
      itemName: "Armor item",
      reasoning: "Enemy physical damage was high and required armor timing.",
    });
  }

  if (params.enemyCompTags.includes("assassin_heavy") && !hasAny(builtItems, DEFENSIVE_CARRY_ITEMS)) {
    missingItems.push({
      itemName: "Defensive anti-burst item",
      reasoning: "Assassin-heavy enemy comp made a defensive carry option important.",
    });
  }

  if (params.enemyCompTags.includes("tank_heavy") && !hasAny(builtItems, TANK_SHREDDER_ITEMS)) {
    missingItems.push({
      itemName: "Tank shred / penetration item",
      reasoning: "Enemy frontline required penetration or percent-health damage.",
    });
  }

  const issueCount = mistakes.length + missingItems.length;
  const rating: BuildAnalysis["rating"] =
    issueCount <= 1 ? "optimal" : issueCount <= 3 ? "suboptimal" : "poor";

  return {
    rating,
    correctDecisions,
    mistakes,
    missingItems,
  };
}

export function getGrievousWoundsItems(): Map<string, number[]> {
  return new Map(GW_ITEMS_BY_CLASS);
}

export function getAntiHealingCheck(items: number[], championTags: string[]): boolean {
  const normalizedTags = championTags.map((tag) => tag.toLowerCase());
  const classKey = normalizedTags.includes("tank")
    ? "tank"
    : normalizedTags.includes("mage") || normalizedTags.includes("support")
      ? "ap"
      : "ad";

  const classItems = getGrievousWoundsItems().get(classKey) ?? [];
  const classSet = new Set(classItems);

  return hasAny(items, classSet) || hasAny(items, GW_ALL_ITEMS);
}
