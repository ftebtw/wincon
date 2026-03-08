import threatMapData from "@/data/item-threat-map.json";
import { getChampionByName, getItems } from "@/lib/data-dragon";
import { opggClient } from "@/lib/opgg-mcp";

export interface GameContext {
  playerChampion: string;
  playerRole: string;
  playerClass: string;
  allies: string[];
  enemies: string[];
}

export interface ThreatAssessment {
  threatType: string;
  severity: "critical" | "high" | "medium" | "low";
  sourceChampions: string[];
  counterItems: {
    item: string;
    itemId?: number;
    priority: string;
    reason: string;
    buildSlot: "rush" | "core" | "3rd" | "4th" | "situational";
  }[];
}

export interface AllyAssessment {
  synergyType: string;
  effect: string;
  itemAdjustment:
    | "skip_defensive"
    | "force_defensive"
    | "more_damage"
    | "more_utility";
  details: string;
}

export interface ContextualBuildRecommendation {
  build: {
    boots: { item: string; itemId?: number; reason: string };
    items: {
      slot: number;
      item: string;
      itemId?: number;
      reason: string;
      isContextual: boolean;
    }[];
  };
  genericBuild: string[];
  genericBuildItemIds: number[];
  deviations: {
    genericItem: string;
    contextualItem: string;
    reason: string;
  }[];
  threats: ThreatAssessment[];
  allySynergies: AllyAssessment[];
  buildOrder: {
    phase: "early" | "mid" | "late";
    instruction: string;
  }[];
}

type ThreatCounterItem = {
  item: string;
  priority: "critical" | "high" | "medium" | "low";
  reason: string;
  condition?: string;
  rush_if?: string;
};

type ThreatData = {
  description: string;
  champions?: string[];
  champions_condition?: string;
  counter_items_by_class: Record<string, ThreatCounterItem[]>;
  timing_note?: string;
  boot_recommendation?: string;
};

type ThreatMap = {
  threats: Record<string, ThreatData>;
  ally_synergies: {
    team_has_heavy_peel: {
      champions: string[];
      effect_on_carry: {
        recommendation: string;
        skip_items?: string[];
        prefer_items?: string[];
      };
    };
    team_has_no_frontline: {
      effect_on_carry: {
        recommendation: string;
        force_items?: string[];
      };
    };
    team_has_engage: {
      effect_on_carry: {
        recommendation: string;
        prefer_items?: string[];
      };
    };
  };
};

type ItemNeed = {
  item: string;
  itemId?: number;
  reason: string;
  priority: "critical" | "high" | "medium" | "low";
  buildSlot: "rush" | "core" | "3rd" | "4th" | "situational";
  threatType: string;
  severity: "critical" | "high" | "medium" | "low";
  sourceChampions: string[];
};

const threatMap = threatMapData as ThreatMap;

const AP_ASSASSINS = new Set([
  "Akali",
  "Diana",
  "Ekko",
  "Evelynn",
  "Fizz",
  "Kassadin",
  "Katarina",
  "LeBlanc",
]);
const AD_ASSASSINS = new Set([
  "Zed",
  "Talon",
  "Qiyana",
  "Naafiri",
  "Rengar",
  "Kha'Zix",
  "Pyke",
  "Shaco",
]);
const ENGAGE_CHAMPIONS = new Set([
  "Malphite",
  "Ornn",
  "Leona",
  "Nautilus",
  "Amumu",
  "Sejuani",
  "Rakan",
  "Rell",
  "Alistar",
]);
const DEFENSIVE_ITEMS = new Set([
  "Guardian Angel",
  "Immortal Shieldbow",
  "Bloodthirster",
  "Zhonya's Hourglass",
  "Banshee's Veil",
  "Mercurial Scimitar",
  "Maw of Malmortius",
  "Wit's End",
  "Locket of the Iron Solari",
]);

