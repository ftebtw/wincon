import Anthropic from "@anthropic-ai/sdk";

import {
  cdragonService,
  type CDragonAbility,
  type CDragonChampionFull,
  type CDragonItem,
} from "@/lib/cdragon";

export interface PBEChange {
  type:
    | "champion_stat"
    | "champion_ability"
    | "item_stat"
    | "item_new"
    | "item_removed"
    | "champion_new";
  target: string;
  field: string;
  liveValue: unknown;
  pbeValue: unknown;
  changeType: "buff" | "nerf" | "adjustment" | "new" | "removed";
  percentChange?: number;
  humanReadable: string;
}

export interface PBEDiffReport {
  detectedAt: string;
  liveVersion: string;
  pbeVersion: string;
  championChanges: PBEChange[];
  itemChanges: PBEChange[];
  newChampions: string[];
  removedItems: string[];
  totalChanges: number;
  aiAnalysis?: string;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number, precision = 3): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function approxEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}

function safePercentChange(liveValue: number, pbeValue: number): number | undefined {
  if (Math.abs(liveValue) < 0.00001) {
    return undefined;
  }
  return ((pbeValue - liveValue) / liveValue) * 100;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => formatValue(entry)).join(", ")}]`;
  }
  if (typeof value === "number") {
    return String(round(value, 3));
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function fieldDirection(field: string, type: PBEChange["type"]): "higher_buff" | "lower_buff" | "neutral" {
  const normalized = field.toLowerCase();
  if (type === "champion_ability") {
    if (normalized.includes("cooldown") || normalized.includes("cost")) {
      return "lower_buff";
    }
    if (normalized.includes("range")) {
      return "higher_buff";
    }
  }
  if (type === "item_stat") {
    if (normalized.includes("price")) {
      return "lower_buff";
    }
    if (normalized.includes("stat") || normalized.includes("recipe")) {
      return "neutral";
    }
  }
  if (type === "champion_stat") {
    if (normalized.includes("regen") || normalized.includes("damage") || normalized.includes("health") || normalized.includes("armor") || normalized.includes("resist") || normalized.includes("speed") || normalized.includes("range")) {
      return "higher_buff";
    }
  }
  return "neutral";
}

function classifyChangeType(
  type: PBEChange["type"],
  field: string,
  liveValue: unknown,
  pbeValue: unknown,
): PBEChange["changeType"] {
  if (type === "item_new" || type === "champion_new") {
    return "new";
  }
  if (type === "item_removed") {
    return "removed";
  }
  if (!isNumber(liveValue) || !isNumber(pbeValue)) {
    return "adjustment";
  }
  if (approxEqual(liveValue, pbeValue)) {
    return "adjustment";
  }

  const direction = fieldDirection(field, type);
  if (direction === "higher_buff") {
    return pbeValue > liveValue ? "buff" : "nerf";
  }
  if (direction === "lower_buff") {
    return pbeValue < liveValue ? "buff" : "nerf";
  }
  return "adjustment";
}

function changeText(changeType: PBEChange["changeType"]): string {
  if (changeType === "buff") return "Buff";
  if (changeType === "nerf") return "Nerf";
  if (changeType === "new") return "New";
  if (changeType === "removed") return "Removed";
  return "Adjusted";
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

export class PBEDiffEngine {
  async computeDiff(): Promise<PBEDiffReport> {
    const [liveVersion, pbeVersion, liveChampions, pbeChampions, liveItems, pbeItems] =
      await Promise.all([
        cdragonService.getContentVersion("latest"),
        cdragonService.getContentVersion("pbe"),
        cdragonService.getAllChampions("latest"),
        cdragonService.getAllChampions("pbe"),
        cdragonService.getItems("latest"),
        cdragonService.getItems("pbe"),
      ]);

    const championChanges: PBEChange[] = [];
    const itemChanges: PBEChange[] = [];
    const newChampions: string[] = [];
    const removedItems: string[] = [];

    for (const [championId, pbeChampion] of pbeChampions.entries()) {
      const liveChampion = liveChampions.get(championId);
      if (!liveChampion) {
        newChampions.push(pbeChampion.name);
        championChanges.push({
          type: "champion_new",
          target: pbeChampion.name,
          field: "champion",
          liveValue: null,
          pbeValue: pbeChampion.name,
          changeType: "new",
          humanReadable: `${pbeChampion.name} is newly present on PBE.`,
        });
        continue;
      }

      championChanges.push(
        ...this.diffStats(
          this.extractChampionStats(liveChampion),
          this.extractChampionStats(pbeChampion),
          pbeChampion.name,
        ),
      );
      championChanges.push(
        ...this.diffAbilities(liveChampion.spells, pbeChampion.spells, pbeChampion.name),
      );
    }

    const liveItemsById = new Map(liveItems.map((item) => [item.id, item]));
    const pbeItemsById = new Map(pbeItems.map((item) => [item.id, item]));

    for (const [itemId, pbeItem] of pbeItemsById.entries()) {
      const liveItem = liveItemsById.get(itemId);
      if (!liveItem) {
        itemChanges.push({
          type: "item_new",
          target: pbeItem.name,
          field: "item",
          liveValue: null,
          pbeValue: pbeItem.name,
          changeType: "new",
          humanReadable: `New item on PBE: ${pbeItem.name}.`,
        });
        continue;
      }

      itemChanges.push(...this.diffItem(liveItem, pbeItem));
    }

    for (const [itemId, liveItem] of liveItemsById.entries()) {
      if (!pbeItemsById.has(itemId)) {
        removedItems.push(liveItem.name);
        itemChanges.push({
          type: "item_removed",
          target: liveItem.name,
          field: "item",
          liveValue: liveItem.name,
          pbeValue: null,
          changeType: "removed",
          humanReadable: `Removed from PBE: ${liveItem.name}.`,
        });
      }
    }

    const totalChanges = championChanges.length + itemChanges.length;

    return {
      detectedAt: new Date().toISOString(),
      liveVersion,
      pbeVersion,
      championChanges,
      itemChanges,
      newChampions,
      removedItems,
      totalChanges,
    };
  }

  private extractChampionStats(champion: CDragonChampionFull): Record<string, number> {
    return {
      healthBase: champion.stats.healthBase,
      healthPerLevel: champion.stats.healthPerLevel,
      manaBase: champion.stats.manaBase,
      manaPerLevel: champion.stats.manaPerLevel,
      armorBase: champion.stats.armorBase,
      armorPerLevel: champion.stats.armorPerLevel,
      magicResistBase: champion.stats.magicResistBase,
      magicResistPerLevel: champion.stats.magicResistPerLevel,
      attackDamageBase: champion.stats.attackDamageBase,
      attackDamagePerLevel: champion.stats.attackDamagePerLevel,
      attackSpeedBase: champion.stats.attackSpeedBase,
      attackSpeedPerLevel: champion.stats.attackSpeedPerLevel,
      moveSpeed: champion.stats.moveSpeed,
      attackRange: champion.stats.attackRange,
      healthRegenBase: champion.stats.healthRegenBase,
      healthRegenPerLevel: champion.stats.healthRegenPerLevel,
      manaRegenBase: champion.stats.manaRegenBase,
      manaRegenPerLevel: champion.stats.manaRegenPerLevel,
    };
  }

  diffStats(
    live: Record<string, number>,
    pbe: Record<string, number>,
    targetName: string,
  ): PBEChange[] {
    const keys = new Set([...Object.keys(live), ...Object.keys(pbe)]);
    const changes: PBEChange[] = [];

    for (const key of keys) {
      const liveValue = toNumber(live[key], 0);
      const pbeValue = toNumber(pbe[key], 0);
      if (approxEqual(liveValue, pbeValue)) {
        continue;
      }

      const percentChange = safePercentChange(liveValue, pbeValue);
      const changeType = classifyChangeType("champion_stat", key, liveValue, pbeValue);
      const pctLabel =
        percentChange === undefined ? "" : ` (${percentChange >= 0 ? "+" : ""}${round(percentChange, 1)}%)`;

      changes.push({
        type: "champion_stat",
        target: targetName,
        field: key,
        liveValue,
        pbeValue,
        changeType,
        percentChange,
        humanReadable: `${targetName}: ${key} ${formatValue(liveValue)} -> ${formatValue(
          pbeValue,
        )}${pctLabel} [${changeText(changeType)}]`,
      });
    }

    return changes;
  }

  diffAbilities(
    liveAbilities: CDragonAbility[],
    pbeAbilities: CDragonAbility[],
    championName: string,
  ): PBEChange[] {
    const slotNames = ["Q", "W", "E", "R"];
    const changes: PBEChange[] = [];
    const maxLen = Math.max(liveAbilities.length, pbeAbilities.length);

    for (let index = 0; index < maxLen; index += 1) {
      const liveAbility = liveAbilities[index];
      const pbeAbility = pbeAbilities[index];
      const slot = slotNames[index] ?? `S${index + 1}`;

      if (!liveAbility && pbeAbility) {
        changes.push({
          type: "champion_ability",
          target: championName,
          field: `${slot}.ability`,
          liveValue: null,
          pbeValue: pbeAbility.name,
          changeType: "new",
          humanReadable: `${championName} ${slot} appears new on PBE: ${pbeAbility.name}.`,
        });
        continue;
      }

      if (!liveAbility || !pbeAbility) {
        continue;
      }

      const fields: Array<{
        key: string;
        liveValue: unknown;
        pbeValue: unknown;
      }> = [
        { key: "cooldowns", liveValue: liveAbility.cooldowns, pbeValue: pbeAbility.cooldowns },
        { key: "costs", liveValue: liveAbility.costs, pbeValue: pbeAbility.costs },
        { key: "range", liveValue: liveAbility.range, pbeValue: pbeAbility.range },
      ];

      for (const field of fields) {
        const liveSerialized = stableStringify(field.liveValue);
        const pbeSerialized = stableStringify(field.pbeValue);
        if (liveSerialized === pbeSerialized) {
          continue;
        }
        const changeType = classifyChangeType(
          "champion_ability",
          `${slot}.${field.key}`,
          Array.isArray(field.liveValue) ? field.liveValue[0] : field.liveValue,
          Array.isArray(field.pbeValue) ? field.pbeValue[0] : field.pbeValue,
        );

        changes.push({
          type: "champion_ability",
          target: championName,
          field: `${slot}.${field.key}`,
          liveValue: field.liveValue,
          pbeValue: field.pbeValue,
          changeType,
          humanReadable: `${championName} ${slot}: ${field.key} ${formatValue(
            field.liveValue,
          )} -> ${formatValue(field.pbeValue)} [${changeText(changeType)}]`,
        });
      }

      if (liveAbility.description.trim() !== pbeAbility.description.trim()) {
        changes.push({
          type: "champion_ability",
          target: championName,
          field: `${slot}.description`,
          liveValue: liveAbility.description,
          pbeValue: pbeAbility.description,
          changeType: "adjustment",
          humanReadable: `${championName} ${slot}: description text updated (possible rework wording).`,
        });
      }
    }

    return changes;
  }

  private diffItem(liveItem: CDragonItem, pbeItem: CDragonItem): PBEChange[] {
    const changes: PBEChange[] = [];
    const comparableFields: Array<{ key: string; liveValue: unknown; pbeValue: unknown }> = [
      { key: "price", liveValue: liveItem.price, pbeValue: pbeItem.price },
      { key: "priceTotal", liveValue: liveItem.priceTotal, pbeValue: pbeItem.priceTotal },
      { key: "from", liveValue: liveItem.from, pbeValue: pbeItem.from },
      { key: "to", liveValue: liveItem.to, pbeValue: pbeItem.to },
      { key: "stats", liveValue: liveItem.stats, pbeValue: pbeItem.stats },
    ];

    for (const field of comparableFields) {
      if (stableStringify(field.liveValue) === stableStringify(field.pbeValue)) {
        continue;
      }

      const changeType = classifyChangeType(
        "item_stat",
        field.key,
        field.liveValue,
        field.pbeValue,
      );
      const percentChange =
        isNumber(field.liveValue) && isNumber(field.pbeValue)
          ? safePercentChange(field.liveValue, field.pbeValue)
          : undefined;
      const pctLabel =
        percentChange === undefined ? "" : ` (${percentChange >= 0 ? "+" : ""}${round(percentChange, 1)}%)`;

      changes.push({
        type: "item_stat",
        target: pbeItem.name,
        field: field.key,
        liveValue: field.liveValue,
        pbeValue: field.pbeValue,
        changeType,
        percentChange,
        humanReadable: `${pbeItem.name}: ${field.key} ${formatValue(field.liveValue)} -> ${formatValue(
          field.pbeValue,
        )}${pctLabel} [${changeText(changeType)}]`,
      });
    }

    return changes;
  }

  async generateImpactAnalysis(diff: PBEDiffReport): Promise<string> {
    if (!process.env.ANTHROPIC_API_KEY) {
      return "AI impact analysis unavailable (ANTHROPIC_API_KEY not configured).";
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const championSample = diff.championChanges.slice(0, 80).map((change) => change.humanReadable);
    const itemSample = diff.itemChanges.slice(0, 80).map((change) => change.humanReadable);

    const prompt = `Analyze these upcoming League of Legends PBE changes and predict meta impact.

Live version: ${diff.liveVersion}
PBE version: ${diff.pbeVersion}
Total changes: ${diff.totalChanges}

Champion changes:
${championSample.join("\n")}

Item changes:
${itemSample.join("\n")}

Write 3-4 concise paragraphs:
1) Biggest winners
2) Biggest losers
3) Expected build/rune/meta adjustments players should prepare for
4) Practical advice for ranked players.
`;

    try {
      const response = await client.messages.create({
        model: process.env.ANTHROPIC_SONNET_MODEL ?? "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .map((entry) => (entry.type === "text" ? entry.text : ""))
        .join("\n")
        .trim();
      return text || "No AI impact analysis generated.";
    } catch (error) {
      console.error("[PBEDiffEngine] Failed to generate AI impact analysis:", error);
      return "AI impact analysis is temporarily unavailable.";
    }
  }
}

export const pbeDiffEngine = new PBEDiffEngine();