const ITEM_NAME_ALIASES: Record<string, string> = {
  liandrystorment: "Liandry's Anguish",
  liandrystormentitem: "Liandry's Anguish",
  lorddominiksregards: "Lord Dominik's Regards",
  mercurytreads: "Mercury's Treads",
  zhonyashourglass: "Zhonya's Hourglass",
};

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function severityScore(value: "critical" | "high" | "medium" | "low"): number {
  if (value === "critical") return 4;
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

function priorityScore(value: "critical" | "high" | "medium" | "low"): number {
  return severityScore(value);
}

function roleToClass(role: string): string {
  const normalized = role.toUpperCase();
  if (normalized === "ADC") return "ADC";
  if (normalized === "SUPPORT") return "Support";
  if (normalized === "MID") return "Mage";
  if (normalized === "JUNGLE") return "Fighter";
  return "Fighter";
}

export async function getChampionClass(championName: string): Promise<string> {
  const champion = await getChampionByName(championName);
  const tags = champion?.tags ?? [];
  if (tags.includes("Marksman")) return "ADC";
  if (tags.includes("Tank")) return "Tank";
  if (tags.includes("Assassin")) return "Assassin";
  if (tags.includes("Support")) return "Support";
  if (tags.includes("Mage")) return "Mage";
  if (tags.includes("Fighter")) return "Fighter";
  return "Fighter";
}

async function resolveItemNameById(itemId: number): Promise<string> {
  const items = await getItems();
  return items.get(itemId)?.name ?? `Item ${itemId}`;
}

async function resolveItemIdByName(itemName: string): Promise<number | undefined> {
  const normalizedInput = normalizeText(itemName);
  const aliasTarget = ITEM_NAME_ALIASES[normalizedInput];
  const normalizedTarget = normalizeText(aliasTarget ?? itemName);
  const items = await getItems();

  for (const [id, item] of items.entries()) {
    if (normalizeText(item.name) === normalizedTarget) {
      return id;
    }
  }

  for (const [id, item] of items.entries()) {
    const normalized = normalizeText(item.name);
    if (
      normalized.includes(normalizedTarget) ||
      normalizedTarget.includes(normalized)
    ) {
      return id;
    }
  }

  return undefined;
}

async function countDamageType(
  champions: string[],
  type: "AP" | "AD",
): Promise<{ count: number; champions: string[] }> {
  let count = 0;
  const matching: string[] = [];
  for (const championName of champions) {
    const champ = await getChampionByName(championName);
    const tags = champ?.tags ?? [];
    const normalized = championName.trim();

    let damageType: "AP" | "AD" | "Mixed" = "Mixed";
    if (AP_ASSASSINS.has(normalized) || tags.includes("Mage")) {
      damageType = "AP";
    } else if (AD_ASSASSINS.has(normalized) || tags.includes("Marksman")) {
      damageType = "AD";
    } else if (tags.includes("Assassin") || tags.includes("Fighter")) {
      damageType = "AD";
    } else if (tags.includes("Support")) {
      damageType = "AP";
    }

    if (damageType === type) {
      count += 1;
      matching.push(normalized);
    }
  }
  return { count, champions: matching };
}

function evaluateCondition(condition: string | undefined, matchingCount: number): boolean {
  if (!condition) return true;
  const normalized = condition.toLowerCase();
  if (normalized.includes("2+ shield")) return matchingCount >= 2;
  if (normalized.includes("2+ tanks")) return matchingCount >= 2;
  if (normalized.includes("any shield")) return matchingCount >= 1;
  if (normalized.includes("3+ hard cc")) return matchingCount >= 3;
  return true;
}

function determineBuildSlot(params: {
  threatType: string;
  severity: "critical" | "high" | "medium" | "low";
  item: ThreatCounterItem;
  matchingCount: number;
}): "rush" | "core" | "3rd" | "4th" | "situational" {
  const { threatType, severity, item, matchingCount } = params;
  if (item.rush_if && matchingCount >= 2) return "rush";
  if (threatType === "heavy_healing" && matchingCount >= 2) return "rush";
  if (severity === "critical" || item.priority === "critical") return "3rd";
  if (severity === "high" || item.priority === "high") return "core";
  if (item.priority === "medium") return "4th";
  return "situational";
}

export class ContextualBuildEngine {
  async generateBuild(context: GameContext): Promise<ContextualBuildRecommendation> {
    const normalizedRole = context.playerRole.toUpperCase();
    const inferredClass = context.playerClass || roleToClass(normalizedRole);
    const playerClass = inferredClass;

    const opggMeta = await opggClient
      .getChampionMeta(context.playerChampion, normalizedRole)
      .catch(() => null);

    const genericBuildItemIds = [
      ...(opggMeta?.builds.items.coreItems ?? []),
      ...(opggMeta?.builds.items.fourthItem ?? []),
      ...(opggMeta?.builds.items.fifthItem ?? []),
      ...(opggMeta?.builds.items.sixthItem ?? []),
    ]
      .filter((itemId) => itemId > 0)
      .filter((itemId, index, list) => list.indexOf(itemId) === index)
      .slice(0, 6);

    const genericBuild = await Promise.all(
      genericBuildItemIds.map((itemId) => resolveItemNameById(itemId)),
    );

    const threats = await this.assessThreats(context.enemies, playerClass);
    const allySynergies = await this.assessAllySynergies(
      context.allies,
      normalizedRole,
    );
    const requiredCounterItems = this.prioritizeCounterItems(
      threats,
      allySynergies,
      playerClass,
    );

    const build = await this.constructBuild({
      genericBuildItemIds,
      genericBuild,
      requiredCounterItems,
      allySynergies,
      context,
      opggBootId: opggMeta?.builds.items.boots,
    });
    const deviations = this.identifyDeviations(genericBuild, build.items);
    const buildOrder = this.generateBuildOrder(build, threats);

    return {
      build,
      genericBuild,
      genericBuildItemIds,
      deviations,
      threats,
      allySynergies,
      buildOrder,
    };
  }

  private async assessThreats(
    enemies: string[],
    playerClass: string,
  ): Promise<ThreatAssessment[]> {
    const normalizedEnemies = enemies.filter(Boolean);
    const threatResults: ThreatAssessment[] = [];

    for (const [threatType, threatData] of Object.entries(threatMap.threats)) {
      if (threatType === "heavy_ap_damage" || threatType === "heavy_ad_damage") {
        continue;
      }

      const candidates = threatData.champions ?? [];
      const matchingEnemies = normalizedEnemies.filter((enemy) =>
        candidates.some(
          (candidate) => normalizeText(candidate) === normalizeText(enemy),
        ),
      );

      if (matchingEnemies.length === 0) {
        continue;
      }

      const severity: ThreatAssessment["severity"] =
        matchingEnemies.length >= 3
          ? "critical"
          : matchingEnemies.length >= 2
            ? "high"
            : "medium";
      const counterItems = await this.mapCounterItems({
        threatType,
        threatData,
        playerClass,
        severity,
        sourceChampions: matchingEnemies,
      });

      if (counterItems.length === 0) {
        continue;
      }

      threatResults.push({
        threatType,
        severity,
        sourceChampions: matchingEnemies,
        counterItems,
      });
    }

    const apDamage = await countDamageType(normalizedEnemies, "AP");
    if (apDamage.count >= 3) {
      const threatData = threatMap.threats.heavy_ap_damage;
      const counterItems = await this.mapCounterItems({
        threatType: "heavy_ap_damage",
        threatData,
        playerClass,
        severity: apDamage.count >= 4 ? "critical" : "high",
        sourceChampions: apDamage.champions,
      });
      threatResults.push({
        threatType: "heavy_ap_damage",
        severity: apDamage.count >= 4 ? "critical" : "high",
        sourceChampions: apDamage.champions,
        counterItems,
      });
    }

    const adDamage = await countDamageType(normalizedEnemies, "AD");
    if (adDamage.count >= 3) {
      const threatData = threatMap.threats.heavy_ad_damage;
      const counterItems = await this.mapCounterItems({
        threatType: "heavy_ad_damage",
        threatData,
        playerClass,
        severity: adDamage.count >= 4 ? "critical" : "high",
        sourceChampions: adDamage.champions,
      });
      threatResults.push({
        threatType: "heavy_ad_damage",
        severity: adDamage.count >= 4 ? "critical" : "high",
        sourceChampions: adDamage.champions,
        counterItems,
      });
    }

    return threatResults.sort(
      (a, b) => severityScore(b.severity) - severityScore(a.severity),
    );
  }

  private async mapCounterItems(params: {
    threatType: string;
    threatData: ThreatData;
    playerClass: string;
    severity: ThreatAssessment["severity"];
    sourceChampions: string[];
  }): Promise<ThreatAssessment["counterItems"]> {
    const classCandidates = [
      params.playerClass,
      params.playerClass.toUpperCase(),
      params.playerClass.toLowerCase(),
      "ALL",
    ];

    const lookup =
      classCandidates
        .map((key) => params.threatData.counter_items_by_class[key])
        .find((entry) => Array.isArray(entry)) ?? [];

    const resolved: ThreatAssessment["counterItems"] = [];
    for (const item of lookup) {
      if (!evaluateCondition(item.condition, params.sourceChampions.length)) {
        continue;
      }

      resolved.push({
        item: item.item,
        itemId: await resolveItemIdByName(item.item),
        priority: item.priority,
        reason: item.reason,
        buildSlot: determineBuildSlot({
          threatType: params.threatType,
          severity: params.severity,
          item,
          matchingCount: params.sourceChampions.length,
        }),
      });
    }

    return resolved;
  }

  private async assessAllySynergies(
    allies: string[],
    playerRole: string,
  ): Promise<AllyAssessment[]> {
    const synergies: AllyAssessment[] = [];
    const normalizedAllies = allies.filter(Boolean);

    const peelChamps = normalizedAllies.filter((ally) =>
      threatMap.ally_synergies.team_has_heavy_peel.champions.some(
        (champion) => normalizeText(champion) === normalizeText(ally),
      ),
    );
    if (peelChamps.length >= 2 && (playerRole === "ADC" || playerRole === "MID")) {
      synergies.push({
        synergyType: "team_has_heavy_peel",
        effect:
          threatMap.ally_synergies.team_has_heavy_peel.effect_on_carry.recommendation,
        itemAdjustment: "skip_defensive",
        details: `${peelChamps.join(", ")} provide peel coverage for carries.`,
      });
    }

    const frontlineCount = (
      await Promise.all(
        normalizedAllies.map(async (ally) => {
          const champion = await getChampionByName(ally);
          const tags = champion?.tags ?? [];
          return Number(tags.includes("Tank") || tags.includes("Fighter"));
        }),
      )
    ).reduce((sum, value) => sum + value, 0);
    if (frontlineCount === 0 && (playerRole === "ADC" || playerRole === "MID")) {
      synergies.push({
        synergyType: "team_has_no_frontline",
        effect:
          threatMap.ally_synergies.team_has_no_frontline.effect_on_carry
            .recommendation,
        itemAdjustment: "force_defensive",
        details: "No frontline detected on ally team.",
      });
    }

    const engageChamps = normalizedAllies.filter((ally) => ENGAGE_CHAMPIONS.has(ally));
    if (engageChamps.length >= 1 && (playerRole === "ADC" || playerRole === "MID")) {
      synergies.push({
        synergyType: "team_has_engage",
        effect: threatMap.ally_synergies.team_has_engage.effect_on_carry.recommendation,
        itemAdjustment: "more_damage",
        details: `${engageChamps.join(", ")} can reliably start fights.`,
      });
    }

    return synergies;
  }

  private prioritizeCounterItems(
    threats: ThreatAssessment[],
    allySynergies: AllyAssessment[],
    playerClass: string,
  ): ItemNeed[] {
    const hasSkipDefensive = allySynergies.some(
      (synergy) => synergy.itemAdjustment === "skip_defensive",
    );
    const criticalAssassinThreat = threats.some(
      (threat) =>
        threat.threatType === "burst_assassin" &&
        (threat.severity === "critical" || threat.severity === "high"),
    );

    const needs: ItemNeed[] = [];
    for (const threat of threats) {
      for (const item of threat.counterItems) {
        const isDefensive = DEFENSIVE_ITEMS.has(item.item);
        if (hasSkipDefensive && isDefensive && !criticalAssassinThreat) {
          continue;
        }

        needs.push({
          item: item.item,
          itemId: item.itemId,
          reason: item.reason,
          priority: (item.priority as ItemNeed["priority"]) ?? "medium",
          buildSlot: item.buildSlot,
          threatType: threat.threatType,
          severity: threat.severity,
          sourceChampions: threat.sourceChampions,
        });
      }
    }

    if (
      allySynergies.some((synergy) => synergy.itemAdjustment === "force_defensive") &&
      (playerClass === "ADC" || playerClass === "Mage")
    ) {
      needs.push({
        item: playerClass === "Mage" ? "Zhonya's Hourglass" : "Guardian Angel",
        reason: "No frontline detected, so one defensive slot is required.",
        priority: "high",
        buildSlot: "4th",
        threatType: "team_has_no_frontline",
        severity: "high",
        sourceChampions: [],
      });
    }

    const byItem = new Map<string, ItemNeed>();
    for (const need of needs) {
      const key = normalizeText(need.item);
      const existing = byItem.get(key);
      if (!existing) {
        byItem.set(key, need);
        continue;
      }
      const existingScore =
        severityScore(existing.severity) * 10 + priorityScore(existing.priority);
      const nextScore =
        severityScore(need.severity) * 10 + priorityScore(need.priority);
      if (nextScore > existingScore) {
        byItem.set(key, need);
      }
    }

    return [...byItem.values()].sort((a, b) => {
      const left = severityScore(b.severity) * 10 + priorityScore(b.priority);
      const right = severityScore(a.severity) * 10 + priorityScore(a.priority);
      return left - right;
    });
  }

  private async constructBuild(params: {
    genericBuildItemIds: number[];
    genericBuild: string[];
    requiredCounterItems: ItemNeed[];
    allySynergies: AllyAssessment[];
    context: GameContext;
    opggBootId?: number;
  }): Promise<ContextualBuildRecommendation["build"]> {
    const fallbackNamesByClass: Record<string, string[]> = {
      ADC: [
        "Infinity Edge",
        "Runaan's Hurricane",
        "Lord Dominik's Regards",
        "Guardian Angel",
      ],
      Mage: ["Rabadon's Deathcap", "Void Staff", "Zhonya's Hourglass"],
      Fighter: ["Black Cleaver", "Death's Dance", "Sterak's Gage"],
      Tank: ["Sunfire Aegis", "Thornmail", "Force of Nature"],
      Support: ["Locket of the Iron Solari", "Redemption", "Mikael's Blessing"],
      Assassin: ["Edge of Night", "Serylda's Grudge", "Serpent's Fang"],
    };

    const classFallback =
      fallbackNamesByClass[params.context.playerClass] ??
      fallbackNamesByClass.Fighter;
    const classFallbackIds = (
      await Promise.all(classFallback.map((item) => resolveItemIdByName(item)))
    ).filter((value): value is number => typeof value === "number");

    const genericIds = [...params.genericBuildItemIds];
    for (const id of classFallbackIds) {
      if (!genericIds.includes(id)) {
        genericIds.push(id);
      }
      if (genericIds.length >= 6) {
        break;
      }
    }

    const finalIds = genericIds.slice(0, 6);
    while (finalIds.length < 6 && classFallbackIds.length > 0) {
      const next = classFallbackIds[finalIds.length % classFallbackIds.length];
      if (!finalIds.includes(next)) {
        finalIds.push(next);
      } else {
        break;
      }
    }

    const reasonByItem = new Map<number, string>();
    const contextualItemSet = new Set<number>();

    for (const need of params.requiredCounterItems) {
      const itemId = need.itemId ?? (await resolveItemIdByName(need.item));
      if (!itemId) {
        continue;
      }
      if (finalIds.includes(itemId)) {
        contextualItemSet.add(itemId);
        reasonByItem.set(
          itemId,
          `${need.reason} (threat: ${need.threatType}${need.sourceChampions.length > 0 ? ` from ${need.sourceChampions.join(", ")}` : ""})`,
        );
        continue;
      }

      const preferredIndex =
        need.buildSlot === "rush" || need.buildSlot === "core" || need.buildSlot === "3rd"
          ? 2
          : need.buildSlot === "4th"
            ? 3
            : 4;
      const targetIndex = Math.max(2, Math.min(5, preferredIndex));
      finalIds[targetIndex] = itemId;
      contextualItemSet.add(itemId);
      reasonByItem.set(
        itemId,
        `${need.reason} (threat: ${need.threatType}${need.sourceChampions.length > 0 ? ` from ${need.sourceChampions.join(", ")}` : ""})`,
      );
    }

    const bootRecommendation = await this.recommendBoots({
      threats: params.requiredCounterItems,
      opggBootId: params.opggBootId,
      enemies: params.context.enemies,
    });

    const items = await Promise.all(
      finalIds.slice(0, 6).map(async (itemId, index) => {
        const itemName = await resolveItemNameById(itemId);
        return {
          slot: index + 1,
          item: itemName,
          itemId,
          reason:
            reasonByItem.get(itemId) ??
            (index < 2
              ? "Core baseline item from OP.GG."
              : "Baseline scaling item unless a higher-priority threat demands a swap."),
          isContextual: contextualItemSet.has(itemId),
        };
      }),
    );

    return {
      boots: bootRecommendation,
      items,
    };
  }

  private async recommendBoots(params: {
    threats: ItemNeed[];
    opggBootId?: number;
    enemies: string[];
  }): Promise<{ item: string; itemId?: number; reason: string }> {
    const hasHeavyCc = params.threats.some((entry) => entry.threatType === "heavy_cc");
    const hasHeavyAp = params.threats.some(
      (entry) => entry.threatType === "heavy_ap_damage",
    );
    const hasHeavyAd = params.threats.some(
      (entry) => entry.threatType === "heavy_ad_damage",
    );
    const assassinThreats = params.threats.filter(
      (entry) => entry.threatType === "burst_assassin",
    );
    const apAssassinThreat = assassinThreats.some((entry) =>
      entry.sourceChampions.some((champion) => AP_ASSASSINS.has(champion)),
    );
    const adAssassinThreat = assassinThreats.some((entry) =>
      entry.sourceChampions.some((champion) => AD_ASSASSINS.has(champion)),
    );

    if (hasHeavyCc || hasHeavyAp || apAssassinThreat) {
      const id = await resolveItemIdByName("Mercury's Treads");
      return {
        item: "Mercury's Treads",
        itemId: id,
        reason:
          "Enemy comp has high CC or AP burst, so tenacity + MR boots outperform default options.",
      };
    }

    if (hasHeavyAd || adAssassinThreat) {
      const id = await resolveItemIdByName("Plated Steelcaps");
      return {
        item: "Plated Steelcaps",
        itemId: id,
        reason:
          "Enemy comp is AD/auto-attack heavy, so armor boots reduce incoming physical damage.",
      };
    }

    if (params.opggBootId && params.opggBootId > 0) {
      return {
        item: await resolveItemNameById(params.opggBootId),
        itemId: params.opggBootId,
        reason: "No extreme threat profile detected, so default OP.GG boots remain optimal.",
      };
    }

    const fallbackId = await resolveItemIdByName("Berserker's Greaves");
    return {
      item: "Berserker's Greaves",
      itemId: fallbackId,
      reason: "Default DPS boot fallback.",
    };
  }

  private identifyDeviations(
    genericBuild: string[],
    contextualItems: ContextualBuildRecommendation["build"]["items"],
  ): ContextualBuildRecommendation["deviations"] {
    const deviations: ContextualBuildRecommendation["deviations"] = [];
    const max = Math.max(genericBuild.length, contextualItems.length);

    for (let index = 0; index < max; index += 1) {
      const genericItem = genericBuild[index];
      const contextualItem = contextualItems[index]?.item;
      if (!genericItem || !contextualItem) {
        continue;
      }
      if (normalizeText(genericItem) === normalizeText(contextualItem)) {
        continue;
      }
      deviations.push({
        genericItem,
        contextualItem,
        reason:
          contextualItems[index]?.reason ??
          "Swapped to better address this game's threat profile.",
      });
    }

    return deviations;
  }

  private generateBuildOrder(
    build: ContextualBuildRecommendation["build"],
    threats: ThreatAssessment[],
  ): ContextualBuildRecommendation["buildOrder"] {
    const order: ContextualBuildRecommendation["buildOrder"] = [];

    const rushItems = threats
      .flatMap((threat) =>
        threat.counterItems
          .filter((item) => item.buildSlot === "rush")
          .map((item) => ({ threat, item })),
      )
      .slice(0, 2);

    for (const entry of rushItems) {
      order.push({
        phase: "early",
        instruction: `Rush ${entry.item.item}${
          entry.item.itemId ? ` (${entry.item.itemId})` : ""
        } on first back - ${entry.item.reason}`,
      });
    }

    if (build.items[0]) {
      order.push({
        phase: "early",
        instruction: `Complete ${build.items[0].item} first as your baseline spike.`,
      });
    }
    if (build.items[1]) {
      order.push({
        phase: "mid",
        instruction: `Finish ${build.boots.item} and ${build.items[1].item} for your stable midgame setup.`,
      });
    }

    for (const item of build.items.filter((entry) => entry.isContextual)) {
      order.push({
        phase: item.slot <= 3 ? "mid" : "late",
        instruction: `${item.item}: ${item.reason}`,
      });
    }

    return order.slice(0, 8);
  }
}

export const contextualBuildEngine = new ContextualBuildEngine();
